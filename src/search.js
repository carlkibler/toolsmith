import { contentHash } from "./hash.js"
import { formatAnchoredLine, splitLines } from "./anchors.js"
import { makeTelemetry } from "./telemetry.js"

export function searchAnchored({ path, content, store, sessionId, query, regex = false, caseSensitive = false, contextLines = 1, maxMatches = 20 }) {
  if (!store) throw new Error("searchAnchored requires an AnchorStore")
  if (!query || typeof query !== "string") throw new Error("query is required")

  const lines = splitLines(content)
  const anchors = store.reconcile(path, content, { sessionId })
  let matcher
  try {
    matcher = makeMatcher(query, { regex, caseSensitive })
  } catch (e) {
    const text = `[File: ${path}] [Error: ${e.message}]`
    return { path, fileHash: contentHash(content), query, regex, caseSensitive, contextLines, maxMatches, matches: [], text, error: e.message, telemetry: makeTelemetry({ operation: "anchored_search", fullContent: content, requestPayload: { path, sessionId, query, regex, caseSensitive, contextLines, maxMatches }, responseText: text, anchors: [] }) }
  }
  const matches = []

  for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
    if (!matcher(lines[index])) continue
    const start = Math.max(0, index - contextLines)
    const end = Math.min(lines.length, index + contextLines + 1)
    matches.push({
      line: index + 1,
      anchor: anchors[index],
      text: lines[index],
      startLine: start + 1,
      endLine: end,
      snippet: lines.slice(start, end).map((line, offset) => formatAnchoredLine(anchors[start + offset], line)).join("\n"),
    })
  }

  const text = formatSearchText({ path, content, matches, truncated: countMatches(lines, matcher) > matches.length })
  return { path, fileHash: contentHash(content), query, regex, caseSensitive, contextLines, maxMatches, matches, text, telemetry: makeTelemetry({ operation: "anchored_search", fullContent: content, requestPayload: { path, sessionId, query, regex, caseSensitive, contextLines, maxMatches }, responseText: text, anchors: matches.map((match) => match.anchor) }) }
}

function makeMatcher(query, { regex, caseSensitive }) {
  if (regex) {
    if (query.length > 1024) throw new Error("regex pattern too long (max 1024 chars)")
    try {
      const pattern = new RegExp(query, caseSensitive ? "" : "i")
      return (line) => pattern.test(line)
    } catch (e) {
      throw new Error(`invalid regex: ${e.message}`)
    }
  }
  const needle = caseSensitive ? query : query.toLowerCase()
  return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle)
}

function countMatches(lines, matcher) {
  let count = 0
  for (const line of lines) if (matcher(line)) count += 1
  return count
}

function formatSearchText({ path, content, matches, truncated }) {
  const header = `[File: ${path}] [File Hash: ${contentHash(content)}] [Matches: ${matches.length}${truncated ? "+" : ""}]`
  if (matches.length === 0) return `${header}\n(no matches)`
  return `${header}\n${matches.map((match) => `--- match line ${match.line} ---\n${match.snippet}`).join("\n")}`
}
