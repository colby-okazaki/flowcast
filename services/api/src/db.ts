import pg from "pg";
import type { ModelVersion, NewPrediction, Prediction, Reading, Repository, Sensor } from "./types.js";

export class PgRepository implements Repository {
  constructor(private readonly pool: pg.Pool) {}

  static fromUrl(url: string): PgRepository {
    return new PgRepository(new pg.Pool({ connectionString: url, max: 10 }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async listSensors(): Promise<Sensor[]> {
    const { rows } = await this.pool.query(
      `SELECT id, name, road, direction, latitude, longitude, lanes, source
         FROM sensors ORDER BY id`,
    );
    return rows;
  }

  async getSensor(id: string): Promise<Sensor | null> {
    const { rows } = await this.pool.query(
      `SELECT id, name, road, direction, latitude, longitude, lanes, source
         FROM sensors WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async getReadings(sensorId: string, from: Date, to: Date, limit: number): Promise<Reading[]> {
    // Take the most recent `limit` rows in the window, then return them oldest-first.
    const { rows } = await this.pool.query(
      `SELECT * FROM (
         SELECT sensor_id   AS "sensorId",
                observed_at AS "observedAt",
                flow_vph    AS "flowVph",
                speed_mph   AS "speedMph",
                occupancy
           FROM readings
          WHERE sensor_id = $1 AND observed_at >= $2 AND observed_at < $3
          ORDER BY observed_at DESC
          LIMIT $4
       ) recent ORDER BY "observedAt"`,
      [sensorId, from, to, limit],
    );
    return rows.map((r) => ({ ...r, observedAt: new Date(r.observedAt).toISOString() }));
  }

  async getPredictions(sensorId: string, from: Date, to: Date, horizonMinutes?: number): Promise<Prediction[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (target_time, horizon_minutes)
              sensor_id        AS "sensorId",
              model_version_id AS "modelVersionId",
              made_at          AS "madeAt",
              target_time      AS "targetTime",
              horizon_minutes  AS "horizonMinutes",
              predicted_flow   AS "predictedFlow"
         FROM predictions
        WHERE sensor_id = $1 AND target_time >= $2 AND target_time < $3
          AND ($4::int IS NULL OR horizon_minutes = $4)
        ORDER BY target_time, horizon_minutes, made_at DESC`,
      [sensorId, from, to, horizonMinutes ?? null],
    );
    return rows.map((r) => ({
      ...r,
      madeAt: new Date(r.madeAt).toISOString(),
      targetTime: new Date(r.targetTime).toISOString(),
    }));
  }

  async getActiveModelVersion(name: string): Promise<ModelVersion | null> {
    const { rows } = await this.pool.query(
      `SELECT id, name, version FROM model_versions WHERE name = $1 AND is_active`,
      [name],
    );
    return rows[0] ?? null;
  }

  async savePredictions(rows: NewPrediction[]): Promise<number> {
    if (rows.length === 0) return 0;
    // Bulk upsert via UNNEST so one round trip handles any batch size.
    const result = await this.pool.query(
      `INSERT INTO predictions (sensor_id, model_version_id, target_time, horizon_minutes, predicted_flow)
       SELECT * FROM UNNEST($1::text[], $2::int[], $3::timestamptz[], $4::int[], $5::real[])
       ON CONFLICT (sensor_id, model_version_id, target_time, horizon_minutes)
       DO UPDATE SET predicted_flow = EXCLUDED.predicted_flow, made_at = now()`,
      [
        rows.map((r) => r.sensorId),
        rows.map((r) => r.modelVersionId),
        rows.map((r) => r.targetTime),
        rows.map((r) => r.horizonMinutes),
        rows.map((r) => r.predictedFlow),
      ],
    );
    return result.rowCount ?? 0;
  }
}
