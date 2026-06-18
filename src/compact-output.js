import { estimateTokens, makeCompressionReceipt } from "./telemetry.js"

const ANSI_RE = /(?:\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]))/g
const PROGRESS_RE = /(?:^|\r)\s*(?:\[[=>.\s-]+\]|[\w ./:-]+)\s+\d{1,3}%.*(?:\r|$)/gm
const PAGE_MARKER_RE = /^\s*(?:--More--|\(END\)|Press .+? to continue|Page \d+(?:\/\d+)?)\s*$/gim

export function compactToolOutput(text, { maxRepeated = 3 } = {}) {
  const original = String(text || "")
  const started = Date.now()
  const cleaned = stripAnsi(original)
    .replace(PROGRESS_RE, "\n")
    .replace(PAGE_MARKER_RE, "")
    .replace(/[ \t]+$/gm, "")
  const lines = cleaned.split(/\r?\n/)
  const compactedLines = collapseRuns(lines, maxRepeated)
  const compacted = compactedLines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd()
  const originalTokens = estimateTokens(original)
  const compressedTokens = estimateTokens(compacted)
  return {
    text: compacted,
    receipt: makeCompressionReceipt({
      strategy: "lossless_tool_result_trim",
      originalTokens,
      compressedTokens,
      timeMs: Date.now() - started,
    }),
  }
}

export function stripAnsi(text) {
  return String(text || "").replace(ANSI_RE, "")
}

function collapseRuns(lines, maxRepeated) {
  const out = []
  let previous = null
  let count = 0

  function flush() {
    if (previous === null) return
    const copies = Math.min(count, maxRepeated)
    for (let i = 0; i < copies; i += 1) out.push(previous)
    const omitted = count - copies
    if (omitted <= 0) return
    const note = `[toolsmith compact-output: previous line repeated ${omitted} more time(s)]`
    const omittedBytes = Buffer.byteLength(Array.from({ length: omitted }, () => previous).join("\n"), "utf8")
    if (Buffer.byteLength(note, "utf8") < omittedBytes) out.push(note)
    else for (let i = 0; i < omitted; i += 1) out.push(previous)
  }

  for (const line of lines) {
    if (line === previous) {
      count += 1
      continue
    }
    flush()
    previous = line
    count = 1
  }
  flush()
  return out
}
