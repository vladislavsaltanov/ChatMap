export function renderLanding(
  root: HTMLElement,
  onFile: (file: File) => void,
  onWarning: (msg: string) => void
): void {
  root.innerHTML = `
    <div class="landing-content">
      <h1>ChatMap</h1>
      <p>Экспорт Telegram → карта слов. Локально, без сети.</p>

      <div id="dropzone" class="dropzone" tabindex="0">
        <p>Перетащи сюда файл result.json или нажми кнопку</p>
        <label class="file-button">
          Выбрать файл
          <input type="file" id="file-input" accept=".json" hidden />
        </label>
        <p id="size-warning" class="warning-text" hidden></p>
      </div>

      <div class="instructions">
        <p class="label">1. Настройки чата → Экспорт истории чата</p>
        <p class="label">2. Формат: Машиночитаемый JSON</p>
        <p class="label">3. Перетащи result.json в окно браузера</p>
      </div>
    </div>
  `

  const input = root.querySelector<HTMLInputElement>('#file-input')!
  const dropzone = root.querySelector<HTMLElement>('#dropzone')!
  const warningEl = root.querySelector<HTMLElement>('#size-warning')!

  const handleFile = (file: File) => {
    if (file.size > 200 * 1024 * 1024) {
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
