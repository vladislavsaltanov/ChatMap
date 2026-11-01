let progressNumEl: HTMLElement | null = null

export function renderProgress(root: HTMLElement): void {
  root.innerHTML = `
    <div class="progress-box">
      <p class="label">Обработка экспорта</p>
      <p id="progress-num" class="num">0 / 100</p>
    </div>
  `
  progressNumEl = root.querySelector<HTMLElement>('#progress-num')
}

export function updateProgress(done: number, total: number): void {
  if (progressNumEl) {
    progressNumEl.textContent = `${done} / ${total}`
  }
}
