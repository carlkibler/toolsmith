import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const CODEX_FOOTER_HOOK_RELATIVE = ".codex/hooks/toolsmith-token-footer.sh"
export const CODEX_FOOTER_COMMAND = "bash ~/.codex/hooks/toolsmith-token-footer.sh"
const CODEX_FOOTER_MATCHER = "toolsmith-token-footer.sh"
const FEATURES_HEADER = "[features]"

function atomicWrite(targetPath, content, mode) {
  mkdirSync(path.dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.toolsmith-tmp`
  writeFileSync(tmp, content, "utf8")
  if (mode !== undefined) chmodSync(tmp, mode)
  try {
    renameSync(tmp, targetPath)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
}

function codexFooterScript(nodePath = process.execPath) {
  return `#!/bin/bash
set -u

if [[ "\${TOOLSMITH_QUIET:-}" =~ ^(1|true|yes|on|debug|verbose)$ ]]; then
  exit 0
fi
case "\${TOOLSMITH_CODEX_FOOTER:-}\${TOOLSMITH_VERBOSE:-}\${TOOLSMITH_DEBUG:-}" in
  "") exit 0 ;;
esac

payload=$(cat)
TOOLSMITH_CODEX_HOOK_PAYLOAD="$payload" ${JSON.stringify(nodePath)} <<'TOOLSMITH_CODEX_FOOTER_JS' || true
const fs = require("node:fs")
const path = require("node:path")

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || ""
}

function compact(value) {
  let n = Number(value || 0)
  if (!Number.isFinite(n)) n = 0
  for (const [suffix, scale] of [["B", 1_000_000_000], ["M", 1_000_000], ["k", 1_000]]) {
    if (Math.abs(n) >= scale) return (n / scale).toFixed(2).replace(/\\.00$/, "") + suffix
  }
  return String(Math.round(n))
}

function comma(value) {
  let n = Number(value || 0)
  if (!Number.isFinite(n)) n = 0
  return Math.round(n).toLocaleString("en-US")
}

function parseTime(raw) {
  if (!raw) return null
  const d = new Date(String(raw))
  return Number.isNaN(d.getTime()) ? null : d
}

function tailLines(filePath, maxBytes) {
  const stat = fs.statSync(filePath)
  const length = Math.min(stat.size, maxBytes)
  const buffer = Buffer.alloc(length)
  const fd = fs.openSync(filePath, "r")
  try {
    fs.readSync(fd, buffer, 0, length, stat.size - length)
  } finally {
    fs.closeSync(fd)
  }
  return buffer.toString("utf8").split(/\\r?\\n/)
}

function toolsmithSaved() {
  const logPath = path.join(homeDir(), ".local/state/toolsmith/usage.jsonl")
  if (!fs.existsSync(logPath)) return 0
  const cutoff = Date.now() - 48 * 60 * 60 * 1000
  let total = 0
  try {
    const lines = tailLines(logPath, 2 * 1024 * 1024)
    for (const raw of lines) {
      if (!raw) continue
      let row
      try { row = JSON.parse(raw) } catch { continue }
      const ts = parseTime(row.ts)
      if (ts && ts.getTime() < cutoff) continue
      const telemetry = row?.result?.telemetry || {}
      total += Number(telemetry.estimatedTokensAvoided || 0)
    }
  } catch {
    return 0
  }
  return Math.max(0, Math.round(total))
}

function latestStatus(payload) {
  const transcript = payload.transcript_path || payload.conversation_path
  if (!transcript || !fs.existsSync(transcript)) return null
  let usage = null
  let limits = null
  try {
    const lines = tailLines(transcript, 512 * 1024)
    for (const raw of lines) {
      if (!raw.includes("token_count")) continue
      let row
      try { row = JSON.parse(raw) } catch { continue }
      const event = row.payload || {}
      if (event.type !== "token_count") continue
      const info = event.info || {}
      const nextUsage = info.total_token_usage || info.last_token_usage
      if (nextUsage) usage = nextUsage
      if (row.rate_limits) limits = row.rate_limits
    }
  } catch {
    return null
  }
  return { usage, limits }
}

