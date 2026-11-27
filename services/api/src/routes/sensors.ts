import { Router } from "express";
import { z } from "zod";
import { computeErrorMetrics, mergeActualVsPredicted } from "../comparison.js";
import { HttpError } from "../errors.js";
import type { Cache, ForecastResult, MlClient, Repository, Sensor } from "../types.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const HISTORY_DAYS = 28; // four weeks of weekday/time-of-day seasonality
const MAX_ROWS_PER_DAY = 24 * 12; // 5-minute intervals, the finest any source provides

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

const horizons = z.array(z.number().int().positive().max(24 * 60)).min(1).max(12).default([15, 30, 60]);

const forecastBody = z.object({
  model: z.string().default("baseline"),
  horizonsMinutes: horizons,
});

const backfillBody = z.object({
  model: z.string().default("baseline"),
  horizonsMinutes: horizons,
  hours: z.number().int().min(1).max(24 * 14).default(24 * 7),
  stepMinutes: z.number().int().min(5).max(24 * 60).default(15),
});

export interface SensorRouterDeps {
  repo: Repository;
  cache: Cache;
  ml: MlClient;
  cacheTtlSeconds: number;
}

/**
 * All time windows end at the sensor's newest reading ("as of"), not the wall clock,
 * because public traffic feeds are often published weeks or months late.
 */
function asOf(sensor: Sensor): Date | null {
  return sensor.latestReadingAt ? new Date(sensor.latestReadingAt) : null;
}

/** Exclusive upper bound that still includes the newest reading. */
function justAfter(d: Date): Date {
  return new Date(d.getTime() + 1);
}

