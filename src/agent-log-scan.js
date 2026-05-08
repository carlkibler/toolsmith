import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const TOOLSMITH_TOOLS = new Set([
  "anchored_read",
  "anchored_search",
  "anchored_edit",
  "anchored_edit_many",
  "file_skeleton",
  "find_and_anchor",
  "get_function",
  "symbol_replace",
  "anchored_edit_status",
])

const NATIVE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".beads", ".dolt"])
const SENSITIVE_RE = /(token|secret|password|credential|key|private|oauth|cookie)/i
const STOPWORDS = new Set("a an and are as at be been but by can codex could did do does doing done for from get had has have how i if in is it its just like make me my not of on or our out please run see should so that the this to too up use using want was we what when where which why with would you your".split(" "))

const THEME_PATTERNS = [
  ["release/deploy", /\b(release|deploy|publish|push|commit|tag|cpd?\b)/i],
  ["debugging/broken", /\b(broken|bug|debug|diagnos|failing|failure|fix|not working|regression|why)\b/i],
  ["trust/privacy/safety", /\b(trust|privacy|safe|safety|creepy|permission|billing|pricing|auth|secret)\b/i],
  ["visual/ui qa", /\b(screenshot|visual|ui|ux|design|hover|copy|label|onboarding)\b/i],
  ["agent productivity", /\b(agent|codex|claude|toolsmith|skill|workflow|jank|logging|audit|memory)\b/i],
  ["local machine ops", /\b(mac|machine|remote|ssh|install|setup|update|doctor|brew|chezmoi)\b/i],
  ["project planning", /\b(plan|roadmap|todo|beads|ticket|task|issue|follow.?up)\b/i],
  ["web/research", /\b(search|browse|docs|latest|research|source|web)\b/i],
]

const FRUSTRATION_PATTERNS = [
  ["why/confusing", /\b(why|confusing|odd|weird|not sure what happened|what happened)\b/i],
  ["jank/friction", /\b(jank|annoy|pain in the ass|wonky|flaky|futz|friction)\b/i],
  ["surprise/regression", /\b(suddenly|used to|regression|unexpected|surprising|again|every run)\b/i],
  ["quality/surety", /\b(make sure|verify|test|confirm|real|actual|evidence)\b/i],
]

export function scanAgentLogs({
  days = 7,
  home = os.homedir(),
  host = os.hostname(),
  maxExamples = 12,
  includeExamples = true,
  claudeRoot = path.join(home, ".claude", "projects"),
  codexRoot = path.join(home, ".codex", "sessions"),
} = {}) {
  const sinceMs = Date.now() - Number(days || 7) * 24 * 60 * 60 * 1000
  const stats = makeStats({ host, days: Number(days || 7), home, claudeRoot, codexRoot, maxExamples, includeExamples })

  for (const file of recentJsonlFiles(claudeRoot, sinceMs)) processClaudeFile(file, stats)
  for (const file of recentJsonlFiles(codexRoot, sinceMs)) processCodexFile(file, stats)

  return finalizeStats(stats)
}

export function scanRemoteAgentLogs({ remote, days = 7, maxExamples = 12 } = {}) {
  if (!remote) throw new Error("--remote requires a host")
  const result = spawnSync("ssh", [remote, "toolsmith", "scan-agent-logs", "--json", "--days", String(days), "--max-examples", String(maxExamples)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 })
  const output = stripTerminalNoise(`${result.stdout || ""}\n${result.stderr || ""}`)
  const start = output.indexOf("{")
  const end = output.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) throw new Error(`remote scan did not return JSON${result.stderr ? ` — ${result.stderr.trim()}` : ""}`)
  return JSON.parse(output.slice(start, end + 1))
}

