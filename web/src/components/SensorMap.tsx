import { useEffect } from "react";
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { Sensor } from "../api";

interface Props {
  sensors: Sensor[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** Fits the map to all sensors once they load. */
function FitToSensors({ sensors }: { sensors: Sensor[] }) {
  const map = useMap();
  useEffect(() => {
    if (sensors.length === 0) return;
    map.fitBounds(
      sensors.map((s) => [s.latitude, s.longitude] as [number, number]),
      { padding: [32, 32], maxZoom: 12 },
    );
  }, [map, sensors]);
  return null;
}

export function SensorMap({ sensors, selectedId, onSelect }: Props) {
  return (
    <MapContainer center={[51.5, -0.12]} zoom={9} className="map" scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitToSensors sensors={sensors} />
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
