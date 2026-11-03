// rAF-твины граф-состояний sigma: стили-функции читают dim/focus на каждом refresh,
// поэтому интерполяция значений даёт покадровое сглаживание подсветки узлов.
export type TweenField = 'dim' | 'focus'

export class SubgraphAnimator {
  private vals: Record<TweenField, number> = { dim: 0, focus: 0 }
  private rafs: Partial<Record<TweenField, number>> = {}

  constructor(private readonly apply: (v: Record<TweenField, number>) => void) {}

  value(field: TweenField): number {
    return this.vals[field]
  }

  to(field: TweenField, target: number, duration: number, onDone?: () => void): void {
    const raf = this.rafs[field]
    if (raf !== undefined) cancelAnimationFrame(raf)
    const from = this.vals[field]
    if (from === target) {
      onDone?.()
      return
    }
    const t0 = performance.now()
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / duration)
      const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
      this.vals[field] = from + (target - from) * eased
      this.apply({ ...this.vals })
      if (p < 1) {
        this.rafs[field] = requestAnimationFrame(step)
      } else {
        delete this.rafs[field]
        onDone?.()
      }
    }
    this.rafs[field] = requestAnimationFrame(step)
  }
}
