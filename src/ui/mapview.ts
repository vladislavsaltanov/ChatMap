export function renderMap(root: HTMLElement): void {
  root.innerHTML = `
    <div class="canvas" role="img" aria-label="Карта слов"></div>
    <p class="hover-line label">слово · 0</p>
  `
}
