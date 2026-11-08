import { armsFor, bundleEdges, edgeAlpha, nodeFitSize, phaseFor } from './geometry'
import { getLruCache, layout, setLruCache } from './graph'
import { parse } from './parse'
import { pruneBackbone, select, type ViewMode } from './select'
import { PipelineCache } from './tally'
import type {
  AuthorId,
  ChatExport,
  FilterCfg,
  WorkerIn,
  WorkerNode,
  WorkerOut,
} from './types'

let chat: ChatExport | null = null
const positionsCache = new Map<string, { x: number; y: number }>()
const MAX_POS_CACHE = 2000
let pipelineCache = new PipelineCache()

const DEFAULT_FILTER_CFG: FilterCfg = {
  mat: false,
  laugh: false,
  tech: false,
  digits: false,
  customMat: [],
  customLaugh: [],
  smartMerge: false,
  topN: 600,
  minWeight: 0,
}

let currentFilterCfg: FilterCfg = { ...DEFAULT_FILTER_CFG }
let currentViewMode: ViewMode = { kind: 'together' }

function send(msg: WorkerOut) {
  self.postMessage(msg)
}

function runPipeline(fullRun: boolean, authorNames?: Map<AuthorId, string>) {
  if (!chat) return

  const cfg = currentFilterCfg
  // cache hits skip the stages they reuse, so their ticks never show
  const { ia, tallyResult, merged } = pipelineCache.resolve(chat, cfg, {
    onTokenizeStart: () => send({ type: 'progress', done: 35, total: 100, stage: 'Токенизация и фильтрация...' }),
    onTokenizeProgress: (doneMsgs, totalMsgs) =>
      send({
        type: 'progress',
        done: 35 + Math.round((doneMsgs / totalMsgs) * 20),
        total: 100,
        stage: `Токенизация: ${doneMsgs} / ${totalMsgs} сообщ.`,
      }),
    onTallyStart: () => send({ type: 'progress', done: 60, total: 100, stage: 'Подсчёт частот и связей...' }),
    onMergeStart: () => send({ type: 'progress', done: 70, total: 100, stage: 'Умные склейки слов...' }),
  })

  // 'ready' needs the tallied counts, so it goes out here (full run only) and before any 'map'
  if (fullRun && authorNames) {
    const wordCounts = new Map<AuthorId, number>()
    for (const tokenAuthors of tallyResult.counts.values()) {
      for (const [authorId, cnt] of tokenAuthors) {
        wordCounts.set(authorId, (wordCounts.get(authorId) || 0) + cnt)
      }
    }
    send({
      type: 'ready',
      authors: Array.from(authorNames.entries()).map(([id, name]) => ({
        id,
        name,
        wordCount: wordCounts.get(id) || 0,
      })),
      counts: { messages: chat.messages.length },
    })
  }

  send({ type: 'progress', done: 75, total: 100, stage: 'Выборка узлов и рёбер...' })
  const selection = select(
    tallyResult,
    { mode: currentViewMode, topN: cfg.topN, minWeight: cfg.minWeight },
    merged
  )

  let minCount = Infinity
  for (const n of selection.nodes) {
    if (n.count < minCount) minCount = n.count
  }
  if (minCount === Infinity) minCount = 1

  // Pre-calculate best word form and cell sizes so layout spaces them properly
  const nodeInfoMap = new Map<number, { bestForm: string; forms: Array<[string, number]>; size: number }>()
  for (const n of selection.nodes) {
    const formMap = ia.forms.get(n.id)
    let bestForm = ia.getCanon(n.id) || String(n.id)
    let bestCount = 0

    const formsList: Array<[string, number]> = []
    if (formMap) {
      for (const [form, cnt] of formMap) {
        if (cnt > bestCount) {
          bestCount = cnt
          bestForm = form
        }
      }
      formsList.push(...Array.from(formMap.entries()).sort((a, b) => b[1] - a[1]))
    }

    const size = nodeFitSize(bestForm, n.count, selection.maxCount, minCount)
    nodeInfoMap.set(n.id, { bestForm, forms: formsList, size })
  }

  send({ type: 'progress', done: 85, total: 100, stage: 'Укладка графа (ForceAtlas2)...' })
  const layoutNodes = selection.nodes.map((n) => {
    const canonStr = ia.getCanon(n.id) || String(n.id)
    const info = nodeInfoMap.get(n.id)
    return {
      id: n.id,
      size: info?.size,
      prevXY: getLruCache(positionsCache, canonStr),
    }
  })

  // Serrano disparity backbone; every node keeps its 2 strongest edges
  const backboneEdges = pruneBackbone(selection.edges, selection.nodes.length)

  const layoutResult = layout(layoutNodes, backboneEdges, {
    seed: 1337,
    fullRun,
    onStage: (done, stage) => send({ type: 'progress', done, total: 100, stage }),
  })

  for (const [id, pos] of layoutResult.positions) {
    const canonStr = ia.getCanon(id) || String(id)
    setLruCache(positionsCache, canonStr, pos, MAX_POS_CACHE)
  }

  send({ type: 'progress', done: 95, total: 100, stage: 'Формирование карты...' })
  const nodes: WorkerNode[] = []
  const forms = new Map<number, Array<[string, number]>>()
  const posList = selection.nodes.map((n) => {
    const p = layoutResult.positions.get(n.id) || { x: 0, y: 0 }
    return { id: n.id, x: p.x, y: p.y }
  })
  const bundles = bundleEdges(posList, backboneEdges, selection.maxWeight)

  for (const n of selection.nodes) {
    const info = nodeInfoMap.get(n.id)!
    if (info.forms.length > 0) {
      forms.set(n.id, info.forms)
    }

    const pos = layoutResult.positions.get(n.id) || { x: 0, y: 0 }
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

    const arms = armsFor(posList, backboneEdges, n.id)
    nodes.push({
      id: n.id,
      label: info.bestForm,
      canon: ia.getCanon(n.id) || String(n.id),
      x: pos.x,
      y: pos.y,
      size: info.size,
      count: n.count,
      authorLead,
      phase: phaseFor(n.id),
      arm0: arms[0],
      arm1: arms[1],
      arm2: arms[2],
      arm3: arms[3],
      arm4: arms[4],
    })
  }

  send({
    type: 'map',
    nodes,
    edges: backboneEdges.map((e, i) => ({
      ...e,
      alpha: edgeAlpha(e.weight, selection.maxWeight),
      bead: selection.maxWeight > 0 ? Math.min(1, e.weight / selection.maxWeight) : 0,
      tract: bundles[i].tract,
      bundle: bundles[i].bundle,
      rank: bundles[i].rank,
      tractRank: bundles[i].tractRank,
    })),
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
      if (chat.warn) send({ type: 'warn', message: chat.warn })
      pipelineCache = new PipelineCache()
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

      runPipeline(true, authorMap)
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
