function extractTrigrams(word: string): Set<string> {
  const trigrams = new Set<string>()
  for (let i = 0; i <= word.length - 3; i++) {
    trigrams.add(word.slice(i, i + 3))
  }
  return trigrams
}

export function smartMerge(
  freq: Map<number, number>,
  idWords: Map<number, string>
): Map<number, number> {
  const partition = new Map<number, number>()

  const sortedIds = Array.from(freq.keys()).sort((a, b) => {
    const fA = freq.get(a) || 0
    const fB = freq.get(b) || 0
    return fB - fA || a - b
  })

  const trigramToRoots = new Map<string, number[]>()
  const rootTrigrams = new Map<number, Set<string>>()

  for (const id of sortedIds) {
    const word = idWords.get(id)
    if (!word || word.length < 6) {
      continue
    }

    const trigrams = extractTrigrams(word)
    if (trigrams.size === 0) continue

    const candidateRoots = new Set<number>()
    for (const tri of trigrams) {
      const roots = trigramToRoots.get(tri)
      if (roots) {
        for (const rootId of roots) {
          candidateRoots.add(rootId)
        }
      }
    }

    let bestRoot: number | null = null
    let maxJaccard = 0

    for (const rootId of candidateRoots) {
      const rootTri = rootTrigrams.get(rootId)!
      let intersection = 0
      for (const tri of trigrams) {
        if (rootTri.has(tri)) {
          intersection++
        }
      }
      const union = trigrams.size + rootTri.size - intersection
      const jaccard = union > 0 ? intersection / union : 0

      if (jaccard >= 0.5 && jaccard > maxJaccard) {
        maxJaccard = jaccard
        bestRoot = rootId
      }
    }

    if (bestRoot !== null) {
      partition.set(id, bestRoot)
    } else {
      rootTrigrams.set(id, trigrams)
      for (const tri of trigrams) {
        let list = trigramToRoots.get(tri)
        if (!list) {
          list = []
          trigramToRoots.set(tri, list)
        }
        list.push(id)
      }
    }
  }

  return partition
}
