import { useEffect, useMemo, useRef } from "react";
import type { TelemetrySample } from "../types";

interface Props {
  points: TelemetrySample[];
  width?: number;
  height?: number;
}

interface CanvasPoint {
  x: number;
  y: number;
  speed?: number;
}

const fallbackWidth = 900;
const fallbackHeight = 500;

export function TelemetryCanvas({
  points,
  width = fallbackWidth,
  height = fallbackHeight,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const canvasPoints = useMemo(() => projectPoints(points), [points]);

  useEffect(() => {
    if (!points.length) {
      return;
    }
    countOutOfOrderSamples(points, 1000);
  }, [points]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, width, height);

    if (!canvasPoints.length) {
      ctx.fillStyle = "#aaa";
      ctx.font = "16px Inter, system-ui";
      ctx.textAlign = "center";
      ctx.fillText("No location samples yet", width / 2, height / 2);
      return;
    }

    const padding = 24;
    const bounds = getBounds(canvasPoints);
    const speedBounds = getSpeedBounds(canvasPoints);
    const scaleX = (value: number) =>
      padding +
      ((value - bounds.minX) / (bounds.maxX - bounds.minX || 1)) *
        (width - padding * 2);
    const scaleY = (value: number) =>
      padding +
      ((value - bounds.minY) / (bounds.maxY - bounds.minY || 1)) *
        (height - padding * 2);

    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    let lastColor: string | null = null;
    let lastPoint: { x: number; y: number } | null = null;
    ctx.beginPath();

    canvasPoints.forEach((point, index) => {
      const px = scaleX(point.x);
      const py = scaleY(point.y);
      const color = getSpeedColor(point.speed, speedBounds);

      if (color !== lastColor) {
        if (index !== 0 && lastPoint) {
          ctx.stroke();
          ctx.beginPath();
          ctx.strokeStyle = color;
          ctx.moveTo(lastPoint.x, lastPoint.y);
          ctx.lineTo(px, py);
        } else {
          ctx.strokeStyle = color;
          ctx.moveTo(px, py);
        }
        lastColor = color;
      } else if (index === 0) {
        ctx.strokeStyle = color;
        ctx.moveTo(px, py);
        lastColor = color;
      } else {
        ctx.lineTo(px, py);
      }

      lastPoint = { x: px, y: py };
    });

    ctx.stroke();
  }, [canvasPoints, width, height]);

  return (
    <div className="telemetry-wrapper">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="telemetry-canvas"
      />
    </div>
  );
}

function projectPoints(
  points: TelemetrySample[]
): CanvasPoint[] {
  return points.reduce<CanvasPoint[]>((acc, point) => {
    const x = pickNumeric(point, ["x", "lon", "long", "longitude"]);
    const y = pickNumeric(point, ["y", "lat", "latitude"]);

    if (x == null || y == null) {
      return acc;
    }

    const speed = typeof point.speed === "number" ? point.speed : undefined;
    acc.push({ x, y, speed });
    return acc;
  }, []);
}

function countOutOfOrderSamples(points: TelemetrySample[], limit: number) {
  let lastTimestamp: number | null = null;
  let violations = 0;

  for (let index = 0; index < points.length && index < limit; index += 1) {
    const value = points[index]?.sample_time;
    const current = typeof value === "string" ? Date.parse(value) : NaN;

    if (!Number.isFinite(current)) {
      continue;
    }

    if (lastTimestamp != null && current < lastTimestamp) {
      violations += 1;
    }

    lastTimestamp = current;
  }

  return violations;
}

function pickNumeric(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
  }
  return null;
}

function getBounds(points: CanvasPoint[]) {
  return points.reduce(
    (acc, point) => ({
      minX: Math.min(acc.minX, point.x),
      maxX: Math.max(acc.maxX, point.x),
      minY: Math.min(acc.minY, point.y),
      maxY: Math.max(acc.maxY, point.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    }
  );
}

function getSpeedBounds(points: CanvasPoint[]) {
  const bounds = points.reduce(
    (acc, point) => {
      if (typeof point.speed === 'number' && Number.isFinite(point.speed)) {
        return {
          min: Math.min(acc.min, point.speed),
          max: Math.max(acc.max, point.speed),
          hasData: true
        };
      }
      return acc;
    },
    { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, hasData: false }
  );

  if (!bounds.hasData) {
    return { min: 0, max: 0 };
  }

  return { min: bounds.min, max: bounds.max };
}

function getSpeedColor(speed: number | undefined | null, bounds: { min: number; max: number }) {
  if (typeof speed === 'number' && Number.isFinite(speed) && bounds.max > bounds.min) {
    const clamped = Math.max(bounds.min, Math.min(bounds.max, speed));
    const ratio = (clamped - bounds.min) / (bounds.max - bounds.min || 1);
    return speedToColor(ratio);
  }

  if (typeof speed === 'number' && Number.isFinite(speed)) {
    return speedToColor(0.5);
  }

  return '#ffffff';
}

function speedToColor(ratio: number) {
  const clamped = Math.min(1, Math.max(0, ratio));
  const hue = (1 - clamped) * 240; // blue (slow) to red (fast)
  return `hsl(${hue}, 90%, 55%)`;
}
