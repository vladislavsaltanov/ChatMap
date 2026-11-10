import Graph from 'graphology'
import Sigma from 'sigma'
import { drawOnCanvas } from '@sigma/export-image'
import { coreFrac, edgeColor, edgeWidth, fisheyePoint, labelZoomRatio, phaseFor, renderedNodeSize, visualCoreRadius, type FisheyeConfig } from '../core/geometry'
import { resolveLabelBackdrops, resolveLabelBoxes, type LabelBox, type LabelCircle } from '../core/labels'
import { LEGEND_TEXT } from '../core/legend'
import type { AuthorId, MapMsg } from '../core/types'
import { buildNodeDetails, getLabelOverrides, NodePanel } from './nodepanel'
import { MAP_SIGMA_SETTINGS, MAP_SIGMA_STYLES } from './mapStyles'
import { DEFAULT_NODE_COLOR, NEURAL_PRIMITIVES, PLATE_COLOR, setNeuralTime } from './neural'
import { drawLegend } from './legend'
import { SubgraphAnimator } from './subgraphAnim'
import { SubgraphHighlight } from './subgraphHighlight'
import type { CustomEdgeState, CustomGraphState, CustomNodeState } from './mapStyles'

type ViewState = { x: number; y: number; ratio: number; angle: number }
const FLAT_VIEW: ViewState = { x: 0.5, y: 0.5, ratio: 1, angle: 0 }

export class MapView {
  private container: HTMLElement
  private hoverLine: HTMLElement
  private progressEl: HTMLElement
  private legendCanvas: HTMLCanvasElement
  private legendVisible = true
  private graph: Graph
  private renderer: Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState> | null = null
  private pinnedId: number | null = null
  private highlight: SubgraphHighlight
  private authorColors = new Map<AuthorId, string>()
  private nodePanel: NodePanel
  private lastMsg: MapMsg | null = null
  private subgraphKey: string | null = null
  private viewPending: ViewState | null = null
  private viewRaf: number | null = null
  private layoutRaf: number | null = null
  private idleTimer: number | null = null
  private animator = new SubgraphAnimator((v) => {
    this.renderer?.setGraphState({ dimAlpha: v.dim, focusAlpha: v.focus, releaseAlpha: v.release, enterAlpha: v.enter })
    this.renderer?.refresh({ skipIndexation: true })
  })

