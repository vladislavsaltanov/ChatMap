import { armsFromIndex, buildArmsIndex, bundleEdges, edgeAlpha, footprintScale, footprintSize, nodeFitSize, phaseFor } from './geometry'
import { getLruCache, layout, setLruCache, type LayoutNodeInput, type LayoutResult } from './graph'
import type { Intern } from './intern'
import { parse } from './parse'
import { pruneSortedBackbone, select, type Selection, type SelectionEdge, type ViewCfg } from './select'
import { PipelineCache, type PipelineCallbacks, type TallyResult } from './tally'
import type {
  AuthorId,
  ChatExport,
  FilterCfg,
  MapMsg,
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
  stopwords: false,
  customMat: [],
  customLaugh: [],
  smartMerge: false,
}

let currentFilterCfg: FilterCfg = { ...DEFAULT_FILTER_CFG }
let currentViewCfg: ViewCfg = { mode: { kind: 'together' }, topN: 600, minWeight: 0 }

function send(msg: WorkerOut) {
  self.postMessage(msg)
}

// New file = new identity space: stale canon->position entries would
// pin same-spelled words of the new chat to the old chat's coordinates.
function resetWorkerState(): void {
  chat = null
  pipelineCache = new PipelineCache()
  positionsCache.clear()
}

type NodeInfo = { bestForm: string; forms: Array<[string, number]>; size: number }
type PipelineData = { ia: Intern; tallyResult: TallyResult; merged?: Map<number, number> }

function resolveData(chat: ChatExport, cfg: FilterCfg, callbacks: PipelineCallbacks): PipelineData {
  return pipelineCache.resolve(chat, cfg, callbacks)
}

function buildLayoutInput(
  selection: Selection,
  ia: Intern,
  positionsCache: Map<string, { x: number; y: number }>,
): { layoutNodes: LayoutNodeInput[]; backboneEdges: SelectionEdge[]; nodeInfoMap: Map<number, NodeInfo> } {
  let minCount = Infinity
  for (const n of selection.nodes) {
    if (n.count < minCount) minCount = n.count
  }
  if (minCount === Infinity) minCount = 1

  // Pre-calculate best word form and cell sizes so layout spaces them properly
  const nodeInfoMap = new Map<number, NodeInfo>()
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

  // Screen-area budget: the same px size law cannot serve a 33-word and a
  // 1000-word map. Rescale the whole distribution once — uniformly, so the size
  // hierarchy survives and only its on-screen scale adapts to the map size.
  const sizeScale = footprintScale([...nodeInfoMap.values()].map((info) => info.size))
  if (sizeScale < 1) {
    for (const info of nodeInfoMap.values()) {
      info.size = Math.round(footprintSize(info.size, sizeScale) * 10) / 10
    }
  }

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
  // Selection edges arrive sorted weight-desc, so the backbone skips its own resort.
  const backboneEdges = pruneSortedBackbone(selection.edges, selection.nodes.length)

  return { layoutNodes, backboneEdges, nodeInfoMap }
}

function buildMapMessage(
  selection: Selection,
  layoutResult: LayoutResult,
  ia: Intern,
  tallyResult: TallyResult,
  backboneEdges: SelectionEdge[],
  nodeInfoMap: Map<number, NodeInfo>,
): MapMsg {
  const nodes: WorkerNode[] = []
  const forms = new Map<number, Array<[string, number]>>()
  const posList = selection.nodes.map((n) => {
    const p = layoutResult.positions.get(n.id) || { x: 0, y: 0 }
    return { id: n.id, x: p.x, y: p.y }
  })
  // Edge geometry is routed through the figure's own funnels: fibres of one
  // corridor share control points, so they land on top of each other and merge.
  const bundles = bundleEdges(posList, backboneEdges, selection.maxWeight, {
    ports: layoutResult.ports ?? new Map(),
    groupOf: layoutResult.groupOf ?? new Map(),
    // Fascicle identity lets intra-topic fibres share one trunk per stem instead of
    // fanning 200 individual curves out of the soma.
    stemOf: layoutResult.stemOf,
  })
  const armsIndex = buildArmsIndex(posList, backboneEdges)

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

    const arms = armsFromIndex(armsIndex, n.id)
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

  return {
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
  }
}

function runPipeline(fullRun: boolean, authorNames?: Map<AuthorId, string>) {
  if (!chat) return

  const cfg = currentFilterCfg
  // cache hits skip the stages they reuse, so their ticks never show
  const { ia, tallyResult, merged } = resolveData(chat, cfg, {
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
  const selection = select(tallyResult, currentViewCfg, merged)

  const { layoutNodes, backboneEdges, nodeInfoMap } = buildLayoutInput(selection, ia, positionsCache)

  send({ type: 'progress', done: 85, total: 100, stage: 'Раскладка карты...' })
  const layoutResult = layout(layoutNodes, backboneEdges, {
    seed: 1337,
    fullRun,
    onStage: (done, stage) => send({ type: 'progress', done, total: 100, stage }),
  })
  // Runtime stamp: proves which layout code the browser runs and what shape
  // it produced. Read it in DevTools console after reopening the export.
  {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of layoutResult.positions.values()) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    const aspect = (maxX - minX) / Math.max(1e-9, maxY - minY)
    console.log(
      `[chatmap-layout] leaf-P1 aspect hold 2.0: nodes=${layoutResult.positions.size} aspect=${aspect.toFixed(2)} fullRun=${fullRun}`,
    )
  }

  for (const [id, pos] of layoutResult.positions) {
    const canonStr = ia.getCanon(id) || String(id)
    setLruCache(positionsCache, canonStr, pos, MAX_POS_CACHE)
  }

  send({ type: 'progress', done: 95, total: 100, stage: 'Формирование карты...' })
  send(buildMapMessage(selection, layoutResult, ia, tallyResult, backboneEdges, nodeInfoMap))
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data
  try {
    if (msg.type === 'open') {
      resetWorkerState()
      send({ type: 'progress', done: 5, total: 100, stage: 'Чтение JSON...' })
      const nextChat = parse(new TextDecoder().decode(msg.buf))
      if (nextChat.warn) send({ type: 'warn', message: nextChat.warn })
      chat = nextChat
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
        stopwords: msg.cfg.stopwords,
        customMat: msg.cfg.customMat,
        customLaugh: msg.cfg.customLaugh,
        smartMerge: msg.cfg.smartMerge,
      }
      currentViewCfg = {
        mode: msg.cfg.mode,
        topN: msg.cfg.topN,
        minWeight: msg.cfg.minWeight,
      }
      runPipeline(false)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    send({ type: 'error', message })
  }
}
