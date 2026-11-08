// Pure legend content and line wrapping. The same lines are painted on the
// on-screen canvas and on both PNG exports, so the hint is identical everywhere.

export const LEGEND_TEXT =
  'Самые большие ноды — самые часто используемые слова, чем меньше — тем реже. ' +
  'Линиями показаны связи — какие слова упоминались рядом чаще всего.'

// Greedy word wrap. `measure` is injected: a real 2D context on screen/export,
// a deterministic fake in tests. A word longer than the limit stays intact.
export function wrapLegend(text: string, maxWidth: number, measure: (line: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (line && measure(candidate) > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}
