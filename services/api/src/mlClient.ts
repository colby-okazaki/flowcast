import type { ForecastRequest, ForecastResult, MlClient } from "./types.js";

export class MlServiceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

interface WirePoint {
  target_time: string;
  horizon_minutes: number;
  predicted_flow: number;
}

/** HTTP client for the FastAPI prediction service. Translates between camelCase and snake_case. */
export class HttpMlClient implements MlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5000,
    private readonly backfillTimeoutMs = 60_000,
  ) {}

  async health(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new MlServiceError(`ML service unhealthy`, res.status);
  }

  forecast(req: ForecastRequest): Promise<ForecastResult> {
    return this.post("/predict", this.toWire(req), this.timeoutMs);
  }

  backfill(req: ForecastRequest & { cutoffs: string[] }): Promise<ForecastResult> {
    return this.post("/predict/backfill", { ...this.toWire(req), cutoffs: req.cutoffs }, this.backfillTimeoutMs);
  }

  private toWire(req: ForecastRequest) {
    return {
      sensor_id: req.sensorId,
      model: req.model,
      horizons_minutes: req.horizonsMinutes,
      history: req.history.map((h) => ({ observed_at: h.observedAt, flow_vph: h.flowVph })),
    };
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<ForecastResult> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new MlServiceError(`ML service returned ${res.status}: ${await res.text()}`, res.status);
    }
    const json = (await res.json()) as { model_version: string; points: WirePoint[] };
    return {
      modelVersion: json.model_version,
      points: json.points.map((p) => ({
        targetTime: p.target_time,
        horizonMinutes: p.horizon_minutes,
        predictedFlow: p.predicted_flow,
      })),
    };
  }
}
