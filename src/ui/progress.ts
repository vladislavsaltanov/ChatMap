let progressNumEl: HTMLElement | null = null
let progressBarFillEl: HTMLElement | null = null
let progressBarTrackEl: HTMLElement | null = null
let progressStageEl: HTMLElement | null = null

export function renderProgress(root: HTMLElement): void {
  root.innerHTML = `
    <div class="progress-box">
      <p class="label">Обработка экспорта</p>
      <div id="progress-bar-track" class="progress-bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div id="progress-bar-fill" class="progress-bar-fill"></div>
      </div>
      <div class="progress-status">
        <span id="progress-stage" class="label">Чтение файла...</span>
        <span id="progress-num" class="num">0%</span>
      </div>
    </div>
  `
  progressNumEl = root.querySelector<HTMLElement>('#progress-num')
  progressBarFillEl = root.querySelector<HTMLElement>('#progress-bar-fill')
  progressBarTrackEl = root.querySelector<HTMLElement>('#progress-bar-track')
  progressStageEl = root.querySelector<HTMLElement>('#progress-stage')
}

export function updateProgress(done: number, total: number, stage?: string): void {
  const pct = Math.min(100, Math.max(0, Math.round((done / Math.max(1, total)) * 100)))
  if (progressNumEl) {
    progressNumEl.textContent = `${pct}%`
  }
  if (progressBarFillEl) {
    progressBarFillEl.style.width = `${pct}%`
  }
  if (progressBarTrackEl) {
    progressBarTrackEl.setAttribute('aria-valuenow', String(pct))
  }
  if (progressStageEl && stage) {
    progressStageEl.textContent = stage
  }
}
