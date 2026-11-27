import { useCallback, useEffect, useState } from "react";
import { api, type Comparison, type Sensor } from "./api";
import { ForecastChart } from "./components/ForecastChart";
import { SensorMap } from "./components/SensorMap";

const HORIZONS = [15, 30, 60];

// Traffic patterns only make sense in local clock time (rush hour is 8 a.m. where the road is).
const SOURCE_TIME_ZONES: Record<string, string> = {
  webtris: "Europe/London",
  synthetic: "America/Los_Angeles",
};
const timeZoneFor = (s?: Sensor) => (s && SOURCE_TIME_ZONES[s.source]) || "UTC";

export default function App() {
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [horizon, setHorizon] = useState(15);
  const [hours, setHours] = useState(24);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .sensors()
      .then((list) => {
        setSensors(list);
        setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const load = useCallback(async () => {
    if (!selectedId) return;
    try {
      setError(null);
      setComparison(await api.comparison(selectedId, hours, horizon));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selectedId, hours, horizon]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runAction(label: string, action: (id: string) => Promise<unknown>) {
    if (!selectedId) return;
    setBusy(label);
    try {
      await action(selectedId);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const selected = sensors.find((s) => s.id === selectedId);
  const timeZone = timeZoneFor(selected);
  const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
  const m = comparison?.metrics;

  return (
    <div className="layout">
      <header>
        <h1>FlowCast</h1>
        <p className="muted">Short-term traffic flow forecasting</p>
      </header>

      {error && <div className="error">{error}</div>}

      <section className="panel map-panel">
        <SensorMap sensors={sensors} selectedId={selectedId} onSelect={setSelectedId} />
      </section>

      <section className="panel">
        <div className="toolbar">
          <div>
            <h2>{selected?.name ?? "Select a sensor"}</h2>
            {selected && (
              <p className="muted">
                {[
                  selected.road,
                  selected.lanes ? `${selected.lanes} lanes` : null,
                  selected.latestReadingAt ? `data through ${dateTimeFmt.format(new Date(selected.latestReadingAt))}` : "no data yet",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>
          <div className="controls">
            <label>
              Window
              <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                <option value={6}>6 h</option>
                <option value={24}>24 h</option>
                <option value={72}>3 days</option>
                <option value={168}>7 days</option>
              </select>
            </label>
            <label>
              Horizon
              <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
                {HORIZONS.map((h) => (
                  <option key={h} value={h}>
                    {h} min
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary"
              onClick={() => runAction("backtest", (id) => api.backfill(id, hours, HORIZONS))}
              disabled={!selectedId || busy !== null}
              title="Replay the model over this window as if it were live, then score it against what actually happened"
            >
              {busy === "backtest" ? "Backtesting…" : "Backtest window"}
            </button>
            <button
              onClick={() => runAction("forecast", (id) => api.forecast(id, HORIZONS))}
              disabled={!selectedId || busy !== null}
            >
              {busy === "forecast" ? "Forecasting…" : "Forecast next hour"}
            </button>
          </div>
        </div>

        <div className="metrics">
          <Metric label="MAE" value={m?.mae} unit="veh/h" />
          <Metric label="RMSE" value={m?.rmse} unit="veh/h" />
          <Metric label="MAPE" value={m?.mape} unit="%" />
          <Metric label="Scored points" value={m?.n} />
        </div>

        <ForecastChart points={comparison?.points ?? []} timeZone={timeZone} />
        {selected?.source === "webtris" && (
          <p className="muted attribution">
            Traffic data: National Highways WebTRIS, published under the Open Government Licence. Times shown in UK local time.
          </p>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, unit }: { label: string; value: number | null | undefined; unit?: string }) {
  return (
    <div className="metric">
      <span className="muted">{label}</span>
      <strong>
        {value === null || value === undefined ? "—" : value.toLocaleString()}
        {value !== null && value !== undefined && unit ? <small> {unit}</small> : null}
      </strong>
    </div>
  );
}
