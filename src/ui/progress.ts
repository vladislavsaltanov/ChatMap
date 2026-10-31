export function renderProgress(root: HTMLElement): void {
  root.innerHTML = `
    <p class="label">Обработка</p>
    <p class="num">0 / 0</p>
  `
}
