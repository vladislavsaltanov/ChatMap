import { isStopword, matchesLaugh, matchesMat } from './filters'
import { nodeSize } from './geometry'
import { layout } from './graph'
import { Intern } from './intern'
import { parse } from './parse'
import { select, type ViewMode } from './select'
import { smartMerge } from './smart-merge'
import { buildUnits, tally } from './tally'
import type {
  AuthorId,
  ChatExport,
  FilterCfg,
  Tok,
  WorkerIn,
  WorkerNode,
  WorkerOut,
} from './types'

let chat: ChatExport | null = null
const positionsCache = new Map<string, { x: number; y: number }>()

const DEFAULT_FILTER_CFG: FilterCfg = {
  mat: false,
  laugh: false,
  tech: false,
  digits: false,
  customMat: [],
  customLaugh: [],
  smartMerge: false,
  topN: 400,
  minWeight: 0,
}

let currentFilterCfg: FilterCfg = { ...DEFAULT_FILTER_CFG }
let currentViewMode: ViewMode = { kind: 'together' }

function send(msg: WorkerOut) {
  self.postMessage(msg)
}

function runPipeline(fullRun: boolean) {
  if (!chat) return

  send({ type: 'progress', done: 40, total: 100, stage: 'Токенизация и фильтрация...' })
  const ia = new Intern()
  const cfg = currentFilterCfg

  const dropTok = (tok: Tok): boolean => {
    if (!cfg.tech && tok.cls === 'tech') return true
    if (!cfg.digits && tok.cls === 'digits') return true
    if (isStopword(tok.word)) return true
    if (!cfg.mat && matchesMat(tok.word, cfg.customMat)) return true
    if (!cfg.laugh && matchesLaugh(tok.word, cfg.customLaugh)) return true
    return false
  }

  const rawUnits = buildUnits(chat, ia, dropTok)
  send({ type: 'progress', done: 60, total: 100, stage: 'Подсчёт частот и связей...' })
  const tallyResult = tally(rawUnits)

  let merged: Map<number, number> | undefined
  if (cfg.smartMerge) {
    send({ type: 'progress', done: 70, total: 100, stage: 'Умные склейки слов...' })
    const freq = new Map<number, number>()
    const idWords = new Map<number, string>()

    for (const [id, authorMap] of tallyResult.counts) {
      let sum = 0
      for (const cnt of authorMap.values()) sum += cnt
      freq.set(id, sum)

      const cls = ia.getCls(id)
      if (cls === 'plain') {
        const word = ia.getCanon(id)
        if (word) idWords.set(id, word)
      }
    }

    merged = smartMerge(freq, idWords)
  }

  send({ type: 'progress', done: 75, total: 100, stage: 'Выборка узлов и рёбер...' })
  const selection = select(
    tallyResult,
    { mode: currentViewMode, topN: cfg.topN, minWeight: cfg.minWeight },
    merged
  )

  send({ type: 'progress', done: 85, total: 100, stage: 'Укладка графа (ForceAtlas2)...' })
  const layoutNodes = selection.nodes.map((n) => {
    const canonStr = ia.getCanon(n.id) || String(n.id)
    return {
      id: n.id,
      prevXY: positionsCache.get(canonStr),
    }
  })

  const layoutResult = layout(layoutNodes, selection.edges, {
    seed: 1337,
    fullRun,
  })

  for (const [id, pos] of layoutResult.positions) {
    const canonStr = ia.getCanon(id) || String(id)
    positionsCache.set(canonStr, pos)
  }

  send({ type: 'progress', done: 95, total: 100, stage: 'Формирование карты...' })
  const nodes: WorkerNode[] = []
  const forms = new Map<number, Array<[string, number]>>()

  let minCount = Infinity
  for (const n of selection.nodes) {
    if (n.count < minCount) minCount = n.count
  }
  if (minCount === Infinity) minCount = 1

  for (const n of selection.nodes) {
    const formMap = ia.forms.get(n.id)
    let bestForm = ia.getCanon(n.id) || String(n.id)
    let bestCount = 0

    if (formMap) {
      for (const [form, cnt] of formMap) {
        if (cnt > bestCount) {
          bestCount = cnt
          bestForm = form
        }
      }
      forms.set(
        n.id,
        Array.from(formMap.entries()).sort((a, b) => b[1] - a[1])
      )
    }

    const pos = layoutResult.positions.get(n.id) || { x: 0, y: 0 }
    const size = nodeSize(n.count, selection.maxCount, minCount)

    let authorLead: AuthorId = 0
    let leadCount = 0
    const authorMap = tallyResult.counts.get(n.id)
    if (authorMap) {
      for (const [authorId, cnt] of authorMap) {
        if (cnt > leadCount) {
          leadCount = cnt
          authorLead = authorId
        }
      }
    }

    nodes.push({
      id: n.id,
      label: bestForm,
      x: pos.x,
      y: pos.y,
      size,
      count: n.count,
      authorLead,
    })
  }

  send({
    type: 'map',
    nodes,
    edges: selection.edges,
    maxCount: selection.maxCount,
    maxWeight: selection.maxWeight,
    forms,
  })
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data
  try {
    if (msg.type === 'open') {
      send({ type: 'progress', done: 5, total: 100, stage: 'Чтение JSON...' })
      chat = parse(msg.json)
      send({ type: 'progress', done: 30, total: 100, stage: 'Определение авторов...' })

      const authorMap = new Map<AuthorId, string>()
      if (chat.authors) {
        for (const [id, name] of chat.authors) {
          authorMap.set(id, name)
        }
      }
      for (const m of chat.messages) {
        if (!authorMap.has(m.authorId)) {
          authorMap.set(m.authorId, `Участник ${m.authorId}`)
        }
      }

      send({
        type: 'ready',
        authors: Array.from(authorMap.entries()).map(([id, name]) => ({ id, name })),
        counts: { messages: chat.messages.length },
      })

      runPipeline(true)
      send({ type: 'progress', done: 100, total: 100, stage: 'Готово' })
    } else if (msg.type === 'update') {
      currentFilterCfg = {
        mat: msg.cfg.mat,
        laugh: msg.cfg.laugh,
        tech: msg.cfg.tech,
        digits: msg.cfg.digits,
        customMat: msg.cfg.customMat,
        customLaugh: msg.cfg.customLaugh,
        smartMerge: msg.cfg.smartMerge,
        topN: msg.cfg.topN,
        minWeight: msg.cfg.minWeight,
      }
      currentViewMode = msg.cfg.mode
      runPipeline(false)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    send({ type: 'error', message })
  }
}
