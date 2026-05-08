import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { args, option } from "./argv.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, "..")
const CLI_BIN = path.join(REPO_ROOT, "bin", "toolsmith.js")
const MARKER = "toolsmith-tripwire"
const DEFAULT_MAX_LINES = 200
const DEFAULT_LOG = path.join(homedir(), ".local", "state", "toolsmith", "tripwire.jsonl")

const BINARY_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "pdf", "zip", "gz", "tgz", "mp4", "mov", "sqlite", "db"])

function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function nowIso() {
  return new Date().toISOString()
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12)
}

function redactedHome(filePath) {
  const home = homedir()
  return String(filePath || "").startsWith(home) ? `~${String(filePath).slice(home.length)}` : String(filePath || "")
}

function hookCommand() {
  const script = `. "\${NVM_DIR:-\$HOME/.nvm}/nvm.sh" 2>/dev/null; node ${CLI_BIN} tripwire run --format claude`
  return `bash -c ${sh(script)} # ${MARKER}`
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"))
  } catch (e) {
    if (e.code === "ENOENT") return fallback
    throw e
  }
}

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
}

function isTripwireHook(hook = {}) {
  return typeof hook.command === "string" && (hook.command.includes(MARKER) || hook.command.includes("tripwire run"))
}

function withoutTripwireHooks(hooks = {}) {
  const out = {}
  for (const [event, matchers] of Object.entries(hooks || {})) {
    const kept = []
    for (const matcher of Array.isArray(matchers) ? matchers : []) {
      const nextHooks = (matcher.hooks || []).filter((hook) => !isTripwireHook(hook))
      if (nextHooks.length > 0) kept.push({ ...matcher, hooks: nextHooks })
    }
    if (kept.length > 0) out[event] = kept
  }
  return out
}

export function claudeSettingsPath() {
  return path.join(homedir(), ".claude", "settings.json")
}

export function installClaudeTripwire() {
  const settingsPath = claudeSettingsPath()
  const settings = readJson(settingsPath, {})
  const hooks = withoutTripwireHooks(settings.hooks || {})
  hooks.PreToolUse = hooks.PreToolUse || []
  hooks.PreToolUse.push({
    matcher: "Read|Edit|Write|MultiEdit|Bash",
    hooks: [{ type: "command", command: hookCommand(), timeout: 3000 }],
  })
  writeJson(settingsPath, { ...settings, hooks })
  return settingsPath
}

export function removeClaudeTripwire() {
  const settingsPath = claudeSettingsPath()
  if (!existsSync(settingsPath)) return { settingsPath, removed: false }
  const settings = readJson(settingsPath, {})
  const before = JSON.stringify(settings.hooks || {})
  const hooks = withoutTripwireHooks(settings.hooks || {})
  writeJson(settingsPath, { ...settings, hooks })
  return { settingsPath, removed: before !== JSON.stringify(hooks) }
}

export function claudeTripwireInstalled() {
  const settingsPath = claudeSettingsPath()
  if (!existsSync(settingsPath)) return false
  const settings = readJson(settingsPath, {})
  return Object.values(settings.hooks || {}).some((matchers) =>
    (Array.isArray(matchers) ? matchers : []).some((matcher) => (matcher.hooks || []).some(isTripwireHook)),
  )
}

function normalizeToolCall(data = {}) {
  const toolName = data.tool_name || data.toolName || data.tool || data.name || ""
  const toolInput = data.tool_input || data.toolInput || data.input || data.arguments || data.args || {}
  return { toolName, toolInput }
}

function resolvePath(filePath, cwd = process.cwd()) {
  if (!filePath || typeof filePath !== "string") return null
  const clean = filePath.replace(/^['"]|['"]$/g, "")
  return path.isAbsolute(clean) ? clean : path.resolve(cwd, clean)
}

function countLinesAtLeast(filePath, maxLines = DEFAULT_MAX_LINES) {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (BINARY_EXTS.has(ext)) return null
  let content
  try { content = readFileSync(filePath, "utf8") } catch { return null }
  let lines = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 && ++lines > maxLines) return lines
  }
  return lines
}

function largeFileInfo(filePath, cwd, maxLines = DEFAULT_MAX_LINES) {
  const resolved = resolvePath(filePath, cwd)
  if (!resolved) return null
  let size = 0
  try {
    const st = statSync(resolved)
    if (!st.isFile()) return null
    size = st.size
  } catch {
    return null
  }
  const lines = countLinesAtLeast(resolved, maxLines)
  if (lines === null || lines <= maxLines) return null
  return { file: resolved, displayFile: redactedHome(resolved), lines, size }
}

