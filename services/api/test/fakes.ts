import type {
  ForecastPoint,
  ForecastRequest,
  MlClient,
  ModelVersion,
  NewPrediction,
  Prediction,
  Reading,
  Repository,
  Sensor,
} from "../src/types.js";

export class FakeRepository implements Repository {
  sensors: Sensor[] = [];
  readings: Reading[] = [];
  predictions: Prediction[] = [];
  models: (ModelVersion & { active: boolean })[] = [{ id: 1, name: "baseline", version: "v1", active: true }];

  async ping() {}

  async listSensors() {
    return this.sensors;
  }

  async getSensor(id: string) {
    return this.sensors.find((s) => s.id === id) ?? null;
  }

  async getReadings(sensorId: string, from: Date, to: Date, limit: number) {
    return this.readings
      .filter((r) => r.sensorId === sensorId && new Date(r.observedAt) >= from && new Date(r.observedAt) < to)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
      .slice(-limit);
  }

  async getPredictions(sensorId: string, from: Date, to: Date, horizon?: number) {
    return this.predictions.filter(
      (p) =>
        p.sensorId === sensorId &&
        new Date(p.targetTime) >= from &&
        new Date(p.targetTime) < to &&
        (horizon === undefined || p.horizonMinutes === horizon),
    );
  }

  async getActiveModelVersion(name: string) {
    const m = this.models.find((m) => m.name === name && m.active);
    return m ? { id: m.id, name: m.name, version: m.version } : null;
  }

  async savePredictions(rows: NewPrediction[]) {
    const madeAt = new Date().toISOString();
    this.predictions.push(...rows.map((r) => ({ ...r, madeAt })));
    return rows.length;
  }
}

export class FakeMlClient implements MlClient {
  calls: ForecastRequest[] = [];
  healthy = true;

  async health() {
    if (!this.healthy) throw new Error("down");
  }

  async forecast(req: ForecastRequest) {
    this.calls.push(req);
    const last = req.history[req.history.length - 1];
    const points: ForecastPoint[] = req.horizonsMinutes.map((h) => ({
      targetTime: new Date(new Date(last.observedAt).getTime() + h * 60_000).toISOString(),
      horizonMinutes: h,
      predictedFlow: last.flowVph,
    }));
    return { modelVersion: "v1", points };
  }
}

export const sampleSensor: Sensor = {
  id: "s-1",
  name: "I-405 NB @ Wilshire",
  road: "I-405",
  direction: "N",
  latitude: 34.06,
  longitude: -118.45,
  lanes: 5,
  source: "synthetic",
};