export function formatAgentLogScanMarkdown(scan) {
  const rows = [
    ["Agent", "Sessions", "Records", "Top tools"],
    ["Claude", scan.sessions.claude || 0, scan.records.claude || 0, formatCounts(scan.tools.claude, 6)],
    ["Codex", scan.sessions.codex || 0, scan.records.codex || 0, formatCounts(scan.tools.codex, 6)],
  ]

  return [
    `# Agent log scan — ${scan.host} (${scan.days} day${scan.days === 1 ? "" : "s"})`,
    "",
    `Generated: ${scan.generatedAt}`,
    `Paths: Claude ${scan.paths.claude}; Codex ${scan.paths.codex}`,
    "",
    markdownTable(rows),
    "",
    "## Toolsmith adoption",
    "",
    `- Toolsmith calls: ${scan.toolsmith.toolCalls} across ${scan.toolsmith.sessions} session(s).`,
    `- Tools: ${formatCounts(scan.toolsmith.byTool, 10)}.`,
    `- CLI mentions: ${scan.toolsmith.cliMentions}; activation searches: ${scan.toolsmith.activationSearches}.`,
    "",
    "## Lost opportunities",
    "",
    `- Hard lost opportunities: ${scan.lostOpportunities.total}.`,
    `- Codex apply_patch large-file candidates: ${scan.lostOpportunities.editCandidates}.`,
    `- By kind: ${formatCounts(scan.lostOpportunities.byKind, 10)}.`,
    ...(lostTokenSavingsEstimate(scan.lostOpportunities.lostLines) ? [`- Token estimate: ${lostTokenSavingsEstimate(scan.lostOpportunities.lostLines)}.`] : []),
    "",
    ...formatExamples(scan),
    "## Interaction signals",
    "",
    `- Themes: ${formatCounts(scan.interactionSignals.themes, 10)}.`,
    `- Frustration/surety: ${formatCounts(scan.interactionSignals.frustrationSignals, 10)}.`,
    `- Workspaces: ${formatCounts(scan.workspaceNames, 12)}.`,
    "",
    "## Next moves",
    "",
    "- If hard opportunities are high, strengthen the client instructions and prefer `file_skeleton`, `find_and_anchor`, `get_function`, or `anchored_read` before native large-file reads/edits.",
    "- Treat `apply_patch` candidates as validation/telemetry opportunities, not automatic mistakes.",
  ].join("\n")
}

export function lostTokenSavingsEstimate(lostLines) {
  if (!lostLines) return null
  const transferred = Math.round(lostLines * 12.5)
  const saved = Math.round(transferred * 0.7)
  const usd = (saved / 1_000_000 * 15).toFixed(2)
  return `~${(transferred / 1000).toFixed(0)}k ctx tokens; toolsmith saves ~${(saved / 1000).toFixed(0)}k (~$${usd} at $15/M)`
}

export function formatOpportunitiesText(scan) {
  const lines = [
    `toolsmith opportunities (${scan.host}, ${scan.days} day${scan.days === 1 ? "" : "s"})`,
    `sessions: Claude ${scan.sessions.claude || 0}, Codex ${scan.sessions.codex || 0}`,
    `toolsmith calls: ${scan.toolsmith.toolCalls} across ${scan.toolsmith.sessions} session(s)`,
    `hard lost opportunities: ${scan.lostOpportunities.total}`,
    `apply_patch candidates: ${scan.lostOpportunities.editCandidates}`,
    `by kind: ${formatCounts(scan.lostOpportunities.byKind, 12)}`,
  ]
  const tokenEst = lostTokenSavingsEstimate(scan.lostOpportunities.lostLines)
  if (tokenEst) lines.push(`token estimate: ${tokenEst}`)
  if (scan.lostOpportunities.examples?.length) {
    lines.push("", "examples:")
    for (const example of scan.lostOpportunities.examples.slice(0, 8)) {
      lines.push(`  - ${example.agent} ${example.kind}: ${example.file || "unknown"}${example.lines ? ` (${example.lines} lines)` : ""} -> ${example.use}`)
    }
  }
  return lines.join("\n")
}

