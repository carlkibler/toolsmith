import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const CODEX_FOOTER_HOOK_RELATIVE = ".codex/hooks/toolsmith-token-footer.sh"
export const CODEX_FOOTER_COMMAND = "bash ~/.codex/hooks/toolsmith-token-footer.sh"
const CODEX_FOOTER_MATCHER = "toolsmith-token-footer.sh"

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

function toolsmithSaved() {
  const logPath = path.join(homeDir(), ".local/state/toolsmith/usage.jsonl")
  if (!fs.existsSync(logPath)) return 0
  const cutoff = Date.now() - 48 * 60 * 60 * 1000
  let total = 0
  try {
    const lines = fs.readFileSync(logPath, "utf8").split(/\\r?\\n/)
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
    const lines = fs.readFileSync(transcript, "utf8").split(/\\r?\\n/)
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

function enabledByEnv(value) {
  return /^(1|true|yes|on|debug|verbose)$/i.test(String(value || ""))
}

function footerEnabled(payload) {
  if (enabledByEnv(process.env.TOOLSMITH_QUIET)) return false
  if (enabledByEnv(process.env.TOOLSMITH_CODEX_FOOTER)) return true
  if (enabledByEnv(process.env.TOOLSMITH_VERBOSE)) return true
  if (enabledByEnv(process.env.TOOLSMITH_DEBUG)) return true
  return payload.verbose === true || payload.debug === true
}

let payload = {}
try { payload = JSON.parse(process.env.TOOLSMITH_CODEX_HOOK_PAYLOAD || "{}") } catch {}
if (!footerEnabled(payload)) process.exit(0)

const saved = toolsmithSaved()
const status = latestStatus(payload) || {}
const codexText = [formatUsage(status.usage), formatLimits(status.limits)].filter(Boolean).join(" • ")
if (saved && codexText) {
  console.log("Toolsmith saved " + compact(saved) + " estimated tokens (48h) • " + codexText)
} else if (saved) {
  console.log("Toolsmith saved " + compact(saved) + " estimated tokens (48h)")
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
  targetGroup.hooks.unshift({ type: "command", command: CODEX_FOOTER_COMMAND, timeout: 3 })

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

  const hooksPath = path.join(codexDir, "hooks.json")
  const hookResult = installCodexFooterHookConfig(hooksPath)
  if (hookResult.skipped) {
    return { status: "skipped", message: `Codex footer: skipped — ${hookResult.reason}` }
  }
  const changed = scriptChanged || hookResult.changed
  return { status: changed ? "installed" : "present", message: `Codex footer: ${changed ? "installed" : "already installed"}` }
}
