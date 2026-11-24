import { Router } from "express";
import { z } from "zod";
import { computeErrorMetrics, mergeActualVsPredicted } from "../comparison.js";
import { HttpError } from "../errors.js";
import type { Cache, MlClient, Repository } from "../types.js";

const HOUR_MS = 60 * 60 * 1000;
const HISTORY_DAYS = 28; // enough for four weeks of weekday/time-of-day seasonality
const MAX_HISTORY_ROWS = HISTORY_DAYS * 24 * 12; // 5-minute intervals

const readingsQuery = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 90).default(24),
  limit: z.coerce.number().int().min(1).max(50_000).default(5_000),
});

const predictionsQuery = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 7).default(24),
  horizon: z.coerce.number().int().positive().optional(),
});

const comparisonQuery = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
  horizon: z.coerce.number().int().positive().default(15),
});

const forecastBody = z.object({
  model: z.string().default("baseline"),
  horizonsMinutes: z.array(z.number().int().positive().max(24 * 60)).min(1).max(12).default([15, 30, 60]),
});

export interface SensorRouterDeps {
  repo: Repository;
  cache: Cache;
  ml: MlClient;
  cacheTtlSeconds: number;
}

export function sensorRouter({ repo, cache, ml, cacheTtlSeconds }: SensorRouterDeps): Router {
  const router = Router();

  async function requireSensor(id: string) {
    const sensor = await repo.getSensor(id);
    if (!sensor) throw new HttpError(404, `Sensor ${id} not found`);
    return sensor;
  }

  router.get("/", async (_req, res) => {
    res.json({ data: await repo.listSensors() });
  });

  router.get("/:id", async (req, res) => {
    res.json({ data: await requireSensor(req.params.id) });
  });

  router.get("/:id/readings", async (req, res) => {
    const { hours, limit } = readingsQuery.parse(req.query);
    await requireSensor(req.params.id);
    const to = new Date();
    const from = new Date(to.getTime() - hours * HOUR_MS);
    res.json({ data: await repo.getReadings(req.params.id, from, to, limit) });
  });

  router.get("/:id/predictions", async (req, res) => {
    const { hours, horizon } = predictionsQuery.parse(req.query);
    await requireSensor(req.params.id);

    const key = `predictions:${req.params.id}:${horizon ?? "all"}:${hours}`;
    const cached = await cache.get(key);
    if (cached) {
      res.set("x-cache", "HIT").type("application/json").send(cached);
      return;
    }

    const from = new Date();
    const to = new Date(from.getTime() + hours * HOUR_MS);
    const body = JSON.stringify({ data: await repo.getPredictions(req.params.id, from, to, horizon) });
    await cache.set(key, body, cacheTtlSeconds);
    res.set("x-cache", "MISS").type("application/json").send(body);
  });

  router.get("/:id/comparison", async (req, res) => {
    const { hours, horizon } = comparisonQuery.parse(req.query);
    await requireSensor(req.params.id);
    const now = new Date();
    const from = new Date(now.getTime() - hours * HOUR_MS);
    // Extend the prediction window past "now" so the newest forecasts show up ahead of the actuals.
    const predictionsTo = new Date(now.getTime() + horizon * 60_000 + 1);
    const [readings, predictions] = await Promise.all([
      repo.getReadings(req.params.id, from, now, 50_000),
      repo.getPredictions(req.params.id, from, predictionsTo, horizon),
    ]);
    const points = mergeActualVsPredicted(readings, predictions);
    res.json({ data: { horizonMinutes: horizon, metrics: computeErrorMetrics(points), points } });
  });

  // Generate a fresh forecast: pull history -> call ML service -> persist -> invalidate cache.
  router.post("/:id/forecast", async (req, res) => {
    const { model, horizonsMinutes } = forecastBody.parse(req.body ?? {});
    const sensor = await requireSensor(req.params.id);

    const modelVersion = await repo.getActiveModelVersion(model);
    if (!modelVersion) throw new HttpError(400, `No active version of model "${model}"`);

    const to = new Date();
    const from = new Date(to.getTime() - HISTORY_DAYS * 24 * HOUR_MS);
    const history = await repo.getReadings(sensor.id, from, to, MAX_HISTORY_ROWS);
    if (history.length === 0) throw new HttpError(422, `Sensor ${sensor.id} has no recent readings to forecast from`);

    const result = await ml.forecast({
      sensorId: sensor.id,
      model,
      horizonsMinutes,
      history: history.map((h) => ({ observedAt: h.observedAt, flowVph: h.flowVph })),
    });

    const saved = await repo.savePredictions(
      result.points.map((p) => ({
        sensorId: sensor.id,
        modelVersionId: modelVersion.id,
        targetTime: p.targetTime,
        horizonMinutes: p.horizonMinutes,
        predictedFlow: p.predictedFlow,
      })),
    );
    await cache.delByPrefix(`predictions:${sensor.id}:`);

    res.status(201).json({
      data: { sensorId: sensor.id, model, modelVersion: modelVersion.version, saved, points: result.points },
    });
  });

  return router;
}
