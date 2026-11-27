export interface Sensor {
  id: string;
  name: string;
  road: string | null;
  direction: string | null;
  latitude: number;
  longitude: number;
  lanes: number | null;
  source: string;
  latestReadingAt: string | null;
}

export interface ComparisonPoint {
  time: string;
  actual: number | null;
  predicted: number | null;
}

export interface Comparison {
  horizonMinutes: number;
  metrics: { n: number; mae: number | null; rmse: number | null; mape: number | null };
  points: ComparisonPoint[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body.data as T;
}

export const api = {
  sensors: () => request<Sensor[]>("/api/sensors"),
  comparison: (id: string, hours: number, horizon: number) =>
    request<Comparison>(`/api/sensors/${encodeURIComponent(id)}/comparison?hours=${hours}&horizon=${horizon}`),
  forecast: (id: string, horizonsMinutes: number[]) =>
    request<{ saved: number }>(`/api/sensors/${encodeURIComponent(id)}/forecast`, {
      method: "POST",
      body: JSON.stringify({ horizonsMinutes }),
    }),
  backfill: (id: string, hours: number, horizonsMinutes: number[]) =>
    request<{ saved: number; cutoffs: number }>(`/api/sensors/${encodeURIComponent(id)}/backfill`, {
      method: "POST",
      body: JSON.stringify({ hours, horizonsMinutes }),
    }),
};