  private labelLine(id: number): string {
    const key = String(id)
    if (!this.graph.hasNode(key)) return 'слово · 0'
    const attrs = this.graph.getNodeAttributes(key)
    return `${attrs.label} · ${attrs.count}`
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  // Hover/pin change marker sizes without moving the camera. Recompute the
  // collision sets on the next frame, once Sigma has refreshed display data.
  private scheduleLayout(): void {
    if (this.layoutRaf !== null) return
    this.layoutRaf = requestAnimationFrame(() => {
      this.layoutRaf = null
      const r = this.renderer
      if (r) this.applyView(r.getCamera().getState())
    })
  }

  // Grace window (50ms) prevents flicker and slow animation drag when mouse crosses gaps between adjacent words
  private scheduleIdle(): void {
    this.cancelIdleTimer()
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null
      if (this.pinnedId === null && this.subgraphKey !== null) {
        this.hoverLine.textContent = 'слово · 0'
        this.fadeToIdle()
      }
    }, 50)
  }

  // Smooth decay to idle state over 100-120ms when mouse leaves map
  private fadeToIdle(): void {
    this.cancelIdleTimer()
    this.subgraphKey = null
    this.animator.to('focus', 0, 100)
    this.animator.to('dim', 0, 120, () => {
      if (this.subgraphKey === null) {
        this.highlight.clear(this.renderer)
        this.renderer?.setGraphState({ hasActiveSubgraph: false })
        this.renderer?.refresh({ skipIndexation: true })
        this.scheduleLayout()
      }
    })
  }

  // New map must not inherit hover/pin visuals: drop highlight states,
  // snap tweens to zero, and clear the active-subgraph graph state.
  private resetInteractionState(): void {
    this.highlight.clear(this.renderer)
    this.animator.jump('dim', 0)
    this.animator.jump('focus', 0)
    this.animator.jump('release', 0)
    this.pinnedId = null
    this.subgraphKey = null
    this.renderer?.setGraphState({
      hasActiveSubgraph: false,
      dimAlpha: 0,
      focusAlpha: 0,
      releaseAlpha: 0,
      pinActive: false,
    })
  }

  // Focus ego-subgraph: snaps instantly (1 frame) when moving between nodes, avoids animation queue latency
  private focusSubgraph(key: string, topN: number): void {
    this.cancelIdleTimer()
    const alreadyActive = this.animator.value('dim') > 0.4
    this.highlight.flushReleased(this.renderer)
    this.highlight.swap(this.renderer, key, topN)

    if (alreadyActive) {
      // Rapid hover across nodes: snap active subgraph in 1 frame without animation queue lag
      this.animator.jump('dim', 1)
      this.animator.jump('focus', 1)
      this.animator.jump('release', 0)
    } else {
      // Initial entry from idle: snappy 90ms entry
      this.animator.jump('release', 1)
      this.animator.to('release', 0, 90, () => this.highlight.flushReleased(this.renderer))
      this.animator.to('focus', 1, 90)
      this.animator.to('dim', 1, 100)
    }
    this.scheduleLayout()
  }

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="canvas" role="img" aria-label="Карта слов">
        <canvas class="map-legend" role="img"></canvas>
        <div class="plate" aria-hidden="true">
          <i></i><i></i><i></i><i></i>
          <span>Карта слов · совместная встречаемость · лист 01</span>
        </div>
        <div class="map-progress" hidden></div>
      </div>
      <div class="map-controls">
        <button type="button" id="export-png" aria-label="Экспорт в PNG" class="num">PNG</button>
        <button type="button" id="zoom-in" aria-label="Приблизить">+</button>
        <button type="button" id="zoom-out" aria-label="Отдалить">−</button>
        <button type="button" id="zoom-reset" aria-label="В центр">⊙</button>
      </div>
      <p class="hover-line label">слово · 0</p>
    `

    this.container = root.querySelector<HTMLElement>('.canvas')!
    this.hoverLine = root.querySelector<HTMLElement>('.hover-line')!
    this.progressEl = root.querySelector<HTMLElement>('.map-progress')!
    this.legendCanvas = root.querySelector<HTMLCanvasElement>('.map-legend')!
    this.legendCanvas.setAttribute('aria-label', LEGEND_TEXT)
    new ResizeObserver(() => this.paintLegend()).observe(this.container)
    this.graph = new Graph()
    this.highlight = new SubgraphHighlight(this.graph)
    this.nodePanel = new NodePanel(root)
    this.nodePanel.onSelect((id) => this.pin(id === -1 ? null : id))
    this.nodePanel.onOverride((id, label) => {
      if (!this.renderer) return
      const key = String(id)
      if (this.graph.hasNode(key)) {
        this.graph.setNodeAttribute(key, 'label', label)
      }
      if (this.pinnedId === id) {
        this.hoverLine.textContent = this.labelLine(id)
      }
      this.renderer.refresh({ skipIndexation: true })
    })
    this.nodePanel.onPhoto(() => { void this.downloadNodePhoto() })

    const exportBtn = root.querySelector<HTMLButtonElement>('#export-png')!
    const zoomInBtn = root.querySelector<HTMLButtonElement>('#zoom-in')!
    const zoomOutBtn = root.querySelector<HTMLButtonElement>('#zoom-out')!
    const zoomResetBtn = root.querySelector<HTMLButtonElement>('#zoom-reset')!

    exportBtn.addEventListener('click', () => {
      if (!this.renderer) return
      void drawOnCanvas(this.renderer as unknown as Parameters<typeof drawOnCanvas>[0], {
        backgroundColor: 'rgba(0, 0, 0, 0)',
      }).then((graph) => {
        this.downloadCanvas(this.composePhoto(graph), 'chatmap.png')
      })
    })

    zoomInBtn.addEventListener('click', () => this.renderer?.getCamera().zoomIn({ duration: 260 }))
    zoomOutBtn.addEventListener('click', () => this.renderer?.getCamera().zoomOut({ duration: 260 }))
    zoomResetBtn.addEventListener('click', () => this.renderer?.getCamera().reset({ duration: 320 }))

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.pinnedId !== null) {
        this.pin(null)
      }
    })
  }

  // The legend canvas is the FIRST child of .canvas with z-index 0. Sigma
  // appends its WebGL layers later, so nodes and edges always paint over it.
  private paintLegend(): void {
    const c = this.legendCanvas
    const scale = window.devicePixelRatio || 1
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    if (this.legendVisible) drawLegend(ctx, width, height, scale)
  }

  setLegendVisible(visible: boolean): void {
    this.legendVisible = visible
    this.legendCanvas.hidden = !visible
    this.paintLegend()
  }

  // PNG order: plate -> legend -> graph. The graph comes last, so the hint is
  // strictly behind nodes and edges, exactly as on screen.
  private composePhoto(graph: HTMLCanvasElement): HTMLCanvasElement {
    const dims = this.renderer?.getDimensions()
    const scale = dims?.width ? graph.width / dims.width : window.devicePixelRatio || 1
    const out = document.createElement('canvas')
    out.width = graph.width
    out.height = graph.height
    const ctx = out.getContext('2d')!
    ctx.fillStyle = PLATE_COLOR
    ctx.fillRect(0, 0, out.width, out.height)
    if (this.legendVisible) drawLegend(ctx, out.width / scale, out.height / scale, scale)
    ctx.drawImage(graph, 0, 0)
    return out
  }

  private downloadCanvas(canvas: HTMLCanvasElement, fileName: string): void {
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = fileName
    document.body.append(a)
    a.click()
    a.remove()
  }

  private initRenderer(): void {
    if (this.renderer) return

    this.renderer = new Sigma(this.graph, this.container, {
      primitives: NEURAL_PRIMITIVES,
      settings: MAP_SIGMA_SETTINGS,
      styles: MAP_SIGMA_STYLES,
      customNodeState: { isActive: false, isHighlighted: false } as CustomNodeState,
      customEdgeState: { isActive: false } as CustomEdgeState,
      customGraphState: {
        hasActiveSubgraph: false,
        dimAlpha: 0,
        focusAlpha: 0,
        releaseAlpha: 0,
        enterAlpha: 1,
        lodRatio: 1,
        cameraRatio: 1,
        mapDensity: 0,
        pinActive: false,
        photoMode: false,
        labelBlocked: new Set<string>(),
        labelBackdrop: new Set<string>(),
        fisheyeX: 0,
        fisheyeY: 0,
        fisheyeRadius: 1,
        fisheyeStrength: 0,
      } as CustomGraphState,
    })

    // Стили задаются в конструкторе (Sigma v4 не имеет setStyles).
    this.renderer.setGraphState({
      hasActiveSubgraph: false,
      dimAlpha: 0,
      focusAlpha: 0,
      releaseAlpha: 0,
      enterAlpha: 1,
      lodRatio: 1,
      cameraRatio: 1,
      mapDensity: 0,
      pinActive: false,
      photoMode: false,
      labelBlocked: new Set<string>(),
      labelBackdrop: new Set<string>(),
      fisheyeX: 0,
      fisheyeY: 0,
      fisheyeRadius: 1,
      fisheyeStrength: 0,
    })

    this.renderer.getCamera().on('updated', () => {
      this.viewPending = this.renderer?.getCamera().getState() ?? null
      if (this.viewRaf === null) {
        this.viewRaf = requestAnimationFrame(() => {
          this.viewRaf = null
          const cam = this.viewPending
          this.viewPending = null
          if (cam) this.applyView(cam)
        })
      }
    })
    if (import.meta.env.DEV) {
      const devWindow = window as unknown as { __mapview?: MapView }
      devWindow.__mapview = this
    }

    const handleNodeEnter = (nodeKey: string) => {
      this.cancelIdleTimer()
      this.hoverLine.textContent = this.labelLine(Number(nodeKey))
      if (this.pinnedId === null && this.subgraphKey !== nodeKey) {
        this.subgraphKey = nodeKey
        this.focusSubgraph(nodeKey, 8)
      }
    }

    const handleNodeLeave = () => {
      if (this.pinnedId === null) {
        this.scheduleIdle()
      }
    }

    const handleNodeClick = (nodeKey: string) => {
      const id = Number(nodeKey)
      this.pin(this.pinnedId === id ? null : id)
    }

    this.renderer.on('enterNode', ({ node }) => handleNodeEnter(node))
    this.renderer.on('enterNodeLabel', ({ node }) => handleNodeEnter(node))
    this.renderer.on('leaveNode', () => handleNodeLeave())
    this.renderer.on('leaveNodeLabel', () => handleNodeLeave())
    this.renderer.on('clickNode', ({ node }) => handleNodeClick(node))
    this.renderer.on('clickNodeLabel', ({ node }) => handleNodeClick(node))
    this.renderer.on('clickStage', () => {
      if (this.pinnedId !== null) this.pin(null)
    })

    const start = performance.now()
    let lastFrame = 0
    // Uniforms alone do not repaint a Sigma canvas. Schedule a light render at
    // ~30fps so the liquid waves and droplets actually flow.
    const tick = (now: number) => {
      setNeuralTime((performance.now() - start) / 1000, document.hidden ? 0 : 1)
      if (!document.hidden && now - lastFrame > 32) {
        lastFrame = now
        this.renderer?.scheduleRender()
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  // Dense maps are treated as slightly zoomed out, so small-node dust fades earlier.
  // Only affects LOD opacity/labels; Sigma scales real sizes by the true camera ratio.
  private lodBoost(): number {
    const order = this.graph.order
    return order > 300 ? Math.pow(order / 300, 0.8) : 1
  }

  // Approximate label boxes and marker discs in screen px, mirroring Sigma's
  // placement math. Candidates come from attributes (not resolved styles) so
  // neither collision set can feed back into itself and flicker on the next frame.
  private computeLabelLayout(cam: ViewState, fisheye: FisheyeConfig): {
    blocked: Set<string>
    backdrop: Set<string>
  } {
    const empty = { blocked: new Set<string>(), backdrop: new Set<string>() }
    const r = this.renderer
    if (!r) return empty
    // Label kegel uses its own (slower) zoom function, not the node-size one.
    const zk = 1 / labelZoomRatio(cam.ratio)
    const margin = (r.getPrimitives()?.nodes?.label?.margin as number | undefined) ?? 5
    const boxes: LabelBox[] = []
    const circles: LabelCircle[] = []

    for (const key of this.graph.nodes()) {
      const a = this.graph.getNodeAttributes(key)
      const d = r.getNodeDisplayData(key)
      if (!a.label || d?.visibility === 'hidden') continue
      const core = visualCoreRadius((a.size as number) ?? 0)
      if (renderedNodeSize(core, cam.ratio) < 2) continue

      // Obel Mono has a fixed 0.600 em advance in every weight, so this is an
      // exact width estimate rather than the old 0.62 heuristic.
      const fs = ((d?.labelSize as number) ?? 18.5) * zk
      const w = Math.max(8, String(a.label).length * fs * 0.6)
      const h = fs * 1.25
      const rad = r.scaleSize((d?.size as number) ?? 0)
      // Captions must use the SAME displaced position as the marker, otherwise
      // the collision grid drifts away from the words actually on screen.
      const pos = r.graphToViewport(fisheyePoint(a.x, a.y, fisheye), { cameraState: cam })
      // The visible marker is the dashed orbit at the CORE radius; the outer
      // halo is only a faint aura, not a "node behind the word".
      if (rad >= 2) circles.push({ id: key, x: pos.x, y: pos.y, r: rad * coreFrac(core) })
      const state = r.getNodeState(key)
      const forced = state?.isHighlighted ? 1000 : state?.isActive ? 500 : 0
      boxes.push({
        id: key,
        x: pos.x + rad + margin * zk + w / 2,
        y: pos.y,
        w,
        h,
        priority: core + forced,
      })
    }
    // A wider breathing gap keeps the earlier-appearing captions readable
    // instead of turning a dense map into a wall of words.
    const blocked = resolveLabelBoxes(boxes, 8)
    // Only captions with ANOTHER marker behind them get a translucent chip.
    // Forced ego labels bypass the blocker, so check every candidate box.
    const backdrop = resolveLabelBackdrops(boxes, circles, 3)
    return { blocked, backdrop }
  }

  private sameSet(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false
    for (const id of a) if (!b.has(id)) return false
    return true
  }

  // Transit culling: sigma draws every edge, so on zoom-in the viewport fills
  // with lines whose endpoints are offscreen. Hide every edge that is not
  // fully inside the viewport: a line exiting the screen carries no local
  // information at that zoom. Focused ego-network edges are exempt.
  // Runs on camera updates only (called from applyView), diffed, O(edges).
  private transitHidden = new Set<string>()

  private cullTransitEdges(cam: ViewState, fisheye: FisheyeConfig): void {
    const r = this.renderer
    if (!r || this.graph.order === 0) return
    const dims = r.getDimensions()
    const mX = dims.width * 0.12
    const mY = dims.height * 0.12
    const tl = r.viewportToGraph({ x: -mX, y: -mY }, { cameraState: cam })
    const br = r.viewportToGraph({ x: dims.width + mX, y: dims.height + mY }, { cameraState: cam })
    const minX = Math.min(tl.x, br.x)
    const maxX = Math.max(tl.x, br.x)
    const minY = Math.min(tl.y, br.y)
    const maxY = Math.max(tl.y, br.y)

    const keep = new Set<string>()
    const focusKeys = [this.pinnedId !== null ? String(this.pinnedId) : null, this.subgraphKey]
    for (const nk of focusKeys) {
      if (nk !== null && this.graph.hasNode(nk)) {
        for (const ek of this.graph.edges(nk)) keep.add(ek)
      }
    }

    const next = new Set<string>()
    for (const ek of this.graph.edges()) {
      if (keep.has(ek)) continue
      const a = this.graph.getNodeAttributes(this.graph.source(ek))
      const b = this.graph.getNodeAttributes(this.graph.target(ek))
      // Edges are drawn from fisheye-displaced positions on zoom; cull in the
      // same space or the lines and the test disagree.
      const pa = fisheyePoint(a.x, a.y, fisheye)
      const pb = fisheyePoint(b.x, b.y, fisheye)
      const aIn = pa.x >= minX && pa.x <= maxX && pa.y >= minY && pa.y <= maxY
      const bIn = pb.x >= minX && pb.x <= maxX && pb.y >= minY && pb.y <= maxY
      if (!aIn || !bIn) next.add(ek)
    }

    for (const ek of this.transitHidden) {
      if (!next.has(ek) && this.graph.hasEdge(ek)) r.setEdgeState(ek, { isHidden: false })
    }
    for (const ek of next) {
      if (!this.transitHidden.has(ek)) r.setEdgeState(ek, { isHidden: true })
    }
    this.transitHidden = next
  }

  private applyView(cam: ViewState): void {
    const r = this.renderer
    if (!r) return
    const ratio = cam.ratio

    // The fisheye reach is a fixed ~360 screen px expressed in graph units at
    // the current camera, so the effect stays local at every zoom level.
    const dims = r.getDimensions()
    const middle = { x: dims.width / 2, y: dims.height / 2 }
    const center = r.viewportToGraph(middle, { cameraState: cam })
    const below = r.viewportToGraph({ x: middle.x, y: middle.y + 100 }, { cameraState: cam })
    const unitsPerPx = Math.hypot(below.x - center.x, below.y - center.y) / 100
    const fisheye = {
      fisheyeX: center.x,
      fisheyeY: center.y,
      // Wide reach: the spread must be felt, not just measured.
      fisheyeRadius: Math.max(1, 440 * unitsPerPx),
      // Full strength early: the effect grows while zooming in.
      fisheyeStrength: Math.max(0, Math.min(1, (1 - ratio) / 0.5)),
    }

    const layout = this.computeLabelLayout(cam, fisheye)
    const effective = ratio * this.lodBoost()
    // A 30-node map has no visual noise; a 600-node one does. LOD suppression
    // scales with map density so small chats stay fully detailed.
    const mapDensity = Math.max(0, Math.min(1, (this.graph.order - 50) / 350))
    const state = r.getGraphState()
    const applied = state.lodRatio ?? 1
    const sameLod = Math.abs(effective - applied) / Math.max(effective, applied) < 0.01
    const sameLabels = this.sameSet(layout.blocked, state.labelBlocked ?? new Set())
    const sameBackdrop = this.sameSet(layout.backdrop, state.labelBackdrop ?? new Set())
    const sameCamera = (state.cameraRatio ?? 1) === ratio
    const sameDensity = (state.mapDensity ?? 0) === mapDensity
    const sameFisheye =
      Math.abs((state.fisheyeX ?? 0) - fisheye.fisheyeX) < 1 &&
      Math.abs((state.fisheyeY ?? 0) - fisheye.fisheyeY) < 1 &&
      Math.abs((state.fisheyeRadius ?? 1) - fisheye.fisheyeRadius) / fisheye.fisheyeRadius < 0.01 &&
      Math.abs((state.fisheyeStrength ?? 0) - fisheye.fisheyeStrength) < 0.005
    if (sameLod && sameLabels && sameBackdrop && sameCamera && sameDensity && sameFisheye) return
    r.setGraphState({
      lodRatio: effective,
      cameraRatio: ratio,
      mapDensity,
      labelBlocked: layout.blocked,
      labelBackdrop: layout.backdrop,
      ...fisheye,
    })
    this.cullTransitEdges(cam, fisheye)
    r.refresh({ skipIndexation: true })
  }

  render(msg: MapMsg): void {
    this.resetInteractionState()
    this.cancelIdleTimer()
    this.lastMsg = msg
    this.graph.clear()
    this.transitHidden = new Set<string>()

    const overrides = getLabelOverrides()

    for (const node of msg.nodes) {
      const lead = node.authorLead
      const defaultColor = (lead !== undefined && this.authorColors.get(lead)) || DEFAULT_NODE_COLOR
      const color = defaultColor
      const customLabel = overrides[node.canon]
      this.graph.addNode(String(node.id), {
        nodeId: node.id,
        label: customLabel || node.label,
        defaultLabel: node.label,
        canon: node.canon,
        x: node.x,
        y: node.y,
        size: node.size,
        color,
        count: node.count,
        authorLead: node.authorLead,
        phase: node.phase,
        arm0: node.arm0,
        arm1: node.arm1,
        arm2: node.arm2,
        arm3: node.arm3,
        arm4: node.arm4,
      })
    }

    // Geometric reach of each edge vs the map median: long weak links dissolve
    // in edgeOpacity, sparing strong corridors. Computed from layout coords.
    const nodePos = new Map(msg.nodes.map((n) => [n.id, n]))
    const edgeLens = msg.edges
      .map((e) => {
        const a = nodePos.get(e.a)
        const b = nodePos.get(e.b)
        return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
      })
      .filter((l) => l > 0)
      .sort((x, y) => x - y)
    const medianLen = edgeLens.length > 0 ? edgeLens[Math.floor(edgeLens.length / 2)] : 0

    for (const edge of msg.edges) {
      const a = String(edge.a)
      const b = String(edge.b)
      if (this.graph.hasNode(a) && this.graph.hasNode(b) && !this.graph.hasEdge(a, b)) {
        const w = edgeWidth(edge.weight, msg.maxWeight)
        // Quad follows frequency: hairlines for rare links, wide arteries for
        // frequent ones. halfPx must always exceed the shader's filament —
        // round 12 widened the filament, so the quad grows with it.
        const edgeSize = 2.8 + 4.2 * Math.pow(w, 1.3) + 0.8 * edge.bundle
        const lead = this.graph.getNodeAttribute(a, 'authorLead') as AuthorId | undefined
        const tint = (lead !== undefined && this.authorColors.get(lead)) || DEFAULT_NODE_COLOR
        const color = edgeColor(edge.weight, msg.maxWeight, tint)
        const lodSize = Math.min(
          this.graph.getNodeAttribute(a, 'size') as number,
          this.graph.getNodeAttribute(b, 'size') as number,
        )
        this.graph.addEdge(a, b, {
          size: edgeSize,
          color,
          weight: edge.weight,
          alpha: edge.alpha,
          bead: edge.bead,
          bundle: edge.bundle,
          rank: edge.rank,
          tractRank: edge.tractRank,
          strength: w,
          reach: (() => {
            const a = nodePos.get(edge.a)
            const b = nodePos.get(edge.b)
            if (!a || !b || medianLen <= 0) return 1
            return Math.hypot(a.x - b.x, a.y - b.y) / medianLen
          })(),
          phase: phaseFor(edge.a ^ edge.b),
          lodSize,
          tract: edge.tract,
        })
      }
    }

    if (!this.renderer) {
      this.initRenderer()
    } else {
      this.renderer.refresh()
    }

    // resetInteractionState() nulls pinnedId at the top of render, and only
    // click handlers re-pin, so there is nothing to restore here.
    this.renderer?.getCamera().reset()
    this.applyView(this.renderer?.getCamera().getState() ?? FLAT_VIEW)
    // Fonts are loaded by the time a map arrives; repaint with the real face.
    this.paintLegend()
    // Fresh map fades in instead of popping: restart the enter tween.
    this.animator.jump('enter', 0)
    this.animator.to('enter', 1, 600)
  }

  renderAuthors(colors: Map<AuthorId, string>): void {
    this.authorColors = colors
    for (const nodeKey of this.graph.nodes()) {
      const attrs = this.graph.getNodeAttributes(nodeKey)
      const authorLead = attrs.authorLead as AuthorId | undefined
      if (authorLead !== undefined && this.authorColors.has(authorLead)) {
        this.graph.setNodeAttribute(nodeKey, 'color', this.authorColors.get(authorLead)!)
      }
    }
    this.renderer?.refresh()
  }

  pin(id: number | null): void {
    this.cancelIdleTimer()
    this.pinnedId = id
    if (!this.renderer) return

    const active = id !== null && this.graph.hasNode(String(id))
    // A pin (unlike a hover) forces labels across the whole ego-network.
    this.renderer.setGraphState({ pinActive: active })

    if (active) {
      const key = String(id)
      this.subgraphKey = key
      this.focusSubgraph(key, 12)
      this.hoverLine.textContent = this.labelLine(id)

      const rawForms = this.lastMsg?.forms
      const forms = rawForms instanceof Map
        ? rawForms.get(id) || []
        : ((rawForms as any)?.[id] || [])
      const details = buildNodeDetails(this.graph, id, forms)
      if (details) {
        this.nodePanel.show(details)
      }
    } else {
      this.fadeToIdle()
      this.hoverLine.textContent = 'слово · 0'
      this.nodePanel.hide()
    }

    this.renderer.refresh({ skipIndexation: true })
    this.scheduleLayout()
  }

  // Photo of the selected node: a snapshot of the CURRENT camera view, with
  // the pinned ego-network highlighted. No re-framing: the user zooms/pans
  // first, then takes the photo of exactly what they see.
  public async nodePhotoDataUrl(): Promise<string | null> {
    const r = this.renderer
    if (!r || this.pinnedId === null) return null
    const key = String(this.pinnedId)
    if (!this.graph.hasNode(key)) return null

    // Sigma v4 computes its normalization at ratio 1 (computeFittedExtent uses
    // NULL_CAMERA_STATE), so a second renderer with the SAME dimensions and the
    // SAME camera state reproduces the live view exactly. Changing the aspect
    // ratio or the padding here would shift the framing.
    const cam = r.getCamera().getState()
    const dims = r.getDimensions()
    const live = r.getGraphState()
    const canvas = await drawOnCanvas(r as unknown as Parameters<typeof drawOnCanvas>[0], {
      width: dims.width,
      height: dims.height,
      backgroundColor: 'rgba(0, 0, 0, 0)',
      cameraState: { ...cam },
      withTempRenderer: async (tmp) => {
        const t = tmp as unknown as Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState>
        t.setGraphState({
          ...live,
          photoMode: true,
          pinActive: true,
          hasActiveSubgraph: true,
          // Keep the live dimAlpha: non-ego captions must be dimmed in the
          // photo exactly like on screen, not dropped.
          focusAlpha: 1,
          releaseAlpha: 0,
          cameraRatio: cam.ratio,
          lodRatio: live.lodRatio ?? cam.ratio,
          labelBlocked: new Set<string>(),
          labelBackdrop: live.labelBackdrop ?? new Set<string>(),
        })
        t.refresh()
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        t.refresh()
      },
    })
    return this.composePhoto(canvas).toDataURL('image/png')
  }

  private async downloadNodePhoto(): Promise<void> {
    const url = await this.nodePhotoDataUrl()
    if (!url || this.pinnedId === null) return
    const key = String(this.pinnedId)
    const label = this.graph.hasNode(key) ? String(this.graph.getNodeAttribute(key, 'label')) : 'node'
    const safe = label.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'node'
    const a = document.createElement('a')
    a.href = url
    a.download = `chatmap-${safe}.png`
    document.body.append(a)
    a.click()
    a.remove()
  }

  public showProgress(done: number, total: number, stage?: string): void {
    const pct = Math.min(100, Math.max(0, Math.round((done / Math.max(1, total)) * 100)))
    this.container.setAttribute('aria-busy', 'true')
    this.progressEl.hidden = false
    this.progressEl.style.width = `${pct}%`
    this.hoverLine.textContent = stage
      ? `Обновление · ${stage.replace(/\.\.\.$/, '')} · ${pct}%`
      : `Обновление · ${pct}%`
  }

  public hideProgress(): void {
    this.progressEl.hidden = true
    this.progressEl.style.width = '0%'
    this.container.removeAttribute('aria-busy')
    if (this.pinnedId !== null && this.graph.hasNode(String(this.pinnedId))) {
      const attrs = this.graph.getNodeAttributes(String(this.pinnedId))
      this.hoverLine.textContent = `${attrs.label} · ${attrs.count}`
    } else {
      this.hoverLine.textContent = 'слово · 0'
    }
  }
}

let mapInstance: MapView | null = null

export function renderMap(root: HTMLElement): MapView {
  if (!mapInstance) {
    mapInstance = new MapView(root)
  }
  return mapInstance
}
