import { describe, expect, it } from "vitest";
import { computeErrorMetrics, mergeActualVsPredicted } from "../src/comparison.js";

const t = (h: number) => `2026-11-23T${String(h).padStart(2, "0")}:00:00.000Z`;

describe("mergeActualVsPredicted", () => {
  it("outer-joins on timestamp and sorts by time", () => {
    const points = mergeActualVsPredicted(
      [
        { sensorId: "s", observedAt: t(2), flowVph: 200, speedMph: null, occupancy: null },
        { sensorId: "s", observedAt: t(1), flowVph: 100, speedMph: null, occupancy: null },
      ],
      [
        { sensorId: "s", modelVersionId: 1, madeAt: t(0), targetTime: t(2), horizonMinutes: 15, predictedFlow: 210 },
        { sensorId: "s", modelVersionId: 1, madeAt: t(0), targetTime: t(3), horizonMinutes: 15, predictedFlow: 300 },
      ],
    );
    expect(points).toEqual([
      { time: t(1), actual: 100, predicted: null },
      { time: t(2), actual: 200, predicted: 210 },
      { time: t(3), actual: null, predicted: 300 },
    ]);
  });
});

describe("computeErrorMetrics", () => {
  it("computes MAE, RMSE and MAPE over paired points only", () => {
    const m = computeErrorMetrics([
      { time: t(1), actual: 100, predicted: 110 },
      { time: t(2), actual: 200, predicted: 170 },
      { time: t(3), actual: null, predicted: 999 },
    ]);
    expect(m.n).toBe(2);
    expect(m.mae).toBe(20);
    expect(m.rmse).toBeCloseTo(Math.sqrt((100 + 900) / 2), 2);
    expect(m.mape).toBe(12.5);
  });

  it("skips zero actuals for MAPE and handles empty input", () => {
    expect(computeErrorMetrics([{ time: t(1), actual: 0, predicted: 5 }]).mape).toBeNull();
    expect(computeErrorMetrics([])).toEqual({ n: 0, mae: null, rmse: null, mape: null });
  });
});
