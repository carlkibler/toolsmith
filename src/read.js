import { contentHash } from "./hash.js"
import { AnchorStore, formatAnchoredLine, splitLines } from "./anchors.js"
import { makeTelemetry } from "./telemetry.js"

export function readAnchored({ path, content, store, sessionId, workspaceKey, startLine, endLine }) {
  const anchorStore = store || new AnchorStore()
  const anchors = anchorStore.reconcile(path, content, { sessionId, workspaceKey })
  const lines = splitLines(content)
  const start = Math.max(0, (startLine || 1) - 1)
  const end = Math.min(lines.length, endLine || lines.length)
  const body = lines.slice(start, end).map((line, offset) => formatAnchoredLine(anchors[start + offset], line)).join("\n")
  const isPartial = (startLine && startLine > 1) || (endLine && endLine < lines.length)
  const savingsNote = isPartial ? ` [Showing lines ${start + 1}–${end} of ${lines.length}; ~${Math.max(0, lines.length - (end - start))} lines (~${Math.round(Math.max(0, lines.length - (end - start)) / lines.length * 100)}%) not transferred]` : ""
  const workspaceTag = workspaceKey ? `[Workspace: ${workspaceKey}] ` : ""
  const text = `${workspaceTag}[File Hash: ${contentHash(content)}]${savingsNote}\n${body}`
  return {
    path,
    fileHash: contentHash(content),
    startLine: start + 1,
    endLine: end,
    text,
    anchors: anchors.slice(start, end),
    telemetry: makeTelemetry({ operation: "anchored_read", workspaceKey, fullContent: content, requestPayload: { path, sessionId, startLine, endLine }, responseText: text, anchors: anchors.slice(start, end) }),
  }
}
