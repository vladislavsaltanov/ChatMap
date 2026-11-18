import type Graph from 'graphology'
import { applyLabelOverrides, parseLabelOverrides } from '../core/labelOverrides'
import type { LabelOverrideChange } from '../core/labelOverrides'

const STORAGE_KEY = 'chatmap.labels'

export function getLabelOverrides(): Record<string, string> {
  try {
    return parseLabelOverrides(localStorage.getItem(STORAGE_KEY))
  } catch {
    return {}
  }
}

// UI Command: single read, single write, throws on storage failure.
// Null result (forbidden key) skips the write silently, like parse skips it.
export function commitLabelOverrides(changes: LabelOverrideChange[]): void {
  const next = applyLabelOverrides(localStorage.getItem(STORAGE_KEY), changes)
  if (next === null) return
  localStorage.setItem(STORAGE_KEY, next)
}

export type NodeDetails = {
  id: number
  label: string
  defaultLabel: string
  canon: string
  count: number
  neighbors: Array<{ id: number; label: string; weight: number }>
  forms: Array<[form: string, count: number]>
}

export function buildNodeDetails(graph: Graph, id: number, forms: NodeDetails['forms']): NodeDetails | null {
  const key = String(id)
  if (!graph.hasNode(key)) return null

  const attrs = graph.getNodeAttributes(key)
  const label = attrs.label as string
  const defaultLabel = (attrs.defaultLabel as string) || label
  const canon = (attrs.canon as string) || defaultLabel
  const count = (attrs.count as number) || 0

  const neighborsList: Array<{ id: number; label: string; weight: number }> = []
  for (const nb of graph.neighbors(key)) {
    const edge = graph.edges(key, nb)[0]
    const weight = edge ? (graph.getEdgeAttribute(edge, 'weight') as number) : 0
    neighborsList.push({ id: Number(nb), label: graph.getNodeAttribute(nb, 'label') as string, weight })
  }
  neighborsList.sort((a, b) => b.weight - a.weight)

  return { id, label, defaultLabel, canon, count, neighbors: neighborsList.slice(0, 3), forms }
}

export class NodePanel {
  private panel: HTMLElement
  private titleEl: HTMLElement
  private countEl: HTMLElement
  private autoBtn: HTMLButtonElement
  private closeBtn: HTMLButtonElement
  private neighborsContainer: HTMLElement
  private formsContainer: HTMLElement

  private currentDetails: NodeDetails | null = null
  private onSelectCallback: ((id: number) => void) | null = null
  private onOverrideCallback: ((id: number, label: string) => void) | null = null
  private onPhotoCallback: (() => void) | null = null
  private onCenterCallback: (() => void) | null = null
  private photoBtn: HTMLButtonElement
  private centerBtn: HTMLButtonElement

  constructor(root: HTMLElement) {
    this.panel = document.createElement('aside')
    this.panel.className = 'nodepanel'
    this.panel.hidden = true
    this.panel.setAttribute('aria-label', 'Детали слова')
    this.panel.innerHTML = `
      <div class="nodepanel-header">
        <h2 id="node-title">Слово</h2>
        <div class="header-actions">
          <button type="button" id="auto-btn" class="label-btn" aria-label="Сбросить к исходной форме" title="Сбросить к исходной форме">Сброс</button>
          <button type="button" id="photo-btn" class="label-btn" aria-label="Снимок выделенной ноды" title="Снимок выделенной ноды">Фото</button>
          <button type="button" id="center-btn" class="icon-btn" aria-label="Показать связи ноды" title="Показать связи ноды">⊙</button>
          <button type="button" id="close-btn" class="icon-btn" aria-label="Закрыть">✕</button>
        </div>
      </div>

      <p class="label">Встреч: <span id="node-count" class="num">0</span></p>

      <div class="panel-section">
        <p class="label">Топ соседей</p>
        <div id="neighbors-list" class="items-list"></div>
      </div>

      <div class="panel-section">
        <p class="label">Формы кластера</p>
        <div id="forms-list" class="items-list"></div>
      </div>
    `
    root.append(this.panel)

    this.titleEl = this.panel.querySelector<HTMLElement>('#node-title')!
    this.countEl = this.panel.querySelector<HTMLElement>('#node-count')!
    this.autoBtn = this.panel.querySelector<HTMLButtonElement>('#auto-btn')!
    this.closeBtn = this.panel.querySelector<HTMLButtonElement>('#close-btn')!
    this.photoBtn = this.panel.querySelector<HTMLButtonElement>('#photo-btn')!
    this.centerBtn = this.panel.querySelector<HTMLButtonElement>('#center-btn')!
    this.neighborsContainer = this.panel.querySelector<HTMLElement>('#neighbors-list')!
    this.formsContainer = this.panel.querySelector<HTMLElement>('#forms-list')!

    this.closeBtn.addEventListener('click', () => {
      this.hide()
      if (this.onSelectCallback) {
        this.onSelectCallback(-1) // Signal unpin
      }
    })

    this.photoBtn.addEventListener('click', () => {
      this.onPhotoCallback?.()
    })

    this.centerBtn.addEventListener('click', () => {
      this.onCenterCallback?.()
    })

    this.autoBtn.addEventListener('click', () => {
      if (!this.currentDetails) return
      // Also drop a legacy key saved under the label itself, otherwise an old
      // override could survive the reset and be re-applied on the next render.
      try {
        commitLabelOverrides([
          [this.currentDetails.canon, null],
          [this.currentDetails.label, null],
          [this.currentDetails.defaultLabel, null],
        ])
      } catch {
        // Storage failed: keep the old label visible.
        return
      }
      this.currentDetails.label = this.currentDetails.defaultLabel
      this.titleEl.textContent = this.currentDetails.label
      this.renderForms()
      this.syncAutoState()
      if (this.onOverrideCallback) {
        this.onOverrideCallback(this.currentDetails.id, this.currentDetails.label)
      }
    })
  }

