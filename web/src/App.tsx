import { useCallback, useEffect, useState } from "react";
import { api, type Comparison, type Sensor } from "./api";
import { ForecastChart } from "./components/ForecastChart";
import { SensorMap } from "./components/SensorMap";

const HORIZONS = [15, 30, 60];

export default function App() {
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [horizon, setHorizon] = useState(15);
  const [hours, setHours] = useState(24);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function runForecast() {
    if (!selectedId) return;
    setBusy(true);
    try {
      await api.forecast(selectedId, HORIZONS);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const selected = sensors.find((s) => s.id === selectedId);
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
                {selected.road} {selected.direction}B · {selected.lanes} lanes · {selected.id}
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
            <button onClick={runForecast} disabled={!selectedId || busy}>
              {busy ? "Forecasting…" : "Generate forecast"}
            </button>
          </div>
        </div>

        <div className="metrics">
          <Metric label="MAE" value={m?.mae} unit="veh/h" />
          <Metric label="RMSE" value={m?.rmse} unit="veh/h" />
          <Metric label="MAPE" value={m?.mape} unit="%" />
          <Metric label="Scored points" value={m?.n} />
        </div>

        <ForecastChart points={comparison?.points ?? []} />
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
