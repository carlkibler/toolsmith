import { contentHash } from "./hash.js"
import { formatAnchoredLine, splitLines } from "./anchors.js"

export function readAnchored({ path, content, store, sessionId, startLine, endLine }) {
  if (!store) throw new Error("readAnchored requires an AnchorStore")
  const anchors = store.reconcile(path, content, { sessionId })
  const lines = splitLines(content)
  const start = Math.max(0, (startLine || 1) - 1)
  const end = Math.min(lines.length, endLine || lines.length)
  const body = lines.slice(start, end).map((line, offset) => formatAnchoredLine(anchors[start + offset], line)).join("\n")
  return {
    path,
    fileHash: contentHash(content),
    startLine: start + 1,
    endLine: end,
    text: `[File Hash: ${contentHash(content)}]\n${body}`,
    anchors: anchors.slice(start, end),
  }
}
