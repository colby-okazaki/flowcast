import type { ForecastPoint, ForecastRequest, MlClient } from "./types.js";

export class MlServiceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** HTTP client for the FastAPI prediction service. Translates between camelCase and snake_case. */
export class HttpMlClient implements MlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5000,
  ) {}

  async health(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new MlServiceError(`ML service unhealthy`, res.status);
  }

  async forecast(req: ForecastRequest): Promise<{ modelVersion: string; points: ForecastPoint[] }> {
    const res = await fetch(`${this.baseUrl}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        sensor_id: req.sensorId,
        model: req.model,
        horizons_minutes: req.horizonsMinutes,
        history: req.history.map((h) => ({ observed_at: h.observedAt, flow_vph: h.flowVph })),
      }),
    });
    if (!res.ok) {
      throw new MlServiceError(`ML service returned ${res.status}: ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as {
      model_version: string;
      points: { target_time: string; horizon_minutes: number; predicted_flow: number }[];
    };
    return {
      modelVersion: body.model_version,
      points: body.points.map((p) => ({
        targetTime: p.target_time,
        horizonMinutes: p.horizon_minutes,
        predictedFlow: p.predicted_flow,
      })),
    };
  }
}
