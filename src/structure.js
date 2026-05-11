import { contentHash } from "./hash.js"
import { formatAnchoredLine, splitLines } from "./anchors.js"
import { makeTelemetry } from "./telemetry.js"

export function fileSkeleton({ path, content, store, sessionId, workspaceKey, maxLines = 200 }) {
  if (!store) throw new Error("fileSkeleton requires an AnchorStore")
  const lines = splitLines(content)
  const anchors = store.reconcile(path, content, { sessionId, workspaceKey })
  const entries = []

  for (let index = 0; index < lines.length && entries.length <= maxLines; index += 1) {
    const line = lines[index]
    if (isSkeletonLine(line)) {
      entries.push({ line: index + 1, anchor: anchors[index], text: line, kind: classifyLine(line) })
    }
  }

  const truncated = entries.length > maxLines
  const visibleEntries = truncated ? entries.slice(0, maxLines) : entries
  const text = formatSkeletonText({ path, content, workspaceKey, entries: visibleEntries, truncated })
  return { path, fileHash: contentHash(content), entries: visibleEntries, maxLines, text, telemetry: makeTelemetry({ operation: "file_skeleton", fullContent: content, requestPayload: { path, sessionId, maxLines }, responseText: text, anchors: visibleEntries.map((entry) => entry.anchor) }) }
}

export function getFunction({ path, content, store, sessionId, workspaceKey, name, contextLines = 0, maxLines = 400 }) {
  if (!store) throw new Error("getFunction requires an AnchorStore")
  if (!name || typeof name !== "string") throw new Error("name is required")
  const lines = splitLines(content)
  const anchors = store.reconcile(path, content, { sessionId, workspaceKey })
  const range = findSymbolRange(lines, name)
  const workspaceTag = workspaceKey ? `[Workspace: ${workspaceKey}] ` : ""
  if (!range) {
    const text = `${workspaceTag}[File: ${path}] [File Hash: ${contentHash(content)}]\n(symbol not found: ${name})`
    return { path, fileHash: contentHash(content), name, found: false, text, telemetry: makeTelemetry({ operation: "get_function", fullContent: content, requestPayload: { path, sessionId, name, contextLines, maxLines }, responseText: text }) }
  }

  const { startIndex, endIndex } = range
  const start = Math.max(0, startIndex - contextLines)
  const end = Math.min(lines.length, Math.min(endIndex + 1 + contextLines, start + maxLines))
  const body = lines.slice(start, end).map((line, offset) => formatAnchoredLine(anchors[start + offset], line)).join("\n")
  const truncated = end < endIndex + 1 + contextLines
  const text = `${workspaceTag}[File: ${path}] [File Hash: ${contentHash(content)}] [Symbol: ${name}] [Lines: ${start + 1}-${end}${truncated ? "+" : ""}]\n${body}`
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
  const t = line.trim()
  if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("--") || t.startsWith("/*")) return false
  return (
    /^(?:import|from)\s+/u.test(t) ||
    /^export(?:\s+default)?\s+/u.test(t) ||
    /^(?:async\s+)?(?:function|def)\s+/u.test(t) ||
    /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+/u.test(t) ||
    /^func\s+/u.test(t) ||
    /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:class|struct|enum|protocol|interface|trait|impl|module|extension|type)\s+/u.test(t) ||
    /^(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\(|\w+\s*=>)/u.test(t)
  )
}

function classifyLine(line) {
  const t = line.trim()
  if (/^(?:import|from)\s+/u.test(t)) return "import"
  if (/\bclass\s+/u.test(t)) return "class"
  if (/\b(?:struct|enum|protocol|interface|type|trait|impl|module|extension)\s+/u.test(t)) return "type"
  return "function"
}

function formatSkeletonText({ path, content, workspaceKey, entries, truncated }) {
  const workspaceTag = workspaceKey ? `[Workspace: ${workspaceKey}] ` : ""
  const header = `${workspaceTag}[File: ${path}] [File Hash: ${contentHash(content)}] [Skeleton Lines: ${entries.length}${truncated ? "+" : ""}]`
  if (entries.length === 0) return `${header}\n(no skeleton entries)`
  return `${header}\n${entries.map((entry) => `${entry.line}: ${formatAnchoredLine(entry.anchor, entry.text)}`).join("\n")}`
}

export function findSymbolRange(lines, name) {
  const startIndex = findSymbolStart(lines, name)
  if (startIndex === -1) return null
  return { startIndex, endIndex: findSymbolEnd(lines, startIndex) }
}

function findSymbolStart(lines, name) {
  const e = escapeRegExp(name)
  const patterns = [
    new RegExp(`\\b(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s+${e}\\b`),
    new RegExp(`\\b(?:export\\s+)?(?:class|def|struct|enum|protocol|interface|type|trait|impl|module|extension)\\s+${e}\\b`),
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${e}\\s*=`),
    new RegExp(`\\b${e}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)`),
    new RegExp(`\\b(?:pub(?:\\s*\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${e}\\b`),
    new RegExp(`\\bfunc\\s+${e}\\b`),
  ]
  return lines.findIndex((line) => !isCommentOnly(line) && patterns.some((pattern) => pattern.test(line)))
}

function findSymbolEnd(lines, startIndex) {
  const braceIndex = findOpeningBraceLine(lines, startIndex)
  if (braceIndex !== -1) return findBraceEnd(lines, braceIndex)
  return findIndentEnd(lines, startIndex)
}

function findOpeningBraceLine(lines, startIndex) {
  const startIndent = indentation(lines[startIndex])
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 20); index += 1) {
    const line = stripCodeNoise(lines[index])
    if (line.includes("{")) return index
    if (index > startIndex && line.trim() && indentation(line) <= startIndent && isSkeletonLine(line)) break
  }
  return -1
}

function findBraceEnd(lines, startIndex) {
  let depth = 0
  let seenOpen = false
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = stripCodeNoise(lines[index])
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

function isCommentOnly(line) {
  const t = line.trim()
  return t.startsWith("//") || t.startsWith("#") || t.startsWith("--") || t.startsWith("/*") || t.startsWith("*")
}

function stripCodeNoise(line) {
  return stripLineComments(stripQuoted(line))
}

function stripLineComments(line) {
  return line.replace(/\/\*.*?\*\//gu, "").replace(/\/\/.*$/u, "")
}

function stripQuoted(line) {
  return line.replace(/(['"`])(?:\\.|(?!\1).)*\1/gu, "")
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
