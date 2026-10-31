export function renderLanding(root: HTMLElement): void {
  root.innerHTML = `
    <h1>ChatMap</h1>
    <p>Экспорт Telegram → карта слов. Локально, без сети.</p>
    <p><button type="button">Выбрать файл result.json</button></p>
    <p class="label">Настройки чата → Экспорт → JSON</p>
    <p class="label">Файл не покидает устройство</p>
  `
}
