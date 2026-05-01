import { contentHash } from "./hash.js"
import { AnchorStore, formatAnchoredLine, splitLines } from "./anchors.js"
import { makeTelemetry } from "./telemetry.js"

export function readAnchored({ path, content, store, sessionId, startLine, endLine }) {
  const anchorStore = store || new AnchorStore()
  const anchors = anchorStore.reconcile(path, content, { sessionId })
  const lines = splitLines(content)
  const start = Math.max(0, (startLine || 1) - 1)
  const end = Math.min(lines.length, endLine || lines.length)
  const body = lines.slice(start, end).map((line, offset) => formatAnchoredLine(anchors[start + offset], line)).join("\n")
  const text = `[File Hash: ${contentHash(content)}]\n${body}`
  return {
    path,
    fileHash: contentHash(content),
    startLine: start + 1,
    endLine: end,
    text,
    anchors: anchors.slice(start, end),
    telemetry: makeTelemetry({ operation: "anchored_read", fullContent: content, requestPayload: { path, sessionId, startLine, endLine }, responseText: text, anchors: anchors.slice(start, end) }),
  }
}