export function sensorRouter({ repo, cache, ml, cacheTtlSeconds }: SensorRouterDeps): Router {
  const router = Router();

  async function requireSensor(id: string) {
    const sensor = await repo.getSensor(id);
    if (!sensor) throw new HttpError(404, `Sensor ${id} not found`);
    return sensor;
  }

  function requireData(sensor: Sensor): Date {
    const latest = asOf(sensor);
    if (!latest) throw new HttpError(422, `Sensor ${sensor.id} has no readings yet`);
    return latest;
  }

  async function savePoints(sensor: Sensor, modelVersionId: number, result: ForecastResult) {
    const saved = await repo.savePredictions(
      result.points.map((p) => ({
        sensorId: sensor.id,
        modelVersionId,
        targetTime: p.targetTime,
        horizonMinutes: p.horizonMinutes,
        predictedFlow: p.predictedFlow,
      })),
    );
    await cache.delByPrefix(`predictions:${sensor.id}:`);
    return saved;
  }

  async function activeModel(name: string) {
    const version = await repo.getActiveModelVersion(name);
    if (!version) throw new HttpError(400, `No active version of model "${name}"`);
    return version;
  }

  router.get("/", async (_req, res) => {
    res.json({ data: await repo.listSensors() });
  });

  router.get("/:id", async (req, res) => {
    res.json({ data: await requireSensor(req.params.id) });
  });

  router.get("/:id/readings", async (req, res) => {
    const { hours, limit } = readingsQuery.parse(req.query);
    const sensor = await requireSensor(req.params.id);
    const latest = asOf(sensor);
    if (!latest) {
      res.json({ data: [], asOf: null });
      return;
    }
    const from = new Date(latest.getTime() - hours * HOUR_MS);
    res.json({ data: await repo.getReadings(sensor.id, from, justAfter(latest), limit), asOf: sensor.latestReadingAt });
  });

  router.get("/:id/predictions", async (req, res) => {
    const { hours, horizon } = predictionsQuery.parse(req.query);
    const sensor = await requireSensor(req.params.id);
    const latest = asOf(sensor);

    const key = `predictions:${sensor.id}:${sensor.latestReadingAt}:${horizon ?? "all"}:${hours}`;
    const cached = await cache.get(key);
    if (cached) {
      res.set("x-cache", "HIT").type("application/json").send(cached);
      return;
    }

    const data = latest
      ? await repo.getPredictions(sensor.id, justAfter(latest), new Date(latest.getTime() + hours * HOUR_MS), horizon)
      : [];
    const body = JSON.stringify({ data, asOf: sensor.latestReadingAt });
    await cache.set(key, body, cacheTtlSeconds);
    res.set("x-cache", "MISS").type("application/json").send(body);
  });

  router.get("/:id/comparison", async (req, res) => {
    const { hours, horizon } = comparisonQuery.parse(req.query);
    const sensor = await requireSensor(req.params.id);
    const latest = asOf(sensor);
    if (!latest) {
      res.json({ data: { horizonMinutes: horizon, metrics: computeErrorMetrics([]), points: [] }, asOf: null });
      return;
    }
    const from = new Date(latest.getTime() - hours * HOUR_MS);
    // Extend predictions past the newest reading so the latest forecast shows up ahead of the actuals.
    const predictionsTo = new Date(latest.getTime() + horizon * MINUTE_MS + 1);
    const [readings, predictions] = await Promise.all([
      repo.getReadings(sensor.id, from, justAfter(latest), 50_000),
      repo.getPredictions(sensor.id, from, predictionsTo, horizon),
    ]);
    const points = mergeActualVsPredicted(readings, predictions);
    res.json({
      data: { horizonMinutes: horizon, metrics: computeErrorMetrics(points), points },
      asOf: sensor.latestReadingAt,
    });
  });

  // Forecast forward from the newest reading: history -> ML service -> persist -> invalidate cache.
  router.post("/:id/forecast", async (req, res) => {
    const { model, horizonsMinutes } = forecastBody.parse(req.body ?? {});
    const sensor = await requireSensor(req.params.id);
    const latest = requireData(sensor);
    const modelVersion = await activeModel(model);

    const from = new Date(latest.getTime() - HISTORY_DAYS * DAY_MS);
    const history = await repo.getReadings(sensor.id, from, justAfter(latest), HISTORY_DAYS * MAX_ROWS_PER_DAY);
    const result = await ml.forecast({
      sensorId: sensor.id,
      model,
      horizonsMinutes,
      history: history.map((h) => ({ observedAt: h.observedAt, flowVph: h.flowVph })),
    });
    const saved = await savePoints(sensor, modelVersion.id, result);

    res.status(201).json({
      data: { sensorId: sensor.id, model, modelVersion: modelVersion.version, asOf: sensor.latestReadingAt, saved, points: result.points },
    });
  });

  // Replay the model over the last `hours` of data, forecasting at every step as if it were live,
  // so actual-vs-predicted charts and error metrics can be computed without waiting for new data.
  router.post("/:id/backfill", async (req, res) => {
    const { model, horizonsMinutes, hours, stepMinutes } = backfillBody.parse(req.body ?? {});
    const sensor = await requireSensor(req.params.id);
    const latest = requireData(sensor);
    const modelVersion = await activeModel(model);

    const windowStart = latest.getTime() - hours * HOUR_MS;
    const historyDays = HISTORY_DAYS + Math.ceil(hours / 24);
    const history = await repo.getReadings(
      sensor.id,
      new Date(windowStart - HISTORY_DAYS * DAY_MS),
      justAfter(latest),
      historyDays * MAX_ROWS_PER_DAY,
    );
    const cutoffs: string[] = [];
    for (let t = windowStart; t <= latest.getTime(); t += stepMinutes * MINUTE_MS) {
      cutoffs.push(new Date(t).toISOString());
    }

    const result = await ml.backfill({
      sensorId: sensor.id,
      model,
      horizonsMinutes,
      cutoffs,
      history: history.map((h) => ({ observedAt: h.observedAt, flowVph: h.flowVph })),
    });
    const saved = await savePoints(sensor, modelVersion.id, result);

    res.status(201).json({
      data: { sensorId: sensor.id, model, modelVersion: modelVersion.version, asOf: sensor.latestReadingAt, cutoffs: cutoffs.length, saved },
    });
  });

  return router;
}
