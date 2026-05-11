import { contentHash } from "./hash.js"
import { AnchorStore, formatAnchoredLine, splitLines } from "./anchors.js"
import { makeTelemetry } from "./telemetry.js"

export function readAnchored({ path, content, store, sessionId, workspaceKey, startLine, endLine }) {
  const anchorStore = store || new AnchorStore()
  const anchors = anchorStore.reconcile(path, content, { sessionId, workspaceKey })
  const lines = splitLines(content)
  if (lines.length === 0) {
    const workspaceTag = workspaceKey ? `[Workspace: ${workspaceKey}] ` : ""
    const text = `${workspaceTag}[File: ${path}] [File Hash: ${contentHash(content)}]\n`
    return {
      path,
      fileHash: contentHash(content),
      lineCount: 0,
      startLine: 1,
      endLine: 0,
      text,
      anchors: [],
      telemetry: makeTelemetry({ operation: "anchored_read", workspaceKey, fullContent: content, requestPayload: { path, sessionId, startLine, endLine }, responseText: text, anchors: [] }),
    }
  }
  const requestedStart = normalizeLineNumber(startLine, "startLine") ?? 1
  const requestedEnd = normalizeLineNumber(endLine, "endLine") ?? lines.length
  if (requestedStart > requestedEnd) throw new Error("startLine must not be greater than endLine")
  const start = Math.min(lines.length, requestedStart - 1)
  const end = Math.min(lines.length, requestedEnd)
  const body = lines.slice(start, end).map((line, offset) => formatAnchoredLine(anchors[start + offset], line)).join("\n")
  const isPartial = (startLine && startLine > 1) || (endLine && endLine < lines.length)
  const savingsNote = isPartial ? ` [Showing lines ${start + 1}–${end} of ${lines.length}; ~${Math.max(0, lines.length - (end - start))} lines (~${Math.round(Math.max(0, lines.length - (end - start)) / lines.length * 100)}%) not transferred]` : ""
  const workspaceTag = workspaceKey ? `[Workspace: ${workspaceKey}] ` : ""
  const text = `${workspaceTag}[File: ${path}] [File Hash: ${contentHash(content)}]${savingsNote}\n${body}`
  return {
    path,
    fileHash: contentHash(content),
    lineCount: lines.length,
    startLine: start + 1,
    endLine: end,
    text,
    anchors: anchors.slice(start, end),
    telemetry: makeTelemetry({ operation: "anchored_read", workspaceKey, fullContent: content, requestPayload: { path, sessionId, startLine, endLine }, responseText: text, anchors: anchors.slice(start, end) }),
  }
}

function normalizeLineNumber(value, name) {
  if (value === undefined || value === null) return null
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`)
  return number
}
