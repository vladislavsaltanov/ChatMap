import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'

// shortcut: spans >6800 get capped spacing and may overlap; upgrade if wide graphs look packed
const MAX_SCALE_FACTOR = 8

// Map keeps insertion order, so delete+set moves a key to the most-recent end.
export function getLruCache<K, V>(map: Map<K, V>, key: K): V | undefined {
  if (!map.has(key)) return undefined
  const value = map.get(key) as V
  map.delete(key)
  map.set(key, value)
  return value
}

export function setLruCache<K, V>(map: Map<K, V>, key: K, value: V, maxEntries = 2000): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > Math.max(maxEntries, 0)) map.delete(map.keys().next().value as K)
}

export type LayoutNodeInput = {
  id: number
  size?: number
  prevXY?: { x: number; y: number }
}

export type LayoutEdgeInput = {
  a: number
  b: number
  weight: number
}

export type LayoutOpts = {
  seed: number
  fullRun: boolean
  iterations?: number
  onStage?: (done: number, stage: string) => void
}

export type LayoutResult = {
  positions: Map<number, { x: number; y: number }>
  iterationsDone: number
}

function createRng(seed: number) {
  let s = seed >>> 0
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

// Гармонический шум формы плоскости (реф 2, NOISE): три нечётные октавы угла.
// Фазы от seed: тот же граф — тот же неровный контур, детерминировано. |n| <= 1.
export function shapeNoise(angle: number, phases: readonly number[]): number {
  // Восемь октав: крупные доли + детальная рвань края (реф 2, NOISE)
  const oct = [2, 3, 5, 8, 12, 16, 21, 27]
  const wts = [0.38, 0.23, 0.13, 0.09, 0.07, 0.05, 0.03, 0.02]
  let n = 0
  for (let i = 0; i < oct.length; i++) {
    n += wts[i] * Math.sin(oct[i] * angle + (phases[i] ?? 0))
  }
  return n
}

// shortcut: 30 passes above 400 nodes may leave overlaps; upgrade if large graphs look packed
export function collisionIterationsForCount(nodeCount: number): number {
  return nodeCount <= 400 ? 80 : 30
}

export function resolveCollisions(
  nodes: Array<{ id: number; x: number; y: number; size?: number }>,
  padding: number = 8,
  maxIterations: number = 80,
  scaleFactor: number = 1,
  // padScale: плотность fringe. null = равномерный padding (дефолт, тесты).
  // Пропорциональный размеру даёт плотные скопления мелочи и воздух у хабов.
  padScale: ((size: number) => number) | null = null
): void {
  const count = nodes.length
  if (count <= 1) return
  const scale = Math.min(scaleFactor, MAX_SCALE_FACTOR)
  const padFor = (size: number | undefined): number => {
    const s = size || 20
    return padScale ? padScale(s) : padding
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    let hasCollision = false
    let maxShift = 0

    for (let i = 0; i < count; i++) {
      const a = nodes[i]
      const ra = (a.size || 20) * scale + padFor(a.size) * 0.5

      for (let j = i + 1; j < count; j++) {
        const b = nodes[j]
        const rb = (b.size || 20) * scale + padFor(b.size) * 0.5
        const minDist = ra + rb

        let dx = b.x - a.x
        let dy = b.y - a.y
        let distSq = dx * dx + dy * dy

        if (distSq < minDist * minDist) {
          hasCollision = true
          let dist = Math.sqrt(distSq)
          if (dist < 0.001) {
            dx = ((i * 17 + j * 31) % 10 - 5) || 1
            dy = ((i * 23 + j * 13) % 10 - 5) || 1
            dist = Math.sqrt(dx * dx + dy * dy)
          }

          const overlap = minDist - dist
          if (overlap > maxShift) {
            maxShift = overlap
          }

          const nx = dx / dist
          const ny = dy / dist
          const shift = overlap * 0.5

          a.x -= nx * shift
          a.y -= ny * shift
          b.x += nx * shift
          b.y += ny * shift
        }
      }
    }

    if (!hasCollision || maxShift < 0.2) {
      break
    }
  }
}

export function layout(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  opts: LayoutOpts
): LayoutResult {
  const graph = new Graph()
  const rng = createRng(opts.seed)
  const spread = Math.max(500, Math.sqrt(nodes.length) * 150)
  // Фазы шума формы: до расходования rng на позиции, для устойчивого детерминизма
  const shapePhases = [
    rng() * Math.PI * 2,
    rng() * Math.PI * 2,
    rng() * Math.PI * 2,
    rng() * Math.PI * 2,
    rng() * Math.PI * 2,
    rng() * Math.PI * 2,
    rng() * Math.PI * 2,
    rng() * Math.PI * 2,
  ]

  // Радиальный degree-aware старт: хабы рождаются в ядре, мелочь — на fringe.
  // Угол — золотая спираль + seeded jitter, радиус убывает со степенью узла.
  // Детерминировано тем же seed; prevXY-кэш для инкремента не трогаем.
  const degree = new Map<string, number>()
  for (const edge of edges) {
    const a = String(edge.a)
    const b = String(edge.b)
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  }
  let maxDegree = 0
  for (const d of degree.values()) if (d > maxDegree) maxDegree = d
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

  for (const [index, node] of nodes.entries()) {
    let x: number
    let y: number
    if (!opts.fullRun && node.prevXY) {
      x = node.prevXY.x
      y = node.prevXY.y
    } else {
      const deg = degree.get(String(node.id)) ?? 0
      const t = maxDegree > 0 ? deg / maxDegree : 0
      const angle = index * GOLDEN_ANGLE + (rng() - 0.5) * 0.6
      // Стартовый радиус дышит той же гармоникой: рождения — уже не ровное кольцо
      const radius =
        (spread / 2) *
        (1 - 0.85 * Math.pow(t, 0.7)) *
        (1 + 0.35 * shapeNoise(angle, shapePhases)) *
        (0.9 + 0.2 * rng())
      x = Math.cos(angle) * radius
      y = Math.sin(angle) * radius
    }
    graph.addNode(String(node.id), { x, y, size: node.size || 20 })
  }

  const existingNodes = new Set(nodes.map((n) => String(n.id)))
  for (const edge of edges) {
    const a = String(edge.a)
    const b = String(edge.b)
    if (existingNodes.has(a) && existingNodes.has(b) && a !== b) {
      if (!graph.hasEdge(a, b)) {
        graph.addEdge(a, b, { weight: edge.weight })
      }
    }
  }

  const iterations = opts.iterations !== undefined
    ? opts.iterations
    : opts.fullRun ? 1200 : 20

  if (iterations > 0 && graph.order > 1) {
    forceAtlas2.assign(graph, {
      iterations,
      settings: {
        // lin-lin: притяжение пропорционально дистанции — rim-старт сходится
        // за разумные итерации (тест «сильная связь ближе слабой»). Тугость
        // кластеров добираем edgeWeightInfluence, а не linLog: у lin-log
        // логарифмическое притяжение, дальние узлы стягиваются слишком медленно.
        linLogMode: false,
        // NOTE: adjustSizes в graphology-FA2 размеры игнорирует (апстрим-баг #404);
        // перекрытия крупных пузырей честно разруливает resolveCollisions ниже.
        adjustSizes: true,
        // OAD=true: хабы слабее притягивают и выдавливаются к границам —
        // шар распадается на доли, плоскость заполняется (Gephi: Dissuade Hubs).
        // Ядро держит radialize-постпасс ниже, так что тест (e) не страдает.
        outboundAttractionDistribution: true,
        barnesHutOptimize: true,
        barnesHutTheta: 0.5,
        // Распыление «как нейросеть» (отзыв «больше дисперсии»): редкие чанки
        // в разреженном поле — сильное отталкивание и почти нулевая гравитация.
        scalingRatio: 22000,
        gravity: 0.0001,
        edgeWeightInfluence: 2.0,
        strongGravityMode: false,
        slowDown: 1,
      },
    })
  }

  // Форма плоскости (после FA2): вытяжка по сеяной оси + выступы/впадины от
  // многооктавного углового шума. Ранговое кольцо убрано совсем — оно собирало
  // арки и кругл活 силуэт. Амплитуда шума растёт к fringe (ядро держит чанки)
  // и масштабируется размером карты: на карманных графах шум читается как
  // случайность, а не как форма.
  if (iterations > 0 && graph.order > 2) {
    const rank = [...graph.mapNodes((n) => n)]
      .map((n) => [n, graph.degree(n)] as const)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([n]) => n)
    const rankOf = new Map(rank.map((n, i) => [n, i]))
    let cx = 0
    let cy = 0
    graph.forEachNode((n) => {
      const a = graph.getNodeAttributes(n)
      cx += a.x
      cy += a.y
    })
    cx /= graph.order
    cy /= graph.order
    // радиус связной части — якорь для изолированных узлов (их FA2 уносит прочь)
    let maxR = 0
    graph.forEachNode((n) => {
      if (graph.degree(n) === 0) return
      const a = graph.getNodeAttributes(n)
      maxR = Math.max(maxR, Math.hypot(a.x - cx, a.y - cy))
    })
    maxR = Math.max(maxR, 1)
    // 1) вытяжка: растянуть вдоль сеяной оси, сжать поперёк (объём ~сохраняем)
    const stretchAngle = rng() * Math.PI
    const k = 1.45
    const ux = Math.cos(stretchAngle)
    const uy = Math.sin(stretchAngle)
    graph.forEachNode((n) => {
      const a = graph.getNodeAttributes(n)
      let dx = a.x - cx
      let dy = a.y - cy
      const d0 = Math.hypot(dx, dy) || 1
      if (graph.degree(n) === 0) {
        dx = (dx / d0) * maxR * 1.02
        dy = (dy / d0) * maxR * 1.02
      }
      const a1 = dx * ux + dy * uy
      const a2 = -dx * uy + dy * ux
      const sx = a1 * k * ux + a2 * (1 / k) * -uy
      const sy = a1 * k * uy + a2 * (1 / k) * ux
      // 2) выступы/впадины: угловой шум радиуса, амплитуда растёт к fringe
      const d1 = Math.hypot(sx, sy) || 1
      const t = (rankOf.get(n) ?? 0) / Math.max(1, graph.order - 1)
      const amp = (0.35 + 0.75 * t) * Math.min(1, graph.order / 20)
      const r2 = d1 * (1 + amp * shapeNoise(Math.atan2(sy, sx), shapePhases))
      graph.setNodeAttribute(n, 'x', cx + (sx / d1) * r2)
      graph.setNodeAttribute(n, 'y', cy + (sy / d1) * r2)
    })

    // 3) Доли-«лобы»: топ-хабов вытолкать к периметру вместе с соседями,
    // иначе FA2 складывает все хабы в ядро-blob. Лобы расходятся, в середине —
    // void, силуэт рвётся. Только крупные графы: на карманных хаб держит центр
    // (тесты e/g), там рвань не нужна.
    if (graph.order >= 40) {
      let ncx = 0
      let ncy = 0
      graph.forEachNode((n) => {
        const a = graph.getNodeAttributes(n)
        ncx += a.x
        ncy += a.y
      })
      ncx /= graph.order
      ncy /= graph.order
      let maxR2 = 0
      graph.forEachNode((n) => {
        if (graph.degree(n) === 0) return
        const a = graph.getNodeAttributes(n)
        maxR2 = Math.max(maxR2, Math.hypot(a.x - ncx, a.y - ncy))
      })
      const shifts = new Map<string, { dx: number; dy: number }>()
      const addShift = (k: string, ux: number, uy: number, push: number, w: number) => {
        const s = shifts.get(k) ?? { dx: 0, dy: 0 }
        s.dx += ux * push * w
        s.dy += uy * push * w
        shifts.set(k, s)
      }
      rank.slice(0, 12).forEach((n, i) => {
        const a = graph.getNodeAttributes(n)
        const dx = a.x - ncx
        const dy = a.y - ncy
        const d = Math.hypot(dx, dy) || 1
        const target = maxR2 * (0.88 - i * 0.012)
        if (d >= target) return
        const ux = dx / d
        const uy = dy / d
        const push = target - d
        addShift(n, ux, uy, push, 1)
        for (const nb of graph.neighbors(n)) addShift(nb, ux, uy, push, 0.6)
        for (const nb of graph.neighbors(n)) {
          for (const n2 of graph.neighbors(nb)) {
            if (n2 !== n) addShift(n2, ux, uy, push, 0.25)
          }
        }
      })
      for (const [n, s] of shifts) {
        const a = graph.getNodeAttributes(n)
        graph.setNodeAttribute(n, 'x', a.x + s.dx)
        graph.setNodeAttribute(n, 'y', a.y + s.dy)
      }
    }
  }

  const positionedNodes: Array<{ id: number; x: number; y: number; size?: number }> = []
  for (const node of nodes) {
    const attrs = graph.getNodeAttributes(String(node.id))
    positionedNodes.push({
      id: node.id,
      x: attrs.x,
      y: attrs.y,
      size: node.size,
    })
  }

  if (iterations > 0) {
    opts.onStage?.(92, 'Разведение пересечений...')
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const n of positionedNodes) {
      if (n.x < minX) minX = n.x
      if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y
      if (n.y > maxY) maxY = n.y
    }
    const span = Math.max(maxX - minX, maxY - minY, 1000)
    const scaleFactor = Math.min(MAX_SCALE_FACTOR, Math.max(1, span / 850))
    // Паддинг растёт вместе с дисперсией карты (×scaleFactor): зазор между краями
    // узлов — фиксированная доля мира. Раньше паддинг был в абсолютных юнитах —
    // span вырос от дисперсии, и зазор ужался почти в ноль пикселей.
    const padScale = (s: number): number => 26 * scaleFactor * Math.min(1, Math.max(0.45, s / 24))
    // Крупным графам — больше проходов: с большим зазором 600 узлов не
    // расходятся за 60. (collisionIterationsForCount не трогаем — тестами зафиксирован.)
    const passes = Math.max(collisionIterationsForCount(positionedNodes.length), positionedNodes.length > 400 ? 120 : 0)
    resolveCollisions(positionedNodes, 6, passes, scaleFactor, padScale)
  }

  const positions = new Map<number, { x: number; y: number }>()
  for (const p of positionedNodes) {
    positions.set(p.id, { x: p.x, y: p.y })
  }

  return { positions, iterationsDone: iterations }
}
