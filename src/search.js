import { contentHash } from "./hash.js"
import { formatAnchoredLine, splitLines } from "./anchors.js"
import { makeTelemetry } from "./telemetry.js"
import { checkRegexSafety } from "./regex-safety.js"

export function searchAnchored({ path, content, store, sessionId, workspaceKey, query, regex = false, caseSensitive = false, contextLines = 1, maxMatches = 20 }) {
  if (!store) throw new Error("searchAnchored requires an AnchorStore")
  if (!query || typeof query !== "string") throw new Error("query is required")

  const lines = splitLines(content)
  const anchors = store.reconcile(path, content, { sessionId, workspaceKey })
  let matcher
  try {
    matcher = makeMatcher(query, { regex, caseSensitive })
  } catch (e) {
    const wsTag = workspaceKey ? `[Workspace: ${workspaceKey}] ` : ""
    const text = `${wsTag}[File: ${path}] [Error: ${e.message}]`
    return { path, fileHash: contentHash(content), query, regex, caseSensitive, contextLines, maxMatches, matches: [], text, error: e.message, telemetry: makeTelemetry({ operation: "anchored_search", fullContent: content, requestPayload: { path, sessionId, query, regex, caseSensitive, contextLines, maxMatches }, responseText: text, anchors: [] }) }
  }
  const matches = []
  const matchedAnchors = []

  let totalMatches = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (!matcher(lines[index])) continue
    totalMatches += 1
    if (matches.length >= maxMatches) continue
    const start = Math.max(0, index - contextLines)
    const end = Math.min(lines.length, index + contextLines + 1)
    matchedAnchors.push(anchors[index])
    matches.push({
      line: index + 1,
      anchor: anchors[index],
      text: lines[index],
      startLine: start + 1,
      endLine: end,
      snippet: lines.slice(start, end).map((line, offset) => formatAnchoredLine(anchors[start + offset], line)).join("\n"),
    })
  }

  const ranges = mergeRanges(matches)
  const text = formatSearchText({ path, content, workspaceKey, matches, ranges, anchors, lines, truncated: totalMatches > matches.length })
  const emittedAnchors = anchorsForRanges(ranges, anchors)
  return {
    path,
    fileHash: contentHash(content),
    query,
    regex,
    caseSensitive,
    contextLines,
    maxMatches,
    matches,
    ranges: ranges.map((range) => ({ startLine: range.start + 1, endLine: range.end })),
    text,
    telemetry: {
      ...makeTelemetry({ operation: "anchored_search", fullContent: content, requestPayload: { path, sessionId, query, regex, caseSensitive, contextLines, maxMatches }, responseText: text, anchors: emittedAnchors }),
      matchAnchorCount: matchedAnchors.length,
      emittedAnchorCount: emittedAnchors.length,
    },
  }
}

function makeMatcher(query, { regex, caseSensitive }) {
  if (regex) {
    if (query.length > 1024) throw new Error("regex pattern too long (max 1024 chars)")
    const flags = caseSensitive ? "" : "i"
    let pattern
    try {
      pattern = new RegExp(query, flags)
    } catch (e) {
      throw new Error(`invalid regex: ${e.message}`)
    }
    checkRegexSafety(query, flags)
    return (line) => pattern.test(line)
  }
  const needle = caseSensitive ? query : query.toLowerCase()
  return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle)
}

function mergeRanges(matches) {
  const ranges = []
  for (const match of matches) {
    const start = match.startLine - 1
    const end = match.endLine
    const last = ranges[ranges.length - 1]
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end)
      last.matchLines.push(match.line)
    } else {
      ranges.push({ start, end, matchLines: [match.line] })
    }
  }
  return ranges
}

function anchorsForRanges(ranges, anchors) {
  return [...new Set(ranges.flatMap((range) => anchors.slice(range.start, range.end)))]
}

function formatSearchText({ path, content, workspaceKey, matches, ranges, anchors, lines, truncated }) {
  const totalLines = splitLines(content).length
  const emittedLines = ranges.reduce((sum, range) => sum + (range.end - range.start), 0)
  const savedPct = totalLines > 0 ? Math.round((1 - emittedLines / totalLines) * 100) : 0
  const workspaceTag = workspaceKey ? `[Workspace: ${workspaceKey}] ` : ""
  const header = `${workspaceTag}[File: ${path}] [File Hash: ${contentHash(content)}] [Matches: ${matches.length}${truncated ? "+" : ""}] [Ranges: ${ranges.length}] [~${savedPct}% of file not transferred]`
  if (matches.length === 0) return `${header}\n(no matches)`
  return `${header}\n${ranges.map((range) => {
    const snippet = lines.slice(range.start, range.end).map((line, offset) => formatAnchoredLine(anchors[range.start + offset], line)).join("\n")
    return `--- match line${range.matchLines.length === 1 ? "" : "s"} ${range.matchLines.join(", ")} ---\n${snippet}`
  }).join("\n")}`
}