function formatReset(seconds) {
  const reset = Number(seconds || 0)
  if (!Number.isFinite(reset) || reset <= 0) return ""
  const left = Math.max(0, Math.round(reset - Date.now() / 1000))
  const days = Math.floor(left / 86400)
  const hours = Math.floor((left % 86400) / 3600)
  const mins = Math.floor((left % 3600) / 60)
  if (days > 0) return \`\${days}d\${hours}h\`
  if (hours > 0) return \`\${hours}h\${mins}m\`
  return \`\${mins}m\`
}

function formatLimit(label, window) {
  if (!window) return ""
  const used = Number(window.used_percent)
  if (!Number.isFinite(used)) return ""
  const remaining = Math.max(0, Math.min(100, 100 - used))
  const reset = formatReset(window.resets_at)
  return \`\${label} \${remaining.toFixed(0)}%\${reset ? " ↺" + reset : ""}\`
}

function formatLimits(limits) {
  if (!limits) return ""
  return [
    formatLimit("5h", limits.primary),
    formatLimit("7d", limits.secondary),
  ].filter(Boolean).join(" ")
}

function formatUsage(usage) {
  if (!usage) return ""
  return "Codex usage: total=" + comma(usage.total_tokens) + " input=" + comma(usage.input_tokens) + " " +
    "(+ " + comma(usage.cached_input_tokens) + " cached) output=" + comma(usage.output_tokens) + " " +
    "(reasoning " + comma(usage.reasoning_output_tokens) + ")"
}

function formatSavings(saved, usage) {
  const savedTokens = Math.max(0, Math.round(Number(saved || 0)))
  if (!savedTokens) return ""
  const usageTokens = usage ? Number(usage.total_tokens || 0) : 0
  const savedText = comma(savedTokens) + " tokens/48h"
  if (Number.isFinite(usageTokens) && usageTokens > 0) {
    const pct = savedTokens / (savedTokens + usageTokens) * 100
    const pctText = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)
    return "Toolsmith token reduction: " + pctText + "% (total savings: " + savedText + ")"
  }
  return "Toolsmith total token savings: " + savedText
}

function enabledByEnv(value) {
  return /^(1|true|yes|on|debug|verbose)$/i.test(String(value || ""))
}

function footerEnabled(payload) {
  if (enabledByEnv(process.env.TOOLSMITH_QUIET)) return false
  if (enabledByEnv(process.env.TOOLSMITH_CODEX_FOOTER)) return true
  if (enabledByEnv(process.env.TOOLSMITH_VERBOSE)) return true
  if (enabledByEnv(process.env.TOOLSMITH_DEBUG)) return true
  return false
}

let payload = {}
try { payload = JSON.parse(process.env.TOOLSMITH_CODEX_HOOK_PAYLOAD || "{}") } catch {}
if (!footerEnabled(payload)) process.exit(0)

const saved = toolsmithSaved()
const status = latestStatus(payload) || {}
const codexText = [formatUsage(status.usage), formatLimits(status.limits)].filter(Boolean).join(" • ")
const savingsText = formatSavings(saved, status.usage)
if (savingsText && codexText) {
  console.log(savingsText + " • " + codexText)
} else if (savingsText) {
  console.log(savingsText)
} else if (codexText) {
  console.log(codexText)
}
TOOLSMITH_CODEX_FOOTER_JS

exit 0
`
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isToolsmithFooterHook(hook) {
  return typeof hook?.command === "string" && hook.command.includes(CODEX_FOOTER_MATCHER)
}

export function ensureCodexHooksFeatureFlag(configPath) {
  let existing = ""
  try { existing = readFileSync(configPath, "utf8") } catch (e) { if (e.code !== "ENOENT") throw e }

  const lines = existing.split(/\r?\n/)
  if (lines.length && lines.at(-1) === "") lines.pop()

  let start = lines.findIndex((line) => line.trim() === FEATURES_HEADER)
  if (start === -1) {
    const prefix = lines.length > 0 ? `${lines.join("\n").trimEnd()}\n\n` : ""
    const updated = `${prefix}${FEATURES_HEADER}\nhooks = true\n`
    if (updated === existing) return { changed: false }
    atomicWrite(configPath, updated)
    return { changed: true }
  }

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) { end = i; break }
  }

  const out = [...lines]
  let hooksIndex = -1
  let firstCodexHooksIndex = -1
  for (let i = start + 1; i < end; i++) {
    const trimmed = out[i].trim()
    if (/^hooks\s*=/.test(trimmed) && hooksIndex === -1) hooksIndex = i
    if (/^codex_hooks\s*=/.test(trimmed) && firstCodexHooksIndex === -1) firstCodexHooksIndex = i
  }

  for (let i = end - 1; i > start; i--) {
    if (/^codex_hooks\s*=/.test(out[i].trim())) {
      out.splice(i, 1)
      if (i < hooksIndex) hooksIndex--
      end--
    }
  }

  if (hooksIndex !== -1) {
    out[hooksIndex] = out[hooksIndex].replace(/^\s*hooks\s*=.*$/, "hooks = true")
  } else {
    const insertAt = firstCodexHooksIndex !== -1 ? Math.min(firstCodexHooksIndex, end) : start + 1
    out.splice(insertAt, 0, "hooks = true")
  }

  const updated = `${out.join("\n").trimEnd()}\n`
  if (updated === existing) return { changed: false }
  atomicWrite(configPath, updated)
  return { changed: true }
}

