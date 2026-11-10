import { debounce } from '../core/debounce'
import { escapeHtml } from '../core/escapeHtml'
import type { ViewCfg, ViewMode } from '../core/select'
import type { AuthorId, FilterCfg } from '../core/types'
import { NODE_COLORS } from './neural'

export type ControlsCallback = (cfg: FilterCfg & ViewCfg) => void
export type ColorChangeCallback = (colors: Map<AuthorId, string>) => void

function hueToHex(hueDegrees: number): string {
  const h = ((hueDegrees % 360) + 360) % 360
  // Дополнительные голоса сверх двух основных: золотое сечение по hue.
  // Основные цвета берутся из NODE_COLORS и не генерируются.
  const s = 0.62
  const l = 0.74
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) {
    r = c
    g = x
    b = 0
  } else if (h < 120) {
    r = x
    g = c
    b = 0
  } else if (h < 180) {
    r = 0
    g = c
    b = x
  } else if (h < 240) {
    r = 0
    g = x
    b = c
  } else if (h < 300) {
    r = x
    g = 0
    b = c
  } else {
    r = c
    g = 0
    b = x
  }
  const toHex = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

// One custom word per line; commas and semicolons also split, so a single-line
// paste like "bad1, bad2" does not become one never-matching entry.
function parseCustom(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export class Controls {
  private modesContainer: HTMLElement
  private authorsGroup: HTMLElement
  private authorsColors: HTMLElement
  private matCheckbox: HTMLInputElement
  private laughCheckbox: HTMLInputElement
  private techCheckbox: HTMLInputElement
  private digitsCheckbox: HTMLInputElement
  private stopwordsCheckbox: HTMLInputElement
  private smartMergeCheckbox: HTMLInputElement
  private customMatText: HTMLTextAreaElement
  private customLaughText: HTMLTextAreaElement
  private sliderTopN: HTMLInputElement
  private sliderMinWeight: HTMLInputElement
  private legendCheckbox: HTMLInputElement
  private topNVal: HTMLElement
  private minWeightVal: HTMLElement

  private currentMode: ViewMode = { kind: 'together' }
  private authorColors = new Map<AuthorId, string>()
  private changeCallbacks: ControlsCallback[] = []
  private colorCallbacks: ColorChangeCallback[] = []
  private legendCallbacks: Array<(visible: boolean) => void> = []

  private debouncedTriggerChange = debounce(() => {
    const cfg = this.getCfg()
    for (const cb of this.changeCallbacks) {
      cb(cfg)
    }
  }, 150)

  constructor(root: HTMLElement) {
    const details = document.createElement('details')
    details.className = 'drawer'
    // На узких экранах панель скрыта по умолчанию — не съедает карту целиком
    details.open = window.matchMedia('(min-width: 720px)').matches
    details.setAttribute('aria-label', 'Параметры')
    details.innerHTML = `
      <summary class="label">Параметры</summary>
      <div class="drawer-content">
        <fieldset class="control-group">
          <legend class="label">Режим</legend>
          <div id="modes-container" class="modes-list">
            <label><input type="radio" name="view-mode" value="together" checked /> Вместе</label>
          </div>
        </fieldset>

        <fieldset class="control-group">
          <legend class="label">Показать на карте</legend>
          <label class="check-label" title="Снято — мат не попадает в карту"><input type="checkbox" id="filter-mat" /> Мат</label>
          <label class="check-label" title="Снято — смех (хаха, лол) не попадает в карту"><input type="checkbox" id="filter-laugh" /> Смех</label>
          <label class="check-label" title="Снято — ссылки и код не попадают в карту"><input type="checkbox" id="filter-tech" /> Ссылки и код</label>
          <label class="check-label" title="Снято — числа не попадают в карту"><input type="checkbox" id="filter-digits" /> Числа</label>
          <label class="check-label" title="Снято — стоп-слова (и, в, не, …) не попадают в карту"><input type="checkbox" id="filter-stopwords" /> Стоп-слова</label>
          <label class="check-label" title="Склеивает однокоренные формы в один узел"><input type="checkbox" id="filter-smart-merge" /> Умные склейки</label>
        </fieldset>

        <fieldset class="control-group">
          <legend class="label">Кастомные слова</legend>
          <label class="label" for="custom-mat">Мат:</label>
          <textarea id="custom-mat" rows="2" placeholder="слово или корень-"></textarea>
          <label class="label" for="custom-laugh">Смех:</label>
          <textarea id="custom-laugh" rows="2" placeholder="слово или корень-"></textarea>
        </fieldset>

        <fieldset class="control-group">
          <legend class="label">Отбор</legend>
          <label class="slider-label" for="slider-top-n">
            <span>Слов на карте: <span id="top-n-val" class="num">600</span></span>
            <input type="range" id="slider-top-n" min="100" max="1000" step="50" value="600" />
          </label>
          <label class="slider-label" for="slider-min-weight">
            <span>Мин. вес ребра: <span id="min-weight-val" class="num">0</span></span>
            <input type="range" id="slider-min-weight" min="0" max="10" step="0.5" value="0" />
          </label>
        </fieldset>

        <fieldset class="control-group">
          <legend class="label">Карта</legend>
          <label class="check-label"><input type="checkbox" id="show-legend" checked /> Подсказка на карте</label>
        </fieldset>

        <fieldset id="authors-group" class="control-group" hidden>
          <legend class="label">Цвета авторов</legend>
          <div id="authors-colors" class="authors-colors-list"></div>
        </fieldset>
      </div>
    `
    root.append(details)

    this.modesContainer = details.querySelector<HTMLElement>('#modes-container')!
    this.authorsGroup = details.querySelector<HTMLElement>('#authors-group')!
    this.authorsColors = details.querySelector<HTMLElement>('#authors-colors')!
    this.matCheckbox = details.querySelector<HTMLInputElement>('#filter-mat')!
    this.laughCheckbox = details.querySelector<HTMLInputElement>('#filter-laugh')!
    this.techCheckbox = details.querySelector<HTMLInputElement>('#filter-tech')!
    this.digitsCheckbox = details.querySelector<HTMLInputElement>('#filter-digits')!
    this.stopwordsCheckbox = details.querySelector<HTMLInputElement>('#filter-stopwords')!
    this.smartMergeCheckbox = details.querySelector<HTMLInputElement>('#filter-smart-merge')!
    this.customMatText = details.querySelector<HTMLTextAreaElement>('#custom-mat')!
    this.customLaughText = details.querySelector<HTMLTextAreaElement>('#custom-laugh')!
    this.sliderTopN = details.querySelector<HTMLInputElement>('#slider-top-n')!
    this.sliderMinWeight = details.querySelector<HTMLInputElement>('#slider-min-weight')!
    this.legendCheckbox = details.querySelector<HTMLInputElement>('#show-legend')!
    this.topNVal = details.querySelector<HTMLElement>('#top-n-val')!
    this.minWeightVal = details.querySelector<HTMLElement>('#min-weight-val')!

    const onInputChange = () => {
      this.topNVal.textContent = this.sliderTopN.value
      this.minWeightVal.textContent = this.sliderMinWeight.value
      this.debouncedTriggerChange()
    }

    this.matCheckbox.addEventListener('change', onInputChange)
    this.laughCheckbox.addEventListener('change', onInputChange)
    this.techCheckbox.addEventListener('change', onInputChange)
    this.digitsCheckbox.addEventListener('change', onInputChange)
    this.stopwordsCheckbox.addEventListener('change', onInputChange)
    this.smartMergeCheckbox.addEventListener('change', onInputChange)
    this.customMatText.addEventListener('input', onInputChange)
    this.customLaughText.addEventListener('input', onInputChange)
    this.sliderTopN.addEventListener('input', onInputChange)
    this.sliderMinWeight.addEventListener('input', onInputChange)
    // UI-only: the hint must not trigger a worker recomputation.
    this.legendCheckbox.addEventListener('change', () => {
      for (const cb of this.legendCallbacks) {
        cb(this.legendCheckbox.checked)
      }
    })
  }

  setAuthors(authors: Array<{ id: AuthorId; name: string; wordCount?: number }>): void {
    this.authorColors.clear()
    this.authorsColors.innerHTML = ''
    this.modesContainer.innerHTML = ''

    // Together mode radio
    const togetherLabel = document.createElement('label')
    togetherLabel.innerHTML = '<input type="radio" name="view-mode" value="together" checked /> Вместе'
    togetherLabel.querySelector('input')!.addEventListener('change', () => {
      this.currentMode = { kind: 'together' }
      this.debouncedTriggerChange()
    })
    this.modesContainer.append(togetherLabel)

    // Author modes
    for (let i = 0; i < authors.length; i++) {
      const author = authors[i]
      const hex = NODE_COLORS[i] ?? hueToHex(137.5 * i)
      this.authorColors.set(author.id, hex)

      const label = document.createElement('label')
      label.innerHTML = `<input type="radio" name="view-mode" value="author-${author.id}" /> Только ${escapeHtml(author.name)}`
      label.querySelector('input')!.addEventListener('change', () => {
        this.currentMode = { kind: 'author', author: author.id }
        this.debouncedTriggerChange()
      })
      this.modesContainer.append(label)

      // Color picker
      const colorRow = document.createElement('div')
      colorRow.className = 'author-color-row'
      const legend = document.createElement('span')
      legend.append(`${author.name} — `)
      const countEl = document.createElement('span')
      countEl.className = 'num'
      countEl.textContent = String(author.wordCount ?? 0)
      legend.append(countEl, ' слов')
      const colorInput = document.createElement('input')
      colorInput.type = 'color'
      colorInput.value = hex
      colorRow.append(legend, ' ', colorInput)
      colorInput.addEventListener('input', () => {
        this.authorColors.set(author.id, colorInput.value)
        for (const cb of this.colorCallbacks) {
          cb(new Map(this.authorColors))
        }
      })
      this.authorsColors.append(colorRow)
    }

    // Cross mode (only if N <= 2)
    if (authors.length <= 2 && authors.length > 0) {
      const crossLabel = document.createElement('label')
      crossLabel.innerHTML = '<input type="radio" name="view-mode" value="cross" /> Пересечения'
      crossLabel.querySelector('input')!.addEventListener('change', () => {
        this.currentMode = { kind: 'cross' }
        this.debouncedTriggerChange()
      })
      this.modesContainer.append(crossLabel)
    }

    this.authorsGroup.hidden = authors.length === 0

    // Initial color notification
    for (const cb of this.colorCallbacks) {
      cb(new Map(this.authorColors))
    }
  }

  getCfg(): FilterCfg & ViewCfg {
    return {
      mat: this.matCheckbox.checked,
      laugh: this.laughCheckbox.checked,
      tech: this.techCheckbox.checked,
      digits: this.digitsCheckbox.checked,
      stopwords: this.stopwordsCheckbox.checked,
      smartMerge: this.smartMergeCheckbox.checked,
      customMat: parseCustom(this.customMatText.value),
      customLaugh: parseCustom(this.customLaughText.value),
      topN: Number(this.sliderTopN.value),
      minWeight: Number(this.sliderMinWeight.value),
      mode: this.currentMode,
    }
  }

  onChange(cb: ControlsCallback): void {
    this.changeCallbacks.push(cb)
  }

  onColorChange(cb: ColorChangeCallback): void {
    this.colorCallbacks.push(cb)
  }

  onLegendChange(cb: (visible: boolean) => void): void {
    this.legendCallbacks.push(cb)
    cb(this.legendCheckbox.checked)
  }
}

let controlsInstance: Controls | null = null

export function renderControls(root: HTMLElement): Controls {
  if (!controlsInstance) {
    controlsInstance = new Controls(root)
  }
  return controlsInstance
}
