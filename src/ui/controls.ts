export function renderControls(root: HTMLElement): void {
  const drawer = document.createElement('aside')
  drawer.className = 'drawer'
  drawer.setAttribute('aria-label', 'Управление')
  drawer.innerHTML = `
    <p class="label">Управление</p>
    <p class="label">Появится после загрузки</p>
  `
  root.append(drawer)
}
