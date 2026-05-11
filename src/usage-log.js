import fs from "node:fs"
import fsp from "node:fs/promises"
import { createInterface } from "node:readline"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".local", "state", "toolsmith")

export function defaultUsageLogPath() {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(stateHome, "toolsmith", "usage.jsonl")
}

export function configuredUsageLogPath() {
  if (process.env.TOOLSMITH_USAGE_LOG === "0" || process.env.TOOLSMITH_USAGE_LOG === "false") return null
  return process.env.TOOLSMITH_USAGE_LOG || defaultUsageLogPath()
}

export function safeHash(value) {
  let hash = 2166136261
  for (const ch of String(value || "")) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

// Non-blocking async parent process identification; resolves within 500ms or falls back.
function resolveParentProcess() {
  return new Promise((resolve) => {
    const fallback = { pid: process.ppid }
    let proc
    const timer = setTimeout(() => { try { proc?.kill() } catch {} ; resolve(fallback) }, 500)
    try {
      proc = spawn("ps", ["-p", String(process.ppid), "-o", "comm=", "-o", "args="], { stdio: ["ignore", "pipe", "ignore"] })
      let out = ""
      proc.stdout.on("data", (d) => { out += d })
      proc.on("close", () => {
        clearTimeout(timer)
        const [command = "", ...rest] = out.trim().split(/\s+/)
        resolve({ pid: process.ppid, command, args: rest.join(" ").slice(0, 300) })
      })
      proc.on("error", () => { clearTimeout(timer); resolve(fallback) })
    } catch {
      clearTimeout(timer)
      resolve(fallback)
    }
  })
}

function inferClient(parent = {}) {
  const haystack = `${parent.command || ""} ${parent.args || ""}`.toLowerCase()
  if (haystack.includes("claude")) return "claude"
  if (haystack.includes("codex")) return "codex"
  if (haystack.includes("gemini")) return "gemini"
  if (haystack.includes("node")) return "node-test-or-wrapper"
  return "unknown"
}

function sanitizeValue(value, key = "") {
  if (value === null || value === undefined) return value
  if (typeof value === "string") {
    if (/text|replacement|search|query|anchor/i.test(key)) return { bytes: Buffer.byteLength(value, "utf8"), hash: safeHash(value) }
    return value.length > 240 ? `${value.slice(0, 237)}...` : value
  }
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return { count: value.length, items: value.slice(0, 5).map((item) => sanitizeValue(item, key)) }
  if (typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (/api|token|secret|password|key|auth/i.test(k)) out[k] = "[redacted]"
      else out[k] = sanitizeValue(v, k)
    }
    return out
  }
  return String(value)
}

function summarizeArgs(args = {}) {
  return sanitizeValue(args)
}

function summarizeResult(result = {}) {
  const structured = result.structuredContent || result.structured_content || result.details || {}
  const files = Array.isArray(structured.files) ? structured.files : []
  const fileTelemetries = files.map((file) => file.telemetry).filter(Boolean)
  const telemetry = structured.telemetry || result.telemetry || aggregateTelemetry(fileTelemetries)
  const base = {
    isError: Boolean(result.isError),
    ok: structured.ok,
    path: structured.path,
    changed: structured.changed ?? (files.length ? files.some((file) => file.changed) : undefined),
    dryRun: structured.dryRun,
    matchesCount: Array.isArray(structured.matches) ? structured.matches.length : (typeof structured.matches === "number" ? structured.matches : undefined),
    appliedCount: Array.isArray(structured.applied) ? structured.applied.length : (files.length ? files.reduce((sum, file) => sum + (file.applied?.length || 0), 0) : undefined),
    filesCount: files.length || undefined,
    telemetry,
  }
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined))
}

