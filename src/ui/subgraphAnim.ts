// rAF-твины граф-состояний sigma: стили-функции читают dim/focus на каждом refresh,
// поэтому интерполяция значений даёт покадровое сглаживание подсветки узлов.
// Все твины живут в одном rAF-цикле и применяются одной порцией за кадр —
// два одновременных твина иначе дёргали refresh дважды за кадр (пропуски кадров).
export type TweenField = 'dim' | 'focus'

type Tween = { from: number; to: number; t0: number; dur: number; onDone?: () => void }

export class SubgraphAnimator {
  private vals: Record<TweenField, number> = { dim: 0, focus: 0 }
  private tweens: Partial<Record<TweenField, Tween>> = {}
  private raf: number | null = null

  constructor(private readonly apply: (v: Record<TweenField, number>) => void) {}

  value(field: TweenField): number {
    return this.vals[field]
  }

  to(field: TweenField, target: number, duration: number, onDone?: () => void): void {
    const current = this.tweens[field]
    if (!current && this.vals[field] === target) {
      onDone?.()
      return
    }
    this.tweens[field] = { from: this.vals[field], to: target, t0: performance.now(), dur: duration, onDone }
    this.tick()
  }

  private tick(): void {
    if (this.raf !== null) return
    this.raf = requestAnimationFrame(this.step)
  }

  private step = (now: number): void => {
    this.raf = null
    let settled: Array<() => void> = []
    for (const field of ['dim', 'focus'] as const) {
      const tw = this.tweens[field]
      if (!tw) continue
      const p = Math.min(1, (now - tw.t0) / tw.dur)
      const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
      // Квантование до 1/40: непрерывные значения иначе рожали новые ключи
      // цветов/размеров КАЖДЫЙ кадр (600 узлов × 60 fps) — анимация пина
      // проседала и дёергала на середине.
      this.vals[field] = Math.round((tw.from + (tw.to - tw.from) * eased) * 40) / 40
      if (p >= 1) {
        this.vals[field] = tw.to
        delete this.tweens[field]
        if (tw.onDone) settled.push(tw.onDone)
      }
    }
    if (Object.keys(this.tweens).length > 0) this.tick()
    // apply один раз за кадровый тик; коллбеки после, чтобы наследующий RAF
    // (запущенный коллбеком) попал на следующий кадр
    this.apply({ ...this.vals })
    for (const done of settled) done()
  }
}
