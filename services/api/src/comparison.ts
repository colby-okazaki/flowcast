import type { Prediction, Reading } from "./types.js";

export interface ComparisonPoint {
  time: string;
  actual: number | null;
  predicted: number | null;
}

export interface ErrorMetrics {
  n: number;
  mae: number | null;
  rmse: number | null;
  mape: number | null;
}

/** Outer-join actuals and predictions on timestamp, sorted by time. */
export function mergeActualVsPredicted(readings: Reading[], predictions: Prediction[]): ComparisonPoint[] {
  const byTime = new Map<string, ComparisonPoint>();
  for (const r of readings) {
    byTime.set(r.observedAt, { time: r.observedAt, actual: r.flowVph, predicted: null });
  }
  for (const p of predictions) {
    const existing = byTime.get(p.targetTime);
    if (existing) existing.predicted = p.predictedFlow;
    else byTime.set(p.targetTime, { time: p.targetTime, actual: null, predicted: p.predictedFlow });
  }
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
}

/** Error metrics over points that have both an actual and a predicted value. */
export function computeErrorMetrics(points: ComparisonPoint[]): ErrorMetrics {
  const pairs = points.filter(
    (p): p is ComparisonPoint & { actual: number; predicted: number } => p.actual !== null && p.predicted !== null,
  );
  if (pairs.length === 0) return { n: 0, mae: null, rmse: null, mape: null };

  let absSum = 0;
  let sqSum = 0;
  let pctSum = 0;
  let pctCount = 0;
  for (const { actual, predicted } of pairs) {
    const err = predicted - actual;
    absSum += Math.abs(err);
    sqSum += err * err;
    // MAPE is undefined at zero flow (e.g. 3 a.m.), so skip those points.
    if (actual !== 0) {
      pctSum += Math.abs(err / actual);
      pctCount++;
    }
  }
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    n: pairs.length,
    mae: round(absSum / pairs.length),
    rmse: round(Math.sqrt(sqSum / pairs.length)),
    mape: pctCount ? round((pctSum / pctCount) * 100) : null,
  };
}