function aggregateTelemetry(fileTelemetries) {
  if (!fileTelemetries.length) return undefined
  return {
    operation: "anchored_edit_many",
    fullBytes: fileTelemetries.reduce((sum, telemetry) => sum + (telemetry.fullBytes || 0), 0),
    requestBytes: fileTelemetries.reduce((sum, telemetry) => sum + (telemetry.requestBytes || 0), 0),
    responseBytes: fileTelemetries.reduce((sum, telemetry) => sum + (telemetry.responseBytes || 0), 0),
    avoidedBytes: fileTelemetries.reduce((sum, telemetry) => sum + (telemetry.avoidedBytes || 0), 0),
    estimatedFullTokens: fileTelemetries.reduce((sum, telemetry) => sum + (telemetry.estimatedFullTokens || 0), 0),
    estimatedResponseTokens: fileTelemetries.reduce((sum, telemetry) => sum + (telemetry.estimatedResponseTokens || 0), 0),
    estimatedTokensAvoided: fileTelemetries.reduce((sum, telemetry) => sum + (telemetry.estimatedTokensAvoided || 0), 0),
    anchorCount: fileTelemetries.reduce((sum, telemetry) => sum + (telemetry.anchorCount || 0), 0),
  }
}

export class UsageLogger {
  #parentOverride = null
  #clientProvided = false
  #parentPromise = null
  #dirCreated = false
  #writeCount = 0
  #warnedOnce = false

  constructor({ logPath = configuredUsageLogPath(), cwd = process.cwd(), client, parent, version = "unknown" } = {}) {
    this.logPath = logPath
    this.cwd = cwd
    this.#parentOverride = parent || null
    this.#clientProvided = Boolean(client)
    // If parent provided explicitly (e.g. tests), infer client immediately; otherwise defer to first write.
    this.client = client || (parent ? inferClient(parent) : null)
    this.version = version
    this.sessionId = `${Date.now().toString(36)}-${process.pid}`
    this.enabled = Boolean(logPath)
    this.toolsListLogged = false
  }