export function adoptionSnippet(client = "all") {
  const block = `## Toolsmith large-file rule\n\nToolsmith is the default path for code navigation and surgical edits on files likely over 200 lines. Use native Read/Edit/Write, shell \`cat\`, \`nl\`, or broad \`sed -n\` only for genuinely small files, command output, or unavailable Toolsmith tools.\n\n- Explore structure first: \`file_skeleton\`\n- Find editable matches: \`find_and_anchor\` or \`anchored_search\`\n- Read one known symbol: \`get_function\`\n- Read a precise range: \`anchored_read --start/--end\`\n- Edit anchored lines: \`anchored_edit\` or \`anchored_edit_many\`\n- Single-symbol replacement: \`symbol_replace\`\n\nIf a native large-file read already happened, switch to Toolsmith before editing so anchors, validation, and telemetry exist.`

  const codex = `${block}\n\nCodex shell habit replacements:\n- \`sed -n '1,260p' big.js\` -> \`anchored_read\` with a narrower range, or \`file_skeleton\` first\n- \`rg pattern && sed -n ...\` -> \`find_and_anchor\`\n- \`apply_patch\` on a large file is allowed, but prefer \`anchored_edit\` when changing lines already found by Toolsmith.`
  const claude = `${block}\n\nClaude tool habit replacements:\n- Native Read on >200 lines -> \`file_skeleton\`, \`get_function\`, or bounded \`anchored_read\`\n- Native Edit/Write on >200 lines -> read anchors first, then \`anchored_edit\`\n- For one function/class body, \`symbol_replace\` is the fastest path.`
  const gemini = `${block}\n\nGemini CLI note: call Toolsmith MCP tools directly when editing large files; do not rely on shell excerpts unless the requested range is already small.`

  if (client === "codex") return codex
  if (client === "claude") return claude
  if (client === "gemini") return gemini
  return [`# Claude Code`, claude, ``, `# Codex`, codex, ``, `# Gemini CLI`, gemini].join("\n")
}

function makeStats({ host, days, home, claudeRoot, codexRoot, maxExamples, includeExamples }) {
  return {
    host,
    days,
    generatedAt: new Date().toISOString(),
    home,
    paths: { claude: redactPath(claudeRoot, home), codex: redactPath(codexRoot, home) },
    maxExamples,
    includeExamples,
    sessions: { claude: 0, codex: 0 },
    records: { claude: 0, codex: 0 },
    tools: { claude: new Map(), codex: new Map() },
    toolsmith: { toolCalls: 0, byTool: new Map(), sessions: new Set(), cliMentions: 0, activationSearches: 0 },
    lost: {
      total: 0,
      editCandidates: 0,
      lostLines: 0,
      byKind: new Map(),
      examples: [],
      exampleKeys: new Set(),
      editCandidateExamples: [],
      editCandidateExampleKeys: new Set(),
    },
    themes: new Map(),
    frustrationSignals: new Map(),
    userTerms: new Map(),
    workspaceNames: new Map(),
    userMessages: 0,
    userChars: 0,
    badLines: 0,
    lineCounts: new Map(),
  }
}

function finalizeStats(stats) {
  return {
    host: stats.host,
    days: stats.days,
    generatedAt: stats.generatedAt,
    paths: stats.paths,
    sessions: stats.sessions,
    records: stats.records,
    userMessages: stats.userMessages,
    userChars: stats.userChars,
    workspaceNames: topEntries(stats.workspaceNames, 30),
    tools: { claude: topEntries(stats.tools.claude, 40), codex: topEntries(stats.tools.codex, 40) },
    toolsmith: {
      toolCalls: stats.toolsmith.toolCalls,
      sessions: stats.toolsmith.sessions.size,
      byTool: topEntries(stats.toolsmith.byTool, 20),
      cliMentions: stats.toolsmith.cliMentions,
      activationSearches: stats.toolsmith.activationSearches,
    },
    lostOpportunities: {
      total: stats.lost.total,
      editCandidates: stats.lost.editCandidates,
      lostLines: stats.lost.lostLines,
      byKind: topEntries(stats.lost.byKind, 30),
      examples: stats.lost.examples,
      editCandidateExamples: stats.lost.editCandidateExamples,
    },
    interactionSignals: {
      themes: topEntries(stats.themes, 20),
      frustrationSignals: topEntries(stats.frustrationSignals, 20),
      userTerms: topEntries(stats.userTerms, 40),
    },
    badLines: stats.badLines,
  }
}

