import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().default("postgres://flowcast:flowcast@localhost:5432/flowcast"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ML_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  PREDICTION_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
