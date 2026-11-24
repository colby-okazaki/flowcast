export interface Sensor {
  id: string;
  name: string;
  road: string | null;
  direction: "N" | "S" | "E" | "W" | null;
  latitude: number;
  longitude: number;
  lanes: number | null;
  source: string;
}

export interface Reading {
  sensorId: string;
  observedAt: string; // ISO 8601
  flowVph: number;
  speedMph: number | null;
  occupancy: number | null;
}

export interface Prediction {
  sensorId: string;
  modelVersionId: number;
  madeAt: string;
  targetTime: string;
  horizonMinutes: number;
  predictedFlow: number;
}

export interface ModelVersion {
  id: number;
  name: string;
  version: string;
}

export type NewPrediction = Omit<Prediction, "madeAt">;

/** Everything the HTTP layer needs from storage. Postgres in prod, an in-memory fake in tests. */
export interface Repository {
  ping(): Promise<void>;
  listSensors(): Promise<Sensor[]>;
  getSensor(id: string): Promise<Sensor | null>;
  getReadings(sensorId: string, from: Date, to: Date, limit: number): Promise<Reading[]>;
  getPredictions(sensorId: string, from: Date, to: Date, horizonMinutes?: number): Promise<Prediction[]>;
  getActiveModelVersion(name: string): Promise<ModelVersion | null>;
  savePredictions(rows: NewPrediction[]): Promise<number>;
}

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delByPrefix(prefix: string): Promise<void>;
  ping(): Promise<void>;
}

export interface ForecastRequest {
  sensorId: string;
  model: string;
  horizonsMinutes: number[];
  history: { observedAt: string; flowVph: number }[];
}

export interface ForecastPoint {
  targetTime: string;
  horizonMinutes: number;
  predictedFlow: number;
}

export interface MlClient {
  health(): Promise<void>;
  forecast(req: ForecastRequest): Promise<{ modelVersion: string; points: ForecastPoint[] }>;
}