function contentLarge(content, maxLines = DEFAULT_MAX_LINES) {
  if (typeof content !== "string") return false
  return content.split("\n").length > maxLines
}

function extractPatchFiles(input) {
  const text = typeof input === "string" ? input : input?.input || input?.patch || ""
  return [...String(text).matchAll(/^\*\*\* Update File:\s+(.+)$/gm)].map((match) => match[1].trim())
}

function shellCandidates(command = "") {
  const candidates = []
  const token = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s|;&<>]+))`
  for (const match of String(command).matchAll(new RegExp(String.raw`\bsed\s+-n\s+['"]?(\d+)\s*,\s*(\d+)p['"]?\s+${token}`, "g"))) {
    candidates.push({ kind: "shell-sed", start: Number(match[1]), end: Number(match[2]), file: match[3] || match[4] || match[5] })
  }
  for (const match of String(command).matchAll(new RegExp(String.raw`\bcat\s+${token}`, "g"))) {
    candidates.push({ kind: "shell-cat", file: match[1] || match[2] || match[3] })
  }
  for (const match of String(command).matchAll(new RegExp(String.raw`\bnl\b(?:\s+-[A-Za-z]+)*\s+${token}`, "g"))) {
    candidates.push({ kind: "shell-nl", file: match[1] || match[2] || match[3] })
  }
  return candidates
}

function finding(id, toolName, message, info = {}) {
  return { id, toolName, severity: "nudge", message, ...info }
}

export function evaluateTripwire(data = {}, options = {}) {
  const cwd = options.cwd || data.cwd || process.cwd()
  const maxLines = options.maxLines || DEFAULT_MAX_LINES
  const { toolName, toolInput } = normalizeToolCall(data)

  if (["Read", "Edit", "MultiEdit"].includes(toolName)) {
    const info = largeFileInfo(toolInput.file_path || toolInput.path, cwd, maxLines)
    if (!info) return null
    const edit = toolName === "Read" ? "explore" : "edit"
    const use = toolName === "Read"
      ? "mcp__toolsmith__file_skeleton first, or bounded mcp__toolsmith__anchored_read with startLine/endLine"
      : "mcp__toolsmith__anchored_search/read, then mcp__toolsmith__anchored_edit; use symbol_replace for one function/class"
    return finding(`native-${toolName.toLowerCase()}-large-file`, toolName, `Toolsmith tripwire: ${info.displayFile} is >${maxLines} lines. To ${edit} it, use ${use}.`, info)
  }

  if (toolName === "Write") {
    const info = largeFileInfo(toolInput.file_path || toolInput.path, cwd, maxLines)
    if (info || contentLarge(toolInput.content, maxLines)) {
      return finding("native-write-large-file", toolName, `Toolsmith tripwire: large Write detected. Prefer anchored_edit/anchored_edit_many for existing large files; use Write only for genuinely new generated files.`, info || {})
    }
    return null
  }

  if (["Bash", "Shell", "exec_command"].includes(toolName)) {
    const command = toolInput.command || toolInput.cmd || ""
    for (const candidate of shellCandidates(command)) {
      const info = largeFileInfo(candidate.file, cwd, maxLines)
      if (!info) continue
      const replacement = candidate.kind === "shell-sed"
        ? `mcp__toolsmith__anchored_read startLine=${candidate.start} endLine=${candidate.end}, or mcp__toolsmith__find_and_anchor if this follows a search`
        : "mcp__toolsmith__file_skeleton, mcp__toolsmith__find_and_anchor, or bounded mcp__toolsmith__anchored_read"
      return finding(candidate.kind, toolName, `Toolsmith tripwire: ${candidate.kind.replace("shell-", "")} on ${info.displayFile} (> ${maxLines} lines). Use ${replacement}.`, { ...info, commandHash: hashText(command) })
    }
    return null
  }

  if (toolName === "apply_patch") {
    for (const file of extractPatchFiles(toolInput)) {
      const info = largeFileInfo(file, cwd, maxLines)
      if (!info) continue
      return finding("apply-patch-large-file", toolName, `Toolsmith tripwire: apply_patch is touching ${info.displayFile} (> ${maxLines} lines). Prefer find_and_anchor/anchored_search, then anchored_edit for validated surgical changes.`, info)
    }
  }

  return null
}

