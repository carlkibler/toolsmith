import { contentHash } from "./hash.js"
import { formatAnchoredLine, splitLines } from "./anchors.js"
import { makeTelemetry } from "./telemetry.js"

export function fileSkeleton({ path, content, store, sessionId, maxLines = 200 }) {
  if (!store) throw new Error("fileSkeleton requires an AnchorStore")
  const lines = splitLines(content)
  const anchors = store.reconcile(path, content, { sessionId })
  const entries = []

  for (let index = 0; index < lines.length && entries.length < maxLines; index += 1) {
    const line = lines[index]
    if (isSkeletonLine(line)) {
      entries.push({ line: index + 1, anchor: anchors[index], text: line, kind: classifyLine(line) })
    }
  }

  const text = formatSkeletonText({ path, content, entries, truncated: entries.length >= maxLines })
  return { path, fileHash: contentHash(content), entries, maxLines, text, telemetry: makeTelemetry({ operation: "file_skeleton", fullContent: content, requestPayload: { path, sessionId, maxLines }, responseText: text, anchors: entries.map((entry) => entry.anchor) }) }
}

export function getFunction({ path, content, store, sessionId, name, contextLines = 0, maxLines = 400 }) {
  if (!store) throw new Error("getFunction requires an AnchorStore")
  if (!name || typeof name !== "string") throw new Error("name is required")
  const lines = splitLines(content)
  const anchors = store.reconcile(path, content, { sessionId })
  const range = findSymbolRange(lines, name)
  if (!range) {
    const text = `[File: ${path}] [File Hash: ${contentHash(content)}]\n(symbol not found: ${name})`
    return { path, fileHash: contentHash(content), name, found: false, text, telemetry: makeTelemetry({ operation: "get_function", fullContent: content, requestPayload: { path, sessionId, name, contextLines, maxLines }, responseText: text }) }
  }

  const { startIndex, endIndex } = range
  const start = Math.max(0, startIndex - contextLines)
  const end = Math.min(lines.length, Math.min(endIndex + 1 + contextLines, start + maxLines))
  const body = lines.slice(start, end).map((line, offset) => formatAnchoredLine(anchors[start + offset], line)).join("\n")
  const truncated = end < endIndex + 1 + contextLines
  const text = `[File: ${path}] [File Hash: ${contentHash(content)}] [Symbol: ${name}] [Lines: ${start + 1}-${end}${truncated ? "+" : ""}]\n${body}`
  return {
    path,
    fileHash: contentHash(content),
    name,
    found: true,
    startLine: start + 1,
    endLine: end,
    symbolStartLine: startIndex + 1,
    symbolEndLine: endIndex + 1,
    truncated,
    text,
    telemetry: makeTelemetry({ operation: "get_function", fullContent: content, requestPayload: { path, sessionId, name, contextLines, maxLines }, responseText: text, anchors: anchors.slice(start, end) }),
  }
}

function isSkeletonLine(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) return false
  return /^(import|export\s+|from\s+|class\s+|def\s+|async\s+def\s+|function\s+|async\s+function\s+|const\s+\w+\s*=\s*(?:async\s*)?\(|let\s+\w+\s*=\s*(?:async\s*)?\(|var\s+\w+\s*=\s*(?:async\s*)?\(|struct\s+|enum\s+|protocol\s+|interface\s+|type\s+)/u.test(trimmed)
}

function classifyLine(line) {
  const trimmed = line.trim()
  if (/^(import|from\s+)/u.test(trimmed)) return "import"
  if (/class\s+/u.test(trimmed)) return "class"
  if (/^(struct|enum|protocol|interface|type)\s+/u.test(trimmed)) return "type"
  return "function"
}

function formatSkeletonText({ path, content, entries, truncated }) {
  const header = `[File: ${path}] [File Hash: ${contentHash(content)}] [Skeleton Lines: ${entries.length}${truncated ? "+" : ""}]`
  if (entries.length === 0) return `${header}\n(no skeleton entries)`
  return `${header}\n${entries.map((entry) => `${entry.line}: ${formatAnchoredLine(entry.anchor, entry.text)}`).join("\n")}`
}

export function findSymbolRange(lines, name) {
  const startIndex = findSymbolStart(lines, name)
  if (startIndex === -1) return null
  return { startIndex, endIndex: findSymbolEnd(lines, startIndex) }
}

function findSymbolStart(lines, name) {
  const escaped = escapeRegExp(name)
  const patterns = [
    new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`\\b(?:export\\s+)?(?:class|def|struct|enum|protocol|interface|type)\\s+${escaped}\\b`),
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=`),
    new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)`),
  ]
  return lines.findIndex((line) => patterns.some((pattern) => pattern.test(line)))
}

function findSymbolEnd(lines, startIndex) {
  if (hasBrace(lines[startIndex])) return findBraceEnd(lines, startIndex)
  return findIndentEnd(lines, startIndex)
}

function hasBrace(line) {
  return line.includes("{")
}

function findBraceEnd(lines, startIndex) {
  let depth = 0
  let seenOpen = false
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = stripQuoted(lines[index])
    for (const char of line) {
      if (char === "{") {
        depth += 1
        seenOpen = true
      } else if (char === "}") {
        depth -= 1
        if (seenOpen && depth <= 0) return index
      }
    }
  }
  return lines.length - 1
}

function findIndentEnd(lines, startIndex) {
  const baseIndent = indentation(lines[startIndex])
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() && indentation(line) <= baseIndent) return index - 1
  }
  return lines.length - 1
}

function indentation(line) {
  return line.match(/^\s*/u)[0].length
}

function stripQuoted(line) {
  return line.replace(/(['"`])(?:\\.|(?!\1).)*\1/gu, "")
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
