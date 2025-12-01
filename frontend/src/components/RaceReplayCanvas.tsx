import { useEffect, useRef } from 'react'

export interface ReplayPoint {
  driver: number
  x: number
  y: number
  color: string
  label: string
}

interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface RaceReplayCanvasProps {
  points: ReplayPoint[]
  bounds: Bounds | null
  width?: number
  height?: number
}

const defaultWidth = 960
const defaultHeight = 540

export function RaceReplayCanvas({ points, bounds, width = defaultWidth, height = defaultHeight }: RaceReplayCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !bounds) {
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#05060a'
    ctx.fillRect(0, 0, width, height)

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)'
    ctx.lineWidth = 1
    ctx.strokeRect(16, 16, width - 32, height - 32)

    const scaleX = (value: number) =>
      32 + ((value - bounds.minX) / (bounds.maxX - bounds.minX || 1)) * (width - 64)
    const scaleY = (value: number) =>
      32 + ((value - bounds.minY) / (bounds.maxY - bounds.minY || 1)) * (height - 64)

    ctx.font = '12px Inter, system-ui'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    points.forEach((point) => {
      const px = scaleX(point.x)
      const py = scaleY(point.y)

      ctx.fillStyle = point.color
      ctx.beginPath()
      ctx.arc(px, py, 6, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = '#ffffff'
      ctx.fillText(point.label, px + 10, py)
    })
  }, [points, bounds, width, height])

  return <canvas ref={canvasRef} width={width} height={height} className="race-replay-canvas" />
}

export default RaceReplayCanvas
