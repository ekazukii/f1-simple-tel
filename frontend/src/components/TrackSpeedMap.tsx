import { useEffect, useMemo, useState } from "react";
import styles from "../styles/TelemetryCanvas.module.css";
import type { TelemetrySample } from "../types";
import { TelemetryCanvas } from "./TelemetryCanvas";

const BACKEND_BASE_URL = (
  import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000"
).replace(/\/$/, "");

interface TrackSpeedMapProps {
  sessionKey: string;
  driverNumber: number | null;
  lapNumber: number | null;
  fallbackPoints: TelemetrySample[];
}

export function TrackSpeedMap({
  sessionKey,
  driverNumber,
  lapNumber,
  fallbackPoints,
}: TrackSpeedMapProps) {
  const [hasError, setHasError] = useState(false);
  const cx = (...names: string[]) => names.map((n) => styles[n]).filter(Boolean).join(" ");

  useEffect(() => {
    setHasError(false);
  }, [sessionKey, driverNumber, lapNumber]);

  const svgUrl = useMemo(() => {
    if (!sessionKey || !driverNumber || !lapNumber) {
      return null;
    }
    return `${BACKEND_BASE_URL}/track-speed/${encodeURIComponent(
      sessionKey
    )}/${driverNumber}/${lapNumber}`;
  }, [sessionKey, driverNumber, lapNumber]);

  if (!svgUrl || hasError) {
    return <TelemetryCanvas points={fallbackPoints} />;
  }

  return (
    <div className={cx("telemetry-wrapper")}>
      <img
        src={svgUrl}
        alt="Track speed map"
        loading="lazy"
        className={cx("telemetry-canvas")}
        onError={() => setHasError(true)}
      />
    </div>
  );
}