export function installCodexFooterHookConfig(hooksPath) {
  let existing = ""
  try { existing = readFileSync(hooksPath, "utf8") } catch (e) { if (e.code !== "ENOENT") throw e }

  let data
  try {
    data = existing.trim() ? JSON.parse(existing) : {}
  } catch (e) {
    return { changed: false, skipped: true, reason: `hooks.json is not valid JSON (${e.message})` }
  }
  if (!isPlainObject(data)) return { changed: false, skipped: true, reason: "hooks.json root is not an object" }
  if (data.hooks === undefined) data.hooks = {}
  if (!isPlainObject(data.hooks)) return { changed: false, skipped: true, reason: "hooks.json hooks field is not an object" }
  if (data.hooks.Stop === undefined) data.hooks.Stop = []
  if (!Array.isArray(data.hooks.Stop)) return { changed: false, skipped: true, reason: "hooks.json hooks.Stop is not an array" }

  let targetGroup = null
  for (const group of data.hooks.Stop) {
    if (!isPlainObject(group)) return { changed: false, skipped: true, reason: "hooks.Stop contains a non-object entry" }
    if (group.hooks === undefined) group.hooks = []
    if (!Array.isArray(group.hooks)) return { changed: false, skipped: true, reason: "hooks.Stop entry hooks field is not an array" }
    group.hooks = group.hooks.filter((hook) => !isToolsmithFooterHook(hook))
    if ((group.matcher || "") === "" && targetGroup === null) targetGroup = group
  }

  if (!targetGroup) {
    targetGroup = { matcher: "", hooks: [] }
    data.hooks.Stop.push(targetGroup)
  }
  targetGroup.hooks.unshift({ type: "command", command: CODEX_FOOTER_COMMAND, timeout: 10 })

  const updated = `${JSON.stringify(data, null, 2)}\n`
  if (updated === existing) return { changed: false, skipped: false }
  atomicWrite(hooksPath, updated)
  return { changed: true, skipped: false }
}

export function installCodexFooter({ nodePath = process.execPath } = {}) {
  const codexDir = path.join(homedir(), ".codex")
  if (!existsSync(codexDir)) return { status: "skipped", message: "Codex footer: not found — skipping" }

  const scriptPath = path.join(homedir(), CODEX_FOOTER_HOOK_RELATIVE)
  const script = codexFooterScript(nodePath)
  let scriptChanged = true
  try { scriptChanged = readFileSync(scriptPath, "utf8") !== script } catch {}
  if (scriptChanged) atomicWrite(scriptPath, script, 0o755)

  const configPath = path.join(codexDir, "config.toml")
  const featureResult = ensureCodexHooksFeatureFlag(configPath)

  const hooksPath = path.join(codexDir, "hooks.json")
  const hookResult = installCodexFooterHookConfig(hooksPath)
  if (hookResult.skipped) {
    return { status: "skipped", message: `Codex footer: skipped — ${hookResult.reason}` }
  }
  const changed = scriptChanged || featureResult.changed || hookResult.changed
  const state = changed ? "installed" : "already installed"
  return { status: changed ? "installed" : "present", message: `Codex footer: ${state} (opt-in via TOOLSMITH_CODEX_FOOTER=1)` }
}