  async #resolveParent() {
    if (this.#parentOverride) return this.#parentOverride
    // When the MCP harness has already identified itself via setClient(), skip the ps call entirely.
    if (this.#clientProvided) return { pid: process.ppid }
    if (!this.#parentPromise) this.#parentPromise = resolveParentProcess()
    return this.#parentPromise
  }

  async write(event) {
    if (!this.enabled) return
    try {
      const parent = await this.#resolveParent()
      if (!this.client) this.client = inferClient(parent)
      const includeFullPaths = process.env.TOOLSMITH_USAGE_FULL_PATHS === "1"
      const record = {
        ts: new Date().toISOString(),
        schema: "toolsmith.usage.v1",
        sessionId: this.sessionId,
        client: this.client,
        cwd: includeFullPaths ? this.cwd : undefined,
        cwdName: path.basename(this.cwd),
        cwdHash: safeHash(this.cwd),
        pid: process.pid,
        parent: {
          pid: parent.pid,
          command: parent.command ? path.basename(parent.command) : undefined,
          args: includeFullPaths ? parent.args : undefined,
        },
        ...event,
      }
      const dir = path.dirname(this.logPath)
      if (!this.#dirCreated) {
        await fsp.mkdir(dir, { recursive: true })
        this.#dirCreated = true
      }
      this.#writeCount++
      if (this.#writeCount % 10 === 1) await this.#rotateIfNeeded()
      await fsp.appendFile(this.logPath, `${JSON.stringify(record)}\n`, "utf8")
    } catch (err) {
      if (!this.#warnedOnce) {
        this.#warnedOnce = true
        process.stderr.write(`[toolsmith] warning: usage log not writable (${this.logPath}): ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  }

  async #rotateIfNeeded(maxBytes = 10 * 1024 * 1024) {
    try {
      const stat = await fsp.stat(this.logPath)
      if (stat.size < maxBytes) return
      const rotated = `${this.logPath}.1`
      try { await fsp.unlink(rotated) } catch {}
      await fsp.rename(this.logPath, rotated)
    } catch {}
  }

  setClient(name) {
    if (name && typeof name === "string") {
      this.client = name
      this.#clientProvided = true
    }
  }

  async startup() {
    await this.write({ event: "startup", version: this.version })
  }

  async toolsList({ toolCount }) {
    if (this.toolsListLogged) return
    this.toolsListLogged = true
    await this.write({ event: "tools_list", toolCount })
  }

  async toolCall({ tool, args, result, error, errorStack, durationMs }) {
    await this.write({
      event: "tool_call",
      tool,
      durationMs,
      args: summarizeArgs(args),
      result: error ? undefined : summarizeResult(result),
      error: error ? String(error instanceof Error ? error.message : error).slice(0, 500) : undefined,
      errorStack: errorStack ? String(errorStack).replaceAll(os.homedir(), "~").slice(0, 2000) : undefined,
    })
  }
}

const HARNESS_CWD_NAMES = new Set(["codex-workspace", "claude-workspace", "gemini-workspace", "pi-workspace"])
const HARNESS_SESSION_IDS = new Set(["many-mcp", "live-agent", "toolsmith-doctor"])

export function isLikelyHarnessRecord(record = {}) {
  const cwdName = record.cwdName || ""
  const sessionId = record.args?.sessionId
  const argPathBase = path.basename(String(record.args?.path || ""))
  if (!record.client || record.client === "node-test-or-wrapper" || record.client === "toolsmith-doctor") return true
  if (/^toolsmith-[A-Za-z0-9]/.test(cwdName)) return true
  if (HARNESS_CWD_NAMES.has(cwdName)) return true
  if (HARNESS_SESSION_IDS.has(sessionId)) return true
  if ((cwdName === "" || cwdName === "unknown") && sessionId === "task" && ["code.js", "sample.txt"].includes(argPathBase)) return true
  return false
}

async function* readLines(filePath) {
  const rl = createInterface({ input: fs.createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity })
  try {
    for await (const line of rl) yield line
  } finally {
    rl.close()
  }
}

export async function readUsageLog({ logPath = configuredUsageLogPath() || path.join(DEFAULT_STATE_DIR, "usage.jsonl"), sinceMs = 0, untilMs = 0 } = {}) {
  const records = []
  // Read .1 backup first (older records), then current file — gives roughly chronological order.
  for (const file of [`${logPath}.1`, logPath]) {
    if (!fs.existsSync(file)) continue
    try {
      for await (const line of readLines(file)) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line)
          const ts = Date.parse(record.ts)
          if (sinceMs && ts < sinceMs) continue
          if (untilMs && ts >= untilMs) continue
          records.push(record)
        } catch {}
      }
    } catch {}
  }
  return records
}

export function summarizeUsage(records) {
  const summary = {
    totalEvents: records.length,
    startupEvents: 0,
    agentStartupEvents: 0,
    harnessStartupEvents: 0,
    toolsListEvents: 0,
    agentToolsListEvents: 0,
    harnessToolsListEvents: 0,
    startupClients: {},
    agentStartupClients: {},
    harnessStartupClients: {},
    toolsListClients: {},
    agentToolsListClients: {},
    harnessToolsListClients: {},
    toolCalls: 0,
    agentToolCalls: 0,
    harnessToolCalls: 0,
    errors: 0,
    clients: {},
    agentClients: {},
    harnessClients: {},
    tools: {},
    agentTools: {},
    harnessTools: {},
    tokensAvoidedByTool: {},
    agentTokensAvoidedByTool: {},
    cwdHashes: {},
    startupWorkspaceNames: {},
    toolCallWorkspaceNames: {},
    agentWorkspaceNames: {},
    harnessWorkspaceNames: {},
    estimatedTokensAvoided: 0,
    agentEstimatedTokensAvoided: 0,
    telemetryCalls: 0,
    agentTelemetryCalls: 0,
    positiveSavingsCalls: 0,
    agentPositiveSavingsCalls: 0,
    maxFullBytes: 0,
    agentMaxFullBytes: 0,
    editCalls: 0,
    agentEditCalls: 0,
    changedCalls: 0,
    agentChangedCalls: 0,
    firstTs: records[0]?.ts,
    lastTs: records.at(-1)?.ts,
    latestStartupTs: null,
    latestToolCallTs: null,
    latestAgentToolCallTs: null,
  }

  for (const record of records) {
    const harness = isLikelyHarnessRecord(record)
    const client = record.client || "unknown"
    const cwdName = record.cwdName || "unknown"
    if (record.event === "startup") {
      summary.startupEvents++
      summary.latestStartupTs = record.ts || summary.latestStartupTs
      summary.startupClients[client] = (summary.startupClients[client] || 0) + 1
      summary.startupWorkspaceNames[cwdName] = (summary.startupWorkspaceNames[cwdName] || 0) + 1
      if (harness) {
        summary.harnessStartupEvents++
        summary.harnessStartupClients[client] = (summary.harnessStartupClients[client] || 0) + 1
      } else {
        summary.agentStartupEvents++
        summary.agentStartupClients[client] = (summary.agentStartupClients[client] || 0) + 1
      }
    }
    if (record.event === "tools_list") {
      summary.toolsListEvents++
      summary.toolsListClients[client] = (summary.toolsListClients[client] || 0) + 1
      if (harness) {
        summary.harnessToolsListEvents++
        summary.harnessToolsListClients[client] = (summary.harnessToolsListClients[client] || 0) + 1
      } else {
        summary.agentToolsListEvents++
        summary.agentToolsListClients[client] = (summary.agentToolsListClients[client] || 0) + 1
      }
    }
    if (record.event === "tool_call") {
      summary.toolCalls++
      summary.latestToolCallTs = record.ts || summary.latestToolCallTs
      summary.clients[client] = (summary.clients[client] || 0) + 1
      summary.tools[record.tool || "unknown"] = (summary.tools[record.tool || "unknown"] || 0) + 1
      summary.cwdHashes[record.cwdHash || "unknown"] = (summary.cwdHashes[record.cwdHash || "unknown"] || 0) + 1
      summary.toolCallWorkspaceNames[cwdName] = (summary.toolCallWorkspaceNames[cwdName] || 0) + 1
      if (harness) {
        summary.harnessToolCalls++
        summary.harnessClients[client] = (summary.harnessClients[client] || 0) + 1
        summary.harnessTools[record.tool || "unknown"] = (summary.harnessTools[record.tool || "unknown"] || 0) + 1
        summary.harnessWorkspaceNames[cwdName] = (summary.harnessWorkspaceNames[cwdName] || 0) + 1
      } else {
        summary.agentToolCalls++
        summary.latestAgentToolCallTs = record.ts || summary.latestAgentToolCallTs
        summary.agentClients[client] = (summary.agentClients[client] || 0) + 1
        summary.agentTools[record.tool || "unknown"] = (summary.agentTools[record.tool || "unknown"] || 0) + 1
        summary.agentWorkspaceNames[cwdName] = (summary.agentWorkspaceNames[cwdName] || 0) + 1
      }
      if (record.error || record.result?.isError) summary.errors++
      const telemetry = record.result?.telemetry
      if (telemetry) {
        summary.telemetryCalls++
        summary.maxFullBytes = Math.max(summary.maxFullBytes, telemetry.fullBytes || 0)
        if (!harness) {
          summary.agentTelemetryCalls++
          summary.agentMaxFullBytes = Math.max(summary.agentMaxFullBytes, telemetry.fullBytes || 0)
        }
        if (telemetry.estimatedTokensAvoided) {
          summary.estimatedTokensAvoided += telemetry.estimatedTokensAvoided
          summary.positiveSavingsCalls++
          summary.tokensAvoidedByTool[record.tool || "unknown"] = (summary.tokensAvoidedByTool[record.tool || "unknown"] || 0) + telemetry.estimatedTokensAvoided
          if (!harness) {
            summary.agentEstimatedTokensAvoided += telemetry.estimatedTokensAvoided
            summary.agentPositiveSavingsCalls++
            summary.agentTokensAvoidedByTool[record.tool || "unknown"] = (summary.agentTokensAvoidedByTool[record.tool || "unknown"] || 0) + telemetry.estimatedTokensAvoided
          }
        }
      }
      if (/edit|replace/.test(record.tool || "")) summary.editCalls++
      if (record.result?.changed) summary.changedCalls++
      if (!harness && /edit|replace/.test(record.tool || "")) summary.agentEditCalls++
      if (!harness && record.result?.changed) summary.agentChangedCalls++
    }
  }
  return summary
}
