import { createApp } from "./app.js";
import { RedisCache } from "./cache.js";
import { loadConfig } from "./config.js";
import { PgRepository } from "./db.js";
import { HttpMlClient } from "./mlClient.js";

const config = loadConfig();
const repo = PgRepository.fromUrl(config.DATABASE_URL);
const cache = new RedisCache(config.REDIS_URL);
const ml = new HttpMlClient(config.ML_SERVICE_URL);

const app = createApp({ repo, cache, ml, cacheTtlSeconds: config.PREDICTION_CACHE_TTL_SECONDS });
const server = app.listen(config.PORT, () => {
  console.log(`FlowCast API listening on :${config.PORT}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close();
  await Promise.allSettled([repo.close(), cache.close()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
