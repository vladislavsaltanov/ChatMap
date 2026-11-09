const WARN_FILE_BYTES = 200 * 1024 * 1024

export function renderLanding(
  root: HTMLElement,
  onFile: (file: File) => void,
  onWarning: (msg: string) => void
): void {
  root.innerHTML = `
    <div class="landing-content">
      <h1>ChatMap</h1>
      <p>Экспорт Telegram → карта слов. Локально, без сети.</p>

      <div id="dropzone" class="dropzone" tabindex="0" role="region" aria-label="Зона загрузки файла экспорта">
        <p>Перетащи сюда result.json или выбери файл</p>
        <label class="file-button" tabindex="0" role="button" aria-label="Выбрать файл result.json">
          Выбрать файл
          <input type="file" id="file-input" accept=".json" hidden />
        </label>
        <p id="size-warning" class="warning-text" hidden></p>
      </div>

      <div class="instructions">
        <p class="label">1. Telegram Desktop → Чат → ⋮ → Экспорт истории чата</p>
        <p class="label">2. Формат: машиночитаемый JSON, снять галочки с медиа</p>
        <p class="label">3. Перетащи полученный result.json сюда</p>
      </div>
    </div>
  `

  const input = root.querySelector<HTMLInputElement>('#file-input')!
  const dropzone = root.querySelector<HTMLElement>('#dropzone')!
  const fileButton = root.querySelector<HTMLElement>('.file-button')!
  const warningEl = root.querySelector<HTMLElement>('#size-warning')!

  const handleFile = (file: File) => {
    // The hard 500 MB cap lives in main.ts (sendFile): one source of truth.
    if (file.size > WARN_FILE_BYTES) {
      const msg = 'Файл больше 200 МБ. Обработка может занять продолжительное время.'
      warningEl.textContent = msg
      warningEl.hidden = false
      onWarning(msg)
    } else {
      warningEl.hidden = true
    }
    onFile(file)
  }

  input.addEventListener('change', () => {
    if (input.files && input.files[0]) {
      handleFile(input.files[0])
    }
  })

  const triggerPick = () => input.click()

  fileButton.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      triggerPick()
    }
  })

  dropzone.addEventListener('keydown', (e) => {
    if (e.target === dropzone && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      triggerPick()
    }
  })

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault()
    dropzone.classList.add('dragover')
  })

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover')
  })

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault()
    dropzone.classList.remove('dragover')
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0])
    }
  })
}
