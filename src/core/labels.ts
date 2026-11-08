// Pure label-placement logic. Sigma's LabelGrid only limits labels per cell;
// boxes across cell borders can still collide. This resolver keeps the stronger
// (larger) node's label and hides the ones that would overlap it.

export type LabelBox = {
  id: string
  x: number
  y: number
  w: number
  h: number
  priority: number
}

// Spatial hash: only compare boxes in neighbouring cells, O(n) for typical maps.
const CELL = 120

export function resolveLabelBoxes(boxes: LabelBox[], padding = 4): Set<string> {
  const sorted = [...boxes].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1))
  const cells = new Map<string, LabelBox[]>()
  const blocked = new Set<string>()
  const cellKey = (cx: number, cy: number) => `${cx}:${cy}`

  for (const box of sorted) {
    const cx = Math.floor(box.x / CELL)
    const cy = Math.floor(box.y / CELL)
    const reachX = Math.ceil((box.w / 2 + padding) / CELL)
    const reachY = Math.ceil((box.h / 2 + padding) / CELL)
    let clash = false

    for (let gx = cx - reachX; gx <= cx + reachX && !clash; gx++) {
      for (let gy = cy - reachY; gy <= cy + reachY && !clash; gy++) {
        const neighbours = cells.get(cellKey(gx, gy))
        if (!neighbours) continue
        for (const other of neighbours) {
          const dx = Math.abs(box.x - other.x)
          const dy = Math.abs(box.y - other.y)
          if (dx < (box.w + other.w) / 2 + padding && dy < (box.h + other.h) / 2 + padding) {
            clash = true
            break
          }
        }
      }
    }

    if (clash) {
      blocked.add(box.id)
      continue
    }
    const key = cellKey(cx, cy)
    const list = cells.get(key)
    if (list) list.push(box)
    else cells.set(key, [box])
  }

  return blocked
}

export type LabelCircle = {
  id: string
  x: number
  y: number
  r: number
}

// Captions whose text sits on top of ANOTHER node's marker. The label's own
// marker is skipped: Sigma places the caption just outside it by design.
// A spatial hash keeps this linear for dense maps.
export function resolveLabelBackdrops(boxes: LabelBox[], circles: LabelCircle[], padding = 2): Set<string> {
  const cells = new Map<string, LabelCircle[]>()
  const cellKey = (cx: number, cy: number) => `${cx}:${cy}`

  for (const c of circles) {
    const minX = Math.floor((c.x - c.r - padding) / CELL)
    const maxX = Math.floor((c.x + c.r + padding) / CELL)
    const minY = Math.floor((c.y - c.r - padding) / CELL)
    const maxY = Math.floor((c.y + c.r + padding) / CELL)
    for (let gx = minX; gx <= maxX; gx++) {
      for (let gy = minY; gy <= maxY; gy++) {
        const key = cellKey(gx, gy)
        const list = cells.get(key)
        if (list) list.push(c)
        else cells.set(key, [c])
      }
    }
  }

  const backdrops = new Set<string>()
  for (const box of boxes) {
    const halfW = box.w / 2 + padding
    const halfH = box.h / 2 + padding
    const minX = Math.floor((box.x - halfW) / CELL)
    const maxX = Math.floor((box.x + halfW) / CELL)
    const minY = Math.floor((box.y - halfH) / CELL)
    const maxY = Math.floor((box.y + halfH) / CELL)
    let hit = false

    for (let gx = minX; gx <= maxX && !hit; gx++) {
      for (let gy = minY; gy <= maxY && !hit; gy++) {
        const neighbours = cells.get(cellKey(gx, gy))
        if (!neighbours) continue
        for (const c of neighbours) {
          if (c.id === box.id) continue
          const dx = Math.max(Math.abs(c.x - box.x) - halfW, 0)
          const dy = Math.max(Math.abs(c.y - box.y) - halfH, 0)
          if (dx * dx + dy * dy <= c.r * c.r) {
            hit = true
            break
          }
        }
      }
    }
    if (hit) backdrops.add(box.id)
  }

  return backdrops
}