function processClaudeFile(file, stats) {
  stats.sessions.claude += 1
  let cwd = null
  const pending = new Map()

  for (const record of readJsonl(file, stats)) {
    stats.records.claude += 1
    cwd = record.cwd || cwd
    if (cwd) inc(stats.workspaceNames, path.basename(cwd))
    const message = record.message
    if (record.type === "user" && message) classifyUserText(extractClaudeText(message), stats)
    const content = Array.isArray(message?.content) ? message.content : []
    for (const item of content) {
      if (item?.type === "tool_use") {
        const name = item.name || "unknown"
        inc(stats.tools.claude, name)
        trackToolsmith(name, stats, file)
        const input = item.input || {}
        pending.set(item.id, { name, input, cwd, ts: record.timestamp, file })
        if (NATIVE_EDIT_TOOLS.has(name)) classifyNativeEdit({ agent: "claude", name, input, cwd, ts: record.timestamp, sessionPath: file }, stats)
        if (name === "Bash") classifyShellCommand(input.command, cwd, { agent: "claude", ts: record.timestamp, sessionPath: file }, stats)
      } else if (item?.type === "tool_result") {
        const ref = pending.get(item.tool_use_id)
        if (ref?.name === "Read") classifyNativeRead({ agent: "claude", ref, resultContent: item.content }, stats)
      }
    }
  }
}

function processCodexFile(file, stats) {
  stats.sessions.codex += 1
  let cwd = null

  for (const record of readJsonl(file, stats)) {
    stats.records.codex += 1
    const payload = record.payload && typeof record.payload === "object" ? record.payload : {}
    if (record.type === "session_meta" || record.type === "turn_context") {
      cwd = payload.cwd || cwd
      if (cwd) inc(stats.workspaceNames, path.basename(cwd))
      continue
    }
    if (record.type !== "response_item") continue
    if (payload.type === "message" && payload.role === "user") classifyUserText(extractCodexText(payload), stats)
    if (payload.type === "function_call") {
      const name = payload.name || "unknown"
      inc(stats.tools.codex, name)
      trackToolsmith(name, stats, file)
      if (name === "tool_search_tool" && /toolsmith|anchored|file_skeleton|symbol_replace/i.test(payload.arguments || "")) stats.toolsmith.activationSearches += 1
      if (name === "exec_command") {
        const parsed = parseJson(payload.arguments, {})
        classifyShellCommand(parsed.cmd, parsed.workdir || cwd, { agent: "codex", ts: record.timestamp, sessionPath: file }, stats)
      }
    } else if (payload.type === "custom_tool_call") {
      const name = payload.name || "unknown"
      inc(stats.tools.codex, name)
      if (name === "apply_patch") classifyApplyPatchCandidate(payload.input, cwd, { ts: record.timestamp, sessionPath: file }, stats)
    } else if (payload.type === "tool_search_call" && /toolsmith|anchored|file_skeleton|symbol_replace/i.test(JSON.stringify(payload))) {
      stats.toolsmith.activationSearches += 1
    }
  }
}

