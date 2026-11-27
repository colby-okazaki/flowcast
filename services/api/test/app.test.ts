import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryCache } from "../src/cache.js";
import { FakeMlClient, FakeRepository, sampleSensor } from "./fakes.js";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("FlowCast API", () => {
  let repo: FakeRepository;
  let ml: FakeMlClient;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    repo = new FakeRepository();
    ml = new FakeMlClient();
    repo.sensors.push(sampleSensor);
    app = createApp({ repo, cache: new MemoryCache(), ml });
  });

  it("reports health of every dependency", async () => {
    const ok = await request(app).get("/health");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: "ok", db: "ok", redis: "ok", ml: "ok" });

    ml.healthy = false;
    const degraded = await request(app).get("/health");
    expect(degraded.status).toBe(503);
    expect(degraded.body.ml).toBe("down");
  });

  it("lists sensors and 404s on unknown ids", async () => {
    const list = await request(app).get("/api/sensors");
    expect(list.body.data).toHaveLength(1);

    const missing = await request(app).get("/api/sensors/nope");
    expect(missing.status).toBe(404);
  });

  it("validates query parameters", async () => {
    const res = await request(app).get("/api/sensors/s-1/readings?hours=-5");
    expect(res.status).toBe(400);
  });

  it("returns readings inside the requested window, oldest first", async () => {
    repo.readings.push(
      { sensorId: "s-1", observedAt: minutesAgo(10), flowVph: 1200, speedMph: 55, occupancy: 0.1 },
      { sensorId: "s-1", observedAt: minutesAgo(5), flowVph: 1300, speedMph: 52, occupancy: 0.12 },
      { sensorId: "s-1", observedAt: minutesAgo(60 * 48), flowVph: 900, speedMph: 60, occupancy: 0.05 },
    );
    const res = await request(app).get("/api/sensors/s-1/readings?hours=1");
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { flowVph: number }) => r.flowVph)).toEqual([1200, 1300]);
  });

  it("forecasts, persists predictions, and serves them from cache", async () => {
    repo.readings.push({ sensorId: "s-1", observedAt: minutesAgo(5), flowVph: 1500, speedMph: 50, occupancy: 0.2 });

    const forecast = await request(app).post("/api/sensors/s-1/forecast").send({ horizonsMinutes: [15, 30] });
    expect(forecast.status).toBe(201);
    expect(forecast.body.data.saved).toBe(2);
    expect(ml.calls[0].history).toHaveLength(1);
    expect(repo.predictions).toHaveLength(2);

    const first = await request(app).get("/api/sensors/s-1/predictions");
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(first.body.data).toHaveLength(2);

    const second = await request(app).get("/api/sensors/s-1/predictions");
    expect(second.headers["x-cache"]).toBe("HIT");

    // A new forecast must invalidate the cached predictions.
    await request(app).post("/api/sensors/s-1/forecast").send({ horizonsMinutes: [15] });
    const third = await request(app).get("/api/sensors/s-1/predictions");
    expect(third.headers["x-cache"]).toBe("MISS");
  });

  it("refuses to forecast without history or with an unknown model", async () => {
    const noHistory = await request(app).post("/api/sensors/s-1/forecast").send({});
    expect(noHistory.status).toBe(422);

    repo.readings.push({ sensorId: "s-1", observedAt: minutesAgo(5), flowVph: 1500, speedMph: 50, occupancy: 0.2 });
    const badModel = await request(app).post("/api/sensors/s-1/forecast").send({ model: "nope" });
    expect(badModel.status).toBe(400);
  });

  it("anchors every window at the newest reading, so months-old feeds still work", async () => {
    const latest = new Date(Date.now() - 150 * 24 * 60 * 60_000); // ~5 months ago, like WebTRIS
    for (let i = 0; i < 8; i++) {
      repo.readings.push({
        sensorId: "s-1",
        observedAt: new Date(latest.getTime() - i * 15 * 60_000).toISOString(),
        flowVph: 4000 + i,
        speedMph: 60,
        occupancy: null,
      });
    }

    const sensors = await request(app).get("/api/sensors");
    expect(sensors.body.data[0].latestReadingAt).toBe(latest.toISOString());

    const readings = await request(app).get("/api/sensors/s-1/readings?hours=1");
    expect(readings.body.asOf).toBe(latest.toISOString());
    expect(readings.body.data).toHaveLength(5); // the newest reading plus four 15-minute steps back

    const forecast = await request(app).post("/api/sensors/s-1/forecast").send({ horizonsMinutes: [15] });
    expect(forecast.status).toBe(201);
    expect(forecast.body.data.points[0].targetTime).toBe(new Date(latest.getTime() + 15 * 60_000).toISOString());

    const comparison = await request(app).get("/api/sensors/s-1/comparison?hours=2&horizon=15");
    expect(comparison.body.data.points.at(-1)).toMatchObject({ actual: null, predicted: 4000 });
  });

  it("backfills historical forecasts that can be scored against actuals", async () => {
    const latest = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    for (let i = 0; i < 4 * 24; i++) {
      repo.readings.push({
        sensorId: "s-1",
        observedAt: new Date(latest.getTime() - i * 15 * 60_000).toISOString(),
        flowVph: 1000,
        speedMph: 60,
        occupancy: null,
      });
    }

    const res = await request(app)
      .post("/api/sensors/s-1/backfill")
      .send({ hours: 6, horizonsMinutes: [15], stepMinutes: 15 });
    expect(res.status).toBe(201);
    expect(res.body.data.cutoffs).toBe(25); // 6 hours of 15-minute steps, both ends included
    expect(ml.backfillCalls[0].history.length).toBeGreaterThan(0);

    const comparison = await request(app).get("/api/sensors/s-1/comparison?hours=6&horizon=15");
    const { metrics } = comparison.body.data;
    expect(metrics.n).toBeGreaterThan(20);
    expect(metrics.mae).toBe(0); // constant flow, so a last-value forecast is exact
  });

  it("rejects backfills that are too long", async () => {
    repo.readings.push({ sensorId: "s-1", observedAt: minutesAgo(5), flowVph: 1, speedMph: 1, occupancy: null });
    const res = await request(app).post("/api/sensors/s-1/backfill").send({ hours: 24 * 60 });
    expect(res.status).toBe(400);
  });
});
