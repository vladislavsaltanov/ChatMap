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
  // Шесть октав: крупные доли + детальная рвань края (реф 2, NOISE)
  const oct = [2, 3, 5, 8, 12, 16]
  const wts = [0.4, 0.24, 0.14, 0.1, 0.07, 0.05]
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
        // Распыление крупным кулаком (отзыв на «рядом только чанки»):
        // сильнее отталкивание, слабее центр и воздух в коллизиях ниже.
        scalingRatio: 18000,
        gravity: 0.00015,
        edgeWeightInfluence: 2.0,
        strongGravityMode: false,
        slowDown: 1,
      },
    })
  }

  // Radialize по степени (аналог d3 forceRadial): угол — семантика FA2,
  // радиус — ранг степени. Ядро — топ-хабы, fringe — мелочь. Мягкий бленд
  // к кольцу ранга, детерминировано (ранг + id, без RNG).
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
    let maxR = 0
    graph.forEachNode((n) => {
      const a = graph.getNodeAttributes(n)
      maxR = Math.max(maxR, Math.hypot(a.x - cx, a.y - cy))
    })
    const R = Math.max(maxR, 1)
    graph.forEachNode((n) => {
      const a = graph.getNodeAttributes(n)
      const t = (rankOf.get(n) ?? 0) / Math.max(1, graph.order - 1)
      // Корень — равномерность по площади: линейный ранг втискивал полграфа
      // в 22% площади диска (ядро давилось). Так плотность равномерна везде.
      // Прицельный радиус дышит шумом формы (реф 2): амплитуда растёт к fringe,
      // бленд к кольцу у fringe мягче — контур плоскости выходит неровным.
      const dx = a.x - cx
      const dy = a.y - cy
      const d = Math.hypot(dx, dy) || 1
      const wobble = shapeNoise(Math.atan2(dy, dx), shapePhases)
      const target = R * (0.06 + 0.94 * Math.sqrt(t)) * (1 + 0.75 * wobble * (0.25 + 0.75 * t))
      const blend = 0.55 - 0.25 * t
      const nr = d + (target - d) * blend
      graph.setNodeAttribute(n, 'x', cx + (dx / d) * nr)
      graph.setNodeAttribute(n, 'y', cy + (dy / d) * nr)
    })
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
    // Пропорциональный padding; дефолт resolveCollisions равномерный — тест
    // на separation не трогаем. Воздух между всеми пузырями, не только хабами.
    const padScale = (s: number): number => 18 * Math.min(1, Math.max(0.3, s / 24))
    // Крупным графам — больше проходов: 30 итераций 600 больших пузырей не расталкивают.
    // (collisionIterationsForCount не трогаем — его значения зафиксированы тестами.)
    const passes = Math.max(collisionIterationsForCount(positionedNodes.length), positionedNodes.length > 400 ? 60 : 0)
    resolveCollisions(positionedNodes, 6, passes, scaleFactor, padScale)
  }

  const positions = new Map<number, { x: number; y: number }>()
  for (const p of positionedNodes) {
    positions.set(p.id, { x: p.x, y: p.y })
  }

  return { positions, iterationsDone: iterations }
}