function tripwireLogPath() {
  const value = process.env.TOOLSMITH_TRIPWIRE_LOG
  if (value === "0") return null
  return value || DEFAULT_LOG
}

export function logTripwireFinding(findingResult) {
  const logPath = tripwireLogPath()
  if (!logPath || !findingResult) return
  const row = {
    ts: nowIso(),
    id: findingResult.id,
    toolName: findingResult.toolName,
    file: findingResult.displayFile,
    lines: findingResult.lines,
    commandHash: findingResult.commandHash,
  }
  try {
    mkdirSync(path.dirname(logPath), { recursive: true })
    writeFileSync(logPath, `${JSON.stringify(row)}\n`, { flag: "a" })
  } catch {}
}

function formatFinding(findingResult, format) {
  if (!findingResult) return ""
  if (format === "json") return JSON.stringify(findingResult, null, 2)
  if (format === "text") return findingResult.message
  return JSON.stringify({
    decision: "allow",
    systemMessage: findingResult.message,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: findingResult.message,
      systemMessage: findingResult.message,
    },
  })
}

export function tripwireSnippet(client = "all") {
  const claude = `Claude Code tripwire:\n- Install: toolsmith tripwire install --client claude\n- Fires on native Read/Edit/Write/MultiEdit/Bash against likely >200-line files.\n- Nudges toward file_skeleton, find_and_anchor, anchored_read, anchored_edit, or symbol_replace.`
  const codex = `Codex tripwire guidance:\n- Keep Toolsmith MCP registered; lazy-load it with tool_search when mcp__toolsmith__* tools are not visible.\n- Replace broad shell reads like sed -n '1,260p' big.js with anchored_read or file_skeleton.\n- Replace rg && sed with find_and_anchor.\n- Prefer anchored_edit over apply_patch after Toolsmith found the target lines.`
  if (client === "claude") return claude
  if (client === "codex") return codex
  return `${claude}\n\n${codex}`
}

export function summarizeTripwireLog({ sinceMs = 0, logPath = tripwireLogPath() || DEFAULT_LOG } = {}) {
  const summary = { logPath, total: 0, byId: {}, latestTs: null }
  if (!existsSync(logPath)) return summary
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean)
  for (const line of lines) {
    try {
      const row = JSON.parse(line)
      const ts = Date.parse(row.ts || "")
      if (sinceMs && (!Number.isFinite(ts) || ts < sinceMs)) continue
      summary.total += 1
      summary.byId[row.id || "unknown"] = (summary.byId[row.id || "unknown"] || 0) + 1
      if (row.ts && (!summary.latestTs || row.ts > summary.latestTs)) summary.latestTs = row.ts
    } catch {}
  }
  return summary
}

export function runTripwireStatus() {
  const installed = claudeTripwireInstalled()
  console.log(`Claude tripwire: ${installed ? "installed" : "not installed"}`)
  const summary = summarizeTripwireLog()
  console.log(`Log: ${summary.logPath}`)
  if (!summary.total) return
  console.log(`Fires: ${summary.total}`)
  console.log(Object.entries(summary.byId).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `  ${k}: ${v}`).join("\n"))
}

export async function runTripwire() {
  const sub = args[0] || "status"
  if (sub === "run") {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString("utf8")
    const data = raw.trim() ? JSON.parse(raw) : {}
    const result = evaluateTripwire(data)
    if (!result) return
    logTripwireFinding(result)
    const out = formatFinding(result, option("--format") || process.env.TOOLSMITH_TRIPWIRE_FORMAT || "claude")
    if (out) console.log(out)
    return
  }
  if (sub === "install") {
    const client = option("--client") || "claude"
    if (client !== "claude") {
      console.log(tripwireSnippet(client))
      return
    }
    const settingsPath = installClaudeTripwire()
    console.log(`Installed Toolsmith tripwire into ${settingsPath}`)
    return
  }
  if (sub === "remove" || sub === "uninstall") {
    const { settingsPath, removed } = removeClaudeTripwire()
    console.log(`${removed ? "Removed" : "No"} Toolsmith tripwire hook${removed ? ` from ${settingsPath}` : " found"}.`)
    return
  }
  if (sub === "snippet") {
    console.log(tripwireSnippet(option("--client") || "all"))
    return
  }
  if (sub === "status") {
    runTripwireStatus()
    return
  }
  console.error("Usage: toolsmith tripwire run|install|remove|status|snippet [--client claude|codex|all]")
  process.exitCode = 64
}