function classifyNativeRead({ agent, ref, resultContent }, stats) {
  const input = ref.input || {}
  const target = resolveTarget(input.file_path || input.path, ref.cwd)
  const lines = cachedLineCount(target, stats)
  const resultLines = countContentLines(resultContent)
  const limit = Number(input.limit || 0)
  const large = (resultLines && resultLines > 220) || (lines && lines > 200 && (!limit || limit > 160))
  if (!large) return
  addLost(stats, "claude_native_read_large_file", {
    agent,
    kind: "native Read on large file",
    timestamp: ref.ts,
    session: redactPath(ref.file, stats.home),
    cwd: redactPath(ref.cwd, stats.home),
    file: redactPath(target, stats.home),
    lines: lines || resultLines,
    resultLines,
    why: "native Read returned/read a large file where Toolsmith would be cheaper and editable",
    use: "file_skeleton, get_function, find_and_anchor, or bounded anchored_read",
  })
}

function classifyNativeEdit({ agent, name, input, cwd, ts, sessionPath }, stats) {
  const target = resolveTarget(input.file_path || input.path, cwd)
  const lines = cachedLineCount(target, stats)
  if (!lines || lines <= 200) return
  addLost(stats, "claude_native_edit_large_file", {
    agent,
    kind: `native ${name} on large file`,
    timestamp: ts,
    session: redactPath(sessionPath, stats.home),
    cwd: redactPath(cwd, stats.home),
    file: redactPath(target, stats.home),
    lines,
    why: `native ${name} touched a >200-line file`,
    use: "anchored_read then anchored_edit, or symbol_replace for one symbol",
  })
}

