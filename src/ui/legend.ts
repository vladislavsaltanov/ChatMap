import { LEGEND_TEXT, wrapLegend } from '../core/legend'

// Quiet ink on the dark plate. No box, no shadow: the hint must stay behind
// the graph, not compete with it.
const FONT = '400 12px "Obel Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const INK = 'rgba(240, 237, 228, 0.42)'
const MAX_WIDTH = 380
const X = 28
const BOTTOM = 30
const LINE_HEIGHT = 18

// Draws in CSS pixels: `scale` is the devicePixelRatio baked into the canvas.
export function drawLegend(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number): void {
  ctx.save()
  ctx.scale(scale, scale)
  ctx.font = FONT
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = INK
  const limit = Math.max(80, Math.min(MAX_WIDTH, width - X * 2))
  const lines = wrapLegend(LEGEND_TEXT, limit, (s) => ctx.measureText(s).width)
  const first = height - BOTTOM - (lines.length - 1) * LINE_HEIGHT
  lines.forEach((line, i) => ctx.fillText(line, X, first + i * LINE_HEIGHT))
  ctx.restore()
}
