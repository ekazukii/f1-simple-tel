import { useEffect, useRef } from 'react'
import styles from '../styles/RaceReplayer.module.css'

export interface ReplayPoint {
  driver: number
  x: number
  y: number
  color: string
  label: string
  status?: 'active' | 'crashed'
  crashSlot?: number
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
    ctx.fillStyle = '#f8fafc'
    ctx.fillRect(0, 0, width, height)

    ctx.strokeStyle = 'rgba(17, 24, 39, 0.08)'
    ctx.lineWidth = 1
    ctx.strokeRect(16, 16, width - 32, height - 32)

    const scaleX = (value: number) =>
      32 + ((value - bounds.minX) / (bounds.maxX - bounds.minX || 1)) * (width - 64)
    const scaleY = (value: number) =>
      32 + ((value - bounds.minY) / (bounds.maxY - bounds.minY || 1)) * (height - 64)

    ctx.font = '12px "IBM Plex Sans", "Helvetica Neue", sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    const activePoints = points.filter((point) => point.status !== 'crashed')
    const crashedPoints = points.filter((point) => point.status === 'crashed')

    activePoints.forEach((point) => {
      const px = scaleX(point.x)
      const py = scaleY(point.y)

      ctx.fillStyle = point.color
      ctx.beginPath()
      ctx.arc(px, py, 6, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = '#0f172a'
      ctx.fillText(point.label, px + 10, py)
    })

    if (crashedPoints.length) {
      const padding = 20
      const slotGap = 18
      const baseX = width - 180
      const baseY = height - padding

      ctx.fillStyle = '#6b7280'
      ctx.font = '11px "IBM Plex Sans", "Helvetica Neue", sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'bottom'
      ctx.fillText('CRASHED', baseX, baseY - crashedPoints.length * slotGap - 8)

      crashedPoints.forEach((point, index) => {
        const slot = point.crashSlot ?? index
        const y = baseY - slot * slotGap

        ctx.fillStyle = '#9ca3af'
        ctx.beginPath()
        ctx.arc(baseX - 8, y - 4, 5, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = '#6b7280'
        ctx.fillText(point.label, baseX + 6, y)
      })
    }
  }, [points, bounds, width, height])

  const cx = (...names: string[]) => names.map((n) => styles[n]).filter(Boolean).join(' ')
  return <canvas ref={canvasRef} width={width} height={height} className={cx('race-replay-canvas')} />
}

export default RaceReplayCanvas