function classifyShellCommand(command, cwd, meta, stats) {
  if (!command) return
  if (/toolsmith/i.test(command)) stats.toolsmith.cliMentions += 1
  if (/\b(rg|grep)\b.*(mcp__toolsmith|anchored_read|file_skeleton|symbol_replace|toolsmith)/i.test(command)) stats.toolsmith.activationSearches += 1

  const patterns = [
    ["cat", /(?:^|[;&|]\s*)cat\s+([^;&|`$<>]+)/g],
    ["nl", /(?:^|[;&|]\s*)nl\s+(?:-[a-zA-Z0-9 ]+\s+)*([^;&|`$<>]+)/g],
    ["sed", /sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+([^;&|`$<>]+)/g],
    ["head", /head(?:\s+-n\s+(\d+))?\s+([^;&|`$<>]+)/g],
    ["tail", /tail(?:\s+-n\s+(\d+))?\s+([^;&|`$<>]+)/g],
  ]

  for (const [kind, pattern] of patterns) {
    for (const match of command.matchAll(pattern)) {
      const pathText = kind === "sed" ? match[3] : kind === "head" || kind === "tail" ? match[2] : match[1]
      const requested = kind === "sed" ? Number(match[2]) - Number(match[1]) + 1 : kind === "head" || kind === "tail" ? Number(match[1] || 10) : null
      const target = resolveTarget(firstShellToken(pathText), cwd)
      const lines = cachedLineCount(target, stats)
      if (!lines || lines <= 200) continue
      const hard = kind === "cat" || kind === "nl" || (requested && requested > 160)
      if (!hard) continue
      addLost(stats, `${meta.agent}_shell_${kind}_large_file`, {
        agent: meta.agent,
        kind: `shell ${kind} on large file`,
        timestamp: meta.ts,
        session: redactPath(meta.sessionPath, stats.home),
        cwd: redactPath(cwd, stats.home),
        file: redactPath(target, stats.home),
        lines,
        why: `native shell ${kind} likely transferred too much of a large file`,
        use: kind === "sed" ? "anchored_read with a narrower range, file_skeleton, or find_and_anchor" : "file_skeleton, find_and_anchor, or anchored_read",
        snippet: redactSnippet(command),
      })
    }
  }
}

function classifyApplyPatchCandidate(input, cwd, meta, stats) {
  for (const file of patchFiles(input || "")) {
    const target = resolveTarget(file, cwd)
    const lines = cachedLineCount(target, stats)
    if (!lines || lines <= 200) continue
    stats.lost.editCandidates += 1
    stats.lost.lostLines += lines
    inc(stats.lost.byKind, "codex_apply_patch_large_file")
    addExample(stats.lost.editCandidateExamples, stats.lost.editCandidateExampleKeys, stats.maxExamples, stats.includeExamples, {
        agent: "codex",
        kind: "apply_patch on large file",
        timestamp: meta.ts,
        session: redactPath(meta.sessionPath, stats.home),
        cwd: redactPath(cwd, stats.home),
        file: redactPath(target, stats.home),
        lines,
        why: "not necessarily wrong; anchored_edit would add anchor validation and Toolsmith telemetry",
        use: "find_and_anchor or anchored_search/read, then anchored_edit for surgical changes",
    })
  }
}

function addLost(stats, kind, example) {
  stats.lost.total += 1
  stats.lost.lostLines += (example.lines || 0)
  inc(stats.lost.byKind, kind)
  addExample(stats.lost.examples, stats.lost.exampleKeys, stats.maxExamples, stats.includeExamples, example)
}

function addExample(examples, keys, maxExamples, includeExamples, example) {
  if (!includeExamples || examples.length >= maxExamples) return
  const key = [example.agent, example.kind, example.file || "", example.lines || "", example.use || ""].join("\0")
  if (keys.has(key)) return
  keys.add(key)
  examples.push(example)
}

function trackToolsmith(name, stats, file) {
  const tool = name.startsWith("mcp__toolsmith__") ? name.split("__").at(-1) : name
  if (!TOOLSMITH_TOOLS.has(tool)) return
  stats.toolsmith.toolCalls += 1
  stats.toolsmith.sessions.add(file)
  inc(stats.toolsmith.byTool, tool)
}

function classifyUserText(text, stats) {
  if (!text) return
  stats.userMessages += 1
  stats.userChars += text.length
  for (const [label, pattern] of THEME_PATTERNS) if (pattern.test(text)) inc(stats.themes, label)
  for (const [label, pattern] of FRUSTRATION_PATTERNS) if (pattern.test(text)) inc(stats.frustrationSignals, label)
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9_+-]{2,}/g) || []) {
    if (!STOPWORDS.has(word) && word.length < 30) inc(stats.userTerms, word)
  }
}

function recentJsonlFiles(root, sinceMs) {
  const files = []
  if (!root || !fs.existsSync(root)) return files
  walk(root, (file, dirent) => {
    if (!dirent.isFile() || !file.endsWith(".jsonl")) return
    try {
      if (fs.statSync(file).mtimeMs >= sinceMs) files.push(file)
    } catch {}
  })
  return files.sort((a, b) => safeMtime(b) - safeMtime(a))
}

function walk(root, visit) {
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, visit)
    } else {
      visit(full, entry)
    }
  }
}

function readJsonl(file, stats) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { stats.badLines += 1; return null }
    }).filter(Boolean)
  } catch {
    stats.badLines += 1
    return []
  }
}

function cachedLineCount(target, stats) {
  if (!target) return null
  if (stats.lineCounts.has(target)) return stats.lineCounts.get(target)
  let count = null
  try {
    const st = fs.statSync(target)
    if (st.isFile() && st.size <= 3_000_000) {
      const buf = fs.readFileSync(target)
      if (!buf.subarray(0, 4096).includes(0)) count = buf.toString("utf8").split(/\r?\n/u).length
    }
  } catch {}
  stats.lineCounts.set(target, count)
  return count
}

function resolveTarget(value, cwd) {
  if (!value || typeof value !== "string") return null
  let target = value.trim().replace(/^['"]|['"]$/g, "")
  if (!target || target.startsWith("-") || target.startsWith("$") || target === "/dev/null") return null
  if (target.startsWith("~")) return path.join(os.homedir(), target.slice(1))
  if (path.isAbsolute(target)) return path.normalize(target)
  return cwd ? path.resolve(cwd, target) : path.resolve(target)
}

function firstShellToken(text) {
  if (!text) return ""
  const cleaned = text.trim()
  const match = cleaned.match(/^(['"])(.*?)\1/u)
  if (match) return match[2]
  return cleaned.split(/\s+/u)[0]
}

function patchFiles(input) {
  const files = []
  for (const line of String(input || "").split(/\r?\n/u)) {
    const match = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/u)
    if (match) files.push(match[1].trim())
  }
  return files
}

function extractClaudeText(message) {
  if (typeof message?.content === "string") return message.content
  if (!Array.isArray(message?.content)) return ""
  return message.content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n")
}

function extractCodexText(payload) {
  return (payload.content || []).filter((item) => item?.type === "input_text" && typeof item.text === "string").map((item) => item.text).join("\n")
}

function countContentLines(content) {
  if (typeof content === "string") return content.split(/\r?\n/u).length
  if (!Array.isArray(content)) return null
  const text = content.map((item) => typeof item === "string" ? item : item?.text || item?.content || "").filter(Boolean).join("\n")
  return text ? text.split(/\r?\n/u).length : null
}

function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function inc(map, key, amount = 1) {
  map.set(key || "unknown", (map.get(key || "unknown") || 0) + amount)
}

function topEntries(map, limit) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, count]) => ({ key, count }))
}

function formatCounts(entries, limit = 0) {
  const visible = limit ? entries.slice(0, limit) : entries
  if (!visible.length) return "none"
  const suffix = limit && entries.length > limit ? `, +${entries.length - limit} more` : ""
  return `${visible.map((entry) => `${entry.key} ${entry.count}`).join(", ")}${suffix}`
}

function markdownTable(rows) {
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => String(row[index]).length)))
  return rows.map((row, rowIndex) => {
    const rendered = `| ${row.map((cell, index) => String(cell).padEnd(widths[index])).join(" | ")} |`
    if (rowIndex !== 0) return rendered
    return `${rendered}\n| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`
  }).join("\n")
}

function formatExamples(scan) {
  const lines = []
  if (scan.lostOpportunities.examples?.length) {
    lines.push("### Examples", "")
    for (const example of scan.lostOpportunities.examples.slice(0, 8)) {
      lines.push(`- ${example.agent} ${example.kind}: \`${example.file || "unknown"}\`${example.lines ? ` (${example.lines} lines)` : ""} -> ${example.use}.`)
    }
    lines.push("")
  }
  if (scan.lostOpportunities.editCandidateExamples?.length) {
    lines.push("### Candidate examples", "")
    for (const example of scan.lostOpportunities.editCandidateExamples.slice(0, 6)) {
      lines.push(`- ${example.agent} ${example.kind}: \`${example.file || "unknown"}\`${example.lines ? ` (${example.lines} lines)` : ""} -> ${example.use}.`)
    }
    lines.push("")
  }
  return lines
}

function redactPath(value, home = os.homedir()) {
  if (!value) return value
  let out = String(value).replace(home, "~")
  if (SENSITIVE_RE.test(out)) {
    const parts = out.split(path.sep)
    parts[parts.length - 1] = "[redacted-name]"
    out = parts.join(path.sep)
  }
  const parts = out.split(path.sep)
  if (parts.length > 8) out = [parts[0] || path.sep, "…", ...parts.slice(-5)].join(path.sep).replace(/\/\//g, "/")
  return out
}

function redactSnippet(command) {
  return String(command || "").replace(/\s+/g, " ").replace(/(token|password|secret|key|credential)=\S+/ig, "$1=[redacted]").slice(0, 160)
}

function safeMtime(file) {
  try { return fs.statSync(file).mtimeMs } catch { return 0 }
}

function stripTerminalNoise(text) {
  return String(text || "").replace(/\x1bc/g, "").replace(/stty: stdin isn't a terminal\s*/g, "")
}
