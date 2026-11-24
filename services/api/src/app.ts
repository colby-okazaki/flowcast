import express from "express";
import { errorHandler, HttpError } from "./errors.js";
import { sensorRouter } from "./routes/sensors.js";
import type { Cache, MlClient, Repository } from "./types.js";

export interface AppDeps {
  repo: Repository;
  cache: Cache;
  ml: MlClient;
  cacheTtlSeconds?: number;
}

export function createApp({ repo, cache, ml, cacheTtlSeconds = 300 }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Reports each dependency separately so a dashboard can show partial outages.
  app.get("/health", async (_req, res) => {
    const check = async (fn: () => Promise<void>) =>
      fn().then(
        () => "ok" as const,
        () => "down" as const,
      );
    const [db, redis, mlService] = await Promise.all([
      check(() => repo.ping()),
      check(() => cache.ping()),
      check(() => ml.health()),
    ]);
    const healthy = db === "ok" && redis === "ok" && mlService === "ok";
    res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", db, redis, ml: mlService });
  });

  app.use("/api/sensors", sensorRouter({ repo, cache, ml, cacheTtlSeconds }));

  app.use((_req, _res, next) => next(new HttpError(404, "Not found")));
  app.use(errorHandler);
  return app;
}
