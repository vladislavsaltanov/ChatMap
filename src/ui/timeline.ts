// Timeline strip: a flat capsule that lives IN FLOW under the map canvas. One
// vertical tick per time bucket, its height LINEAR in the real message count of
// that bucket (the owner's truthfulness bar: no sqrt, no smoothing, no invented
// data), a solid playhead and the cursor readout with the frame's own numbers.
// The strip owns the pointer/keyboard grammar only — every frame is computed by
// the worker, so this module never touches the chat data.
import type { TimelineMetaMsg } from '../core/types'

// One bucket per window: the worker coalesces nothing, so the throttle lives on
// the sender side (latest-wins pumps the rest).
const EMIT_MS = 150

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export class TimelineStrip {
  private root: HTMLElement | null = null
  private readout: HTMLElement | null = null
  private ticksEl: HTMLElement | null = null
  private playhead: HTMLElement | null = null
  private ticks: HTMLElement[] = []
  // Last ELIGIBLE meta. Ineligible answers leave it null, so metaReady() answers
  // "the strip can be scrubbed", which is what the wiring needs.
  private meta: TimelineMetaMsg | null = null
  private cursor = 0
  private dragging = false
  private emitTimer: number | null = null
  private pendingEmit: number | null = null
  private callbacks: Array<(bucket: number) => void> = []

  // [Command] Build the strip once and append it as the LAST child of the map
  // screen root. #map is a flex column, so the canvas shrinks by the strip's
  // height instead of being covered by it.
  mount(root: HTMLElement): void {
    // Guard: a single instance is mounted once per document.
    if (this.root !== null) return
    const timeline = document.createElement('div')
    timeline.className = 'timeline'
    timeline.hidden = true
    // Keyboard cursor: the strip is a slider over buckets, not a text control.
    timeline.tabIndex = 0
    timeline.setAttribute('role', 'slider')
    timeline.setAttribute('aria-label', 'Таймлайн')
    timeline.setAttribute('aria-valuemin', '0')
    timeline.innerHTML = `
      <div class="timeline-capsule">
        <div class="timeline-readout label"></div>
        <div class="timeline-ticks"></div>
        <div class="timeline-playhead"></div>
      </div>
    `
    root.append(timeline)

    const capsule = timeline.querySelector<HTMLElement>('.timeline-capsule')!
    this.root = timeline
    this.readout = timeline.querySelector<HTMLElement>('.timeline-readout')!
    this.ticksEl = timeline.querySelector<HTMLElement>('.timeline-ticks')!
    this.playhead = timeline.querySelector<HTMLElement>('.timeline-playhead')!

    capsule.addEventListener('pointerdown', (e) => {
      // Guard: only a primary-button press starts a scrub.
      if (e.button !== 0) return
      this.dragging = true
      capsule.setPointerCapture(e.pointerId)
      this.seekToPointer(e)
    })
    capsule.addEventListener('pointermove', (e) => {
      // Guard: hovering without a press must never move the cursor.
      if (!this.dragging) return
      this.seekToPointer(e)
    })
    const endDrag = (e: PointerEvent) => {
      if (!this.dragging) return
      this.dragging = false
      // Guard: capture is already gone if the pointer was cancelled by the UA.
      if (capsule.hasPointerCapture(e.pointerId)) capsule.releasePointerCapture(e.pointerId)
    }
    capsule.addEventListener('pointerup', endDrag)
    capsule.addEventListener('pointercancel', endDrag)

    timeline.addEventListener('keydown', (e) => {
      const meta = this.meta
      // Guard: no painted buckets means nothing to step through.
      if (meta === null) return
      const last = Math.max(0, meta.count - 1)
      // Undefined = the key is not ours: never preventDefault on a foreign key.
      const target =
        e.key === 'ArrowLeft'
          ? this.cursor - 1
          : e.key === 'ArrowRight'
            ? this.cursor + 1
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? last
                : undefined
      if (target === undefined) return
      e.preventDefault()
      this.moveCursor(clamp(target, 0, last), true)
    })
  }

  // [Command] Draw the strip for this chat. Ineligible meta (a chat shorter than
  // the bucket floor, or a bad date range) renders nothing and calls nothing: the
  // checkbox in main unchecks itself, so the refusal is visible instead of a strip
  // that would be pure decoration.
  show(meta: TimelineMetaMsg): void {
    const root = this.root
    // Guard: show() before mount() has nowhere to paint.
    if (root === null) return
    if (!meta.eligible || meta.count <= 0) {
      this.meta = null
      this.cancelEmit()
      this.pendingEmit = null
      root.hidden = true
      return
    }
    this.meta = meta
    // Default = whole history: the map was just drawn for the full chat, so the
    // first frame needs no slice request.
    this.cursor = meta.count - 1
    this.buildTicks(meta)
    root.hidden = false
    root.setAttribute('aria-valuemax', String(meta.count - 1))
    this.paint()
  }

  // [Command] Hide the strip and drop the queued bucket: an emit that lands after
  // the toggle went off would repaint the map to a frame the user abandoned.
  hide(): void {
    if (this.root !== null) this.root.hidden = true
    this.meta = null
    this.dragging = false
    this.cancelEmit()
    this.pendingEmit = null
  }

  onBucket(cb: (bucket: number) => void): void {
    this.callbacks.push(cb)
  }

  // [Query] Cursor bucket the map should be showing.
  currentBucket(): number {
    return this.meta === null ? 0 : this.cursor
  }

  // [Query] Whole-history bucket (count - 1). The off-toggle returns the map to
  // THIS frame, not to the cursor: switching the strip off must restore the
  // pre-timeline view.
  lastBucket(): number {
    return this.meta === null ? 0 : Math.max(0, this.meta.count - 1)
  }

  // [Query] True once an eligible meta has been painted, i.e. slices may be asked.
  metaReady(): boolean {
    return this.meta !== null
  }

  // [Command] One tick per bucket, centred on its slot. Heights are the bucket's
  // share of the STRIP'S OWN peak, linearly — the spectrum must not claim more
  // contrast than the counts have.
  private buildTicks(meta: TimelineMetaMsg): void {
    const box = this.ticksEl
    // Guard: mount() has not run, so there is no box to fill.
    if (box === null) return
    box.replaceChildren()
    this.ticks = []
    if (meta.count <= 0) return
    let peak = 0
    for (const n of meta.msgCounts) if (n > peak) peak = n
    for (let i = 0; i < meta.count; i++) {
      const tick = document.createElement('div')
      tick.style.left = `${((i + 0.5) / meta.count) * 100}%`
      // Guard: a frame with no messages at all draws no bar (honest emptiness).
      tick.style.height = peak > 0 ? `${((meta.msgCounts[i] ?? 0) / peak) * 100}%` : '0%'
      box.append(tick)
      this.ticks.push(tick)
    }
  }

  // Guard: the pointer is mapped through the SPECTRUM box, not the capsule — ticks
  // are inset by the capsule's padding, so the cursor must land on the tick under
  // the pointer. A zero-width (hidden, mid-layout) box cannot divide by zero.
  private seekToPointer(e: PointerEvent): void {
    const box = this.ticksEl
    const meta = this.meta
    if (box === null || meta === null || meta.count <= 0) return
    const rect = box.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    // Tick i is centred at (i + 0.5) / count, so the round trip is -0.5.
    this.moveCursor(clamp(Math.round(ratio * meta.count - 0.5), 0, meta.count - 1), true)
  }

  // [Command] Move the cursor, repaint, then queue the emit. A move inside the
  // current bucket is a no-op: the frame on screen is already that bucket.
  private moveCursor(bucket: number, emit: boolean): void {
    if (this.meta === null || bucket === this.cursor) return
    this.cursor = bucket
    this.paint()
    if (emit) this.queueEmit(bucket)
  }

  // [Command] Repaint from the cursor: covered ticks, playhead position, readout.
  // Pure DOM writes; the numbers come from the meta, never from a counter here.
  private paint(): void {
    const meta = this.meta
    if (meta === null) return
    const count = Math.max(1, meta.count)
    for (let i = 0; i < this.ticks.length; i++) {
      this.ticks[i].classList.toggle('covered', i <= this.cursor)
    }
    if (this.playhead !== null) {
      // Fraction of the spectrum, not of the capsule: the playhead's CSS turns it
      // into a px-accurate `left` inside the inset ticks box, so the line stands
      // exactly on the tick it names.
      this.playhead.style.setProperty('--tick-ratio', String((this.cursor + 0.5) / count))
    }
    const label = meta.labels[this.cursor] ?? ''
    const messages = meta.msgCounts[this.cursor] ?? 0
    const text = `${label} · ${messages} сообщ.`
    if (this.readout !== null) this.readout.textContent = text
    this.root?.setAttribute('aria-valuenow', String(this.cursor))
    this.root?.setAttribute('aria-valuetext', text)
  }

  // [Command] Trailing-edge throttle: the first move of a burst waits EMIT_MS and
  // every later move inside that window overwrites the pending bucket, so the
  // worker sees at most one bucket per window and always the LAST position.
  private queueEmit(bucket: number): void {
    this.pendingEmit = bucket
    if (this.emitTimer !== null) return
    this.emitTimer = window.setTimeout(() => {
      this.emitTimer = null
      const next = this.pendingEmit
      this.pendingEmit = null
      // Guard: hide() may have cleared the pending bucket under this timer.
      if (next === null) return
      for (const cb of this.callbacks) cb(next)
    }, EMIT_MS)
  }

  private cancelEmit(): void {
    if (this.emitTimer === null) return
    window.clearTimeout(this.emitTimer)
    this.emitTimer = null
  }
}

let timelineInstance: TimelineStrip | null = null

export function renderTimeline(root: HTMLElement): TimelineStrip {
  if (!timelineInstance) timelineInstance = new TimelineStrip()
  timelineInstance.mount(root)
  return timelineInstance
}