  // «Сброс» shows whether there is anything to reset: when the label is
  // already automatic the button is disabled, so the no-op click that
  // used to look broken can no longer happen.
  private syncAutoState(): void {
    const overridden = !!this.currentDetails &&
      this.currentDetails.label !== this.currentDetails.defaultLabel
    this.autoBtn.classList.toggle('active', overridden)
    this.autoBtn.disabled = !overridden
    this.autoBtn.setAttribute('aria-pressed', String(overridden))
    this.autoBtn.title = overridden ? 'Сбросить ручную подпись' : 'Подпись уже автоматическая'
  }

  show(details: NodeDetails): void {
    this.currentDetails = details
    this.titleEl.textContent = details.label
    this.countEl.textContent = String(details.count)

    this.renderNeighbors()
    this.renderForms()
    this.syncAutoState()
    this.panel.hidden = false
  }

  hide(): void {
    this.panel.hidden = true
    this.currentDetails = null
  }

  private renderNeighbors(): void {
    if (!this.currentDetails) return
    this.neighborsContainer.innerHTML = ''

    if (this.currentDetails.neighbors.length === 0) {
      const p = document.createElement('p')
      p.className = 'label'
      p.textContent = 'Нет видимых связей'
      this.neighborsContainer.append(p)
      return
    }

    for (const nb of this.currentDetails.neighbors) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'neighbor-btn'
      const labelEl = document.createElement('span')
      labelEl.textContent = nb.label
      const weightEl = document.createElement('span')
      weightEl.className = 'num'
      weightEl.textContent = String(Number(nb.weight.toFixed(1)))
      btn.append(labelEl, weightEl)
      btn.addEventListener('click', () => {
        if (this.onSelectCallback) {
          this.onSelectCallback(nb.id)
        }
      })
      this.neighborsContainer.append(btn)
    }
  }

  private renderForms(): void {
    if (!this.currentDetails) return
    this.formsContainer.innerHTML = ''

    for (const [form, cnt] of this.currentDetails.forms) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `form-btn ${form === this.currentDetails.label ? 'active' : ''}`
      const formEl = document.createElement('span')
      formEl.textContent = form
      const countEl = document.createElement('span')
      countEl.className = 'num'
      countEl.textContent = String(cnt)
      btn.append(formEl, countEl)
      btn.addEventListener('click', () => {
        if (!this.currentDetails) return
        try {
          commitLabelOverrides([[this.currentDetails.canon, form]])
        } catch {
          // Storage failed: keep the old label visible.
          return
        }
        this.currentDetails.label = form
        this.titleEl.textContent = form
        this.renderForms()
        this.syncAutoState()
        if (this.onOverrideCallback) {
          this.onOverrideCallback(this.currentDetails.id, form)
        }
      })
      this.formsContainer.append(btn)
    }
  }

  onSelect(cb: (id: number) => void): void {
    this.onSelectCallback = cb
  }

  onOverride(cb: (id: number, label: string) => void): void {
    this.onOverrideCallback = cb
  }

  onPhoto(cb: () => void): void {
    this.onPhotoCallback = cb
  }

  onCenter(cb: () => void): void {
    this.onCenterCallback = cb
  }
}
