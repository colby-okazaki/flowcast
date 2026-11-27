/**
 * Runs PgRepository against a real PostgreSQL. Skipped unless TEST_DATABASE_URL is set (CI sets it).
 * WARNING: drops and recreates the `public` schema of the target database.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PgRepository } from "../src/db.js";

const url = process.env.TEST_DATABASE_URL;
const migrationsDir = join(import.meta.dirname, "../../../db/migrations");
const T0 = new Date("2026-06-01T07:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe.skipIf(!url)("PgRepository (integration)", () => {
  const pool = new pg.Pool({ connectionString: url });
  const repo = new PgRepository(pool);

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(join(migrationsDir, file), "utf8"));
    }
    await pool.query(
      `INSERT INTO sensors (id, name, road, direction, latitude, longitude, source)
       VALUES ('w-1', 'M4 Westbound', 'M4', 'W', 51.49, -0.45, 'webtris'),
              ('w-2', 'M4 Eastbound', 'M4', 'E', 51.49, -0.45, 'webtris')`,
    );
    for (let i = 0; i < 8; i++) {
      await pool.query(`INSERT INTO readings (sensor_id, observed_at, flow_vph) VALUES ('w-1', $1, $2)`, [
        at(15 * i),
        1000 + i,
      ]);
    }
  });

  afterAll(() => pool.end());

  it("reports each sensor's newest reading", async () => {
    const sensors = await repo.listSensors();
    const byId = Object.fromEntries(sensors.map((s) => [s.id, s.latestReadingAt]));
    expect(byId).toEqual({ "w-1": at(105).toISOString(), "w-2": null });
    expect((await repo.getSensor("w-1"))?.latestReadingAt).toBe(at(105).toISOString());
    expect(await repo.getSensor("missing")).toBeNull();
  });

  it("returns the newest rows in a window, oldest first, honoring the limit", async () => {
    const rows = await repo.getReadings("w-1", at(0), at(1000), 3);
    expect(rows.map((r) => r.flowVph)).toEqual([1005, 1006, 1007]);
    expect(rows[0].observedAt).toBe(at(75).toISOString());
  });

  it("upserts predictions and returns the newest per target and horizon", async () => {
    const model = await repo.getActiveModelVersion("baseline");
    expect(model?.version).toBe("v1");

    const row = { sensorId: "w-1", modelVersionId: model!.id, targetTime: at(120).toISOString(), horizonMinutes: 15 };
    expect(await repo.savePredictions([{ ...row, predictedFlow: 900 }])).toBe(1);
    expect(await repo.savePredictions([{ ...row, predictedFlow: 950 }])).toBe(1); // same key -> update

    const preds = await repo.getPredictions("w-1", at(0), at(200), 15);
    expect(preds).toHaveLength(1);
    expect(preds[0].predictedFlow).toBe(950);
    expect(await repo.getPredictions("w-1", at(0), at(200), 30)).toEqual([]);
  });

  it("handles large prediction batches in one round trip", async () => {
    const model = await repo.getActiveModelVersion("baseline");
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      sensorId: "w-1",
      modelVersionId: model!.id,
      targetTime: at(15 * i).toISOString(),
      horizonMinutes: 15,
      predictedFlow: i,
    }));
    expect(await repo.savePredictions(rows)).toBe(2000);
  });
});
