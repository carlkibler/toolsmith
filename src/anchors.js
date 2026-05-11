import { fnv1a32 } from "./hash.js"

export const ANCHOR_DELIMITER = "§"

const MAX_LCS_CELLS = 4_000_000

function makeKey(workspaceKey, sessionId, path) {
  return `${workspaceKey || ""}\0${sessionId || "default"}\0${path}`
}

function toBase36Word(number) {
  return `A${number.toString(36).replace(/[^a-z0-9]/gi, "")}`
}

function uniqueAnchor(path, lineHash, lineIndex, used) {
  let attempt = 0
  while (true) {
    const seed = `${path}\0${lineHash}\0${lineIndex}\0${attempt}`
    const anchor = toBase36Word(fnv1a32(seed))
    if (!used.has(anchor)) {
      used.add(anchor)
      return anchor
    }
    attempt += 1
  }
}

function lineHashes(lines) {
  return lines.map((line) => fnv1a32(line))
}

function reconcileWithLcs(previousHashes, previousAnchors, currentHashes, path, used) {
  const rows = previousHashes.length
  const cols = currentHashes.length
  const dp = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1))

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      dp[row][col] = previousHashes[row] === currentHashes[col]
        ? dp[row + 1][col + 1] + 1
        : Math.max(dp[row + 1][col], dp[row][col + 1])
    }
  }

  const anchors = new Array(cols)
  let row = 0
  let col = 0
  while (row < rows && col < cols) {
    if (previousHashes[row] === currentHashes[col]) {
      anchors[col] = previousAnchors[row]
      used.add(previousAnchors[row])
      row += 1
      col += 1
    } else if (dp[row + 1][col] >= dp[row][col + 1]) {
      row += 1
    } else {
      col += 1
    }
  }

  for (let index = 0; index < cols; index += 1) {
    if (!anchors[index]) anchors[index] = uniqueAnchor(path, currentHashes[index], index, used)
  }

  return anchors
}

function reconcileGreedy(previousHashes, previousAnchors, currentHashes, path, used) {
  const buckets = new Map()
  for (let index = 0; index < previousHashes.length; index += 1) {
    const hash = previousHashes[index]
    if (!buckets.has(hash)) buckets.set(hash, [])
    buckets.get(hash).push(index)
  }

  const anchors = new Array(currentHashes.length)
  let floor = -1
  for (let index = 0; index < currentHashes.length; index += 1) {
    const candidates = buckets.get(currentHashes[index]) || []
    const match = candidates.find((candidate) => candidate > floor && !used.has(previousAnchors[candidate]))
    if (match !== undefined) {
      anchors[index] = previousAnchors[match]
      used.add(anchors[index])
      floor = match
    } else {
      anchors[index] = uniqueAnchor(path, currentHashes[index], index, used)
    }
  }
  return anchors
}

export class AnchorStore {
  #documents = new Map()
  #maxDocuments

  constructor({ maxDocuments = 200 } = {}) {
    this.#maxDocuments = maxDocuments
  }

  reconcile(path, content, options = {}) {
    const sessionId = options.sessionId || "default"
    const workspaceKey = options.workspaceKey || ""
    const key = makeKey(workspaceKey, sessionId, path)
    const lines = splitLines(content)
    const hashes = lineHashes(lines)
    const previous = this.#documents.get(key)
    // Seed used-set from live anchors only — historical anchors from deleted lines
    // are not tracked; uniqueAnchor's attempt counter handles any rare re-collision.
    const used = new Set(previous?.usedAnchors || [])

    let anchors
    if (!previous) {
      used.clear()
      anchors = hashes.map((hash, index) => uniqueAnchor(path, hash, index, used))
    } else if (sameHashes(previous.hashes, hashes)) {
      anchors = [...previous.anchors]
    } else if (previous.hashes.length * hashes.length <= MAX_LCS_CELLS) {
      // O(N²) LCS for files small enough to fit in MAX_LCS_CELLS; greedy O(N) below
      anchors = reconcileWithLcs(previous.hashes, previous.anchors, hashes, path, used)
    } else {
      anchors = reconcileGreedy(previous.hashes, previous.anchors, hashes, path, used)
    }

    // LRU eviction: delete-then-set moves the entry to the end (most-recently-used).
    // The first Map entry is always the least-recently-used candidate for eviction.
    this.#documents.delete(key)
    this.#documents.set(key, { hashes, anchors, usedAnchors: new Set(anchors) })
    if (this.#documents.size > this.#maxDocuments) {
      this.#documents.delete(this.#documents.keys().next().value)
    }

    return anchors
  }

  get(path, options = {}) {
    const sessionId = options.sessionId || "default"
    const workspaceKey = options.workspaceKey || ""
    return this.#documents.get(makeKey(workspaceKey, sessionId, path)) || null
  }

  clear(path, options = {}) {
    if (path) {
      const sessionId = options.sessionId || "default"
      const workspaceKey = options.workspaceKey || ""
      this.#documents.delete(makeKey(workspaceKey, sessionId, path))
    } else {
      this.#documents.clear()
    }
  }

  summary() {
    const files = []
    for (const [key, doc] of this.#documents) {
      const first = key.indexOf("\0")
      const second = key.indexOf("\0", first + 1)
      files.push({ workspaceKey: key.slice(0, first), sessionId: key.slice(first + 1, second), path: key.slice(second + 1), lineCount: doc.anchors.length })
    }
    return files
  }
}

export function splitLines(content) {
  return content.length === 0 ? [] : content.split(/\r?\n/)
}

export function formatAnchoredLine(anchor, line) {
  return `${anchor}${ANCHOR_DELIMITER}${line}`
}

export function splitAnchorReference(reference) {
  const delimiterIndex = String(reference || "").indexOf(ANCHOR_DELIMITER)
  if (delimiterIndex === -1) {
    return { anchor: String(reference || "").trim(), content: null }
  }
  return {
    anchor: String(reference).slice(0, delimiterIndex).trim(),
    content: String(reference).slice(delimiterIndex + ANCHOR_DELIMITER.length),
  }
}

export function stripAnchors(text) {
  const delimiter = ANCHOR_DELIMITER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return String(text ?? "").replace(new RegExp(`A[a-zA-Z0-9]+${delimiter}`, "g"), "")
}

function sameHashes(left, right) {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}
