import { CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";
import type { Sensor } from "../api";

interface Props {
  sensors: Sensor[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function SensorMap({ sensors, selectedId, onSelect }: Props) {
  const center: [number, number] = sensors.length
    ? [
        sensors.reduce((s, x) => s + x.latitude, 0) / sensors.length,
        sensors.reduce((s, x) => s + x.longitude, 0) / sensors.length,
      ]
    : [34.05, -118.35];

  return (
    <MapContainer center={center} zoom={11} className="map" scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {sensors.map((s) => (
        <CircleMarker
          key={s.id}
          center={[s.latitude, s.longitude]}
          radius={s.id === selectedId ? 11 : 8}
          pathOptions={{
            color: s.id === selectedId ? "#1d4ed8" : "#0f766e",
            fillOpacity: 0.85,
            weight: 2,
          }}
          eventHandlers={{ click: () => onSelect(s.id) }}
        >
          <Tooltip>{s.name}</Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
