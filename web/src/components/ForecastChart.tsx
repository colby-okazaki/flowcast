import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ComparisonPoint } from "../api";

export function ForecastChart({ points, timeZone }: { points: ComparisonPoint[]; timeZone: string }) {
  const timeFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", timeZone });
  if (points.length === 0) {
    return <p className="empty">No readings for this sensor yet. The ingestion scheduler loads them in the background.</p>;
  }
  const data = points.map((p) => ({ ...p, t: new Date(p.time).getTime() }));
  return (
    <ResponsiveContainer width="100%" height={340}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(t) => timeFmt.format(t)}
          stroke="var(--muted)"
          fontSize={12}
        />
        <YAxis stroke="var(--muted)" fontSize={12} width={56} unit="" />
        <Tooltip
          labelFormatter={(t) => timeFmt.format(Number(t))}
          formatter={(v, name) => [`${Math.round(Number(v)).toLocaleString()} veh/h`, name]}
        />
        <Legend />
        <Line name="Actual" dataKey="actual" stroke="var(--actual)" dot={false} strokeWidth={2} connectNulls />
        <Line
          name="Predicted"
          dataKey="predicted"
          stroke="var(--predicted)"
          dot={false}
          strokeWidth={2}
          strokeDasharray="5 4"
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
