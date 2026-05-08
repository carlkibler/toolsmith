import fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceTools } from "../src/fs-tools.js"
import { defaultUsageLogPath, isLikelyHarnessRecord, readUsageLog, summarizeUsage } from "../src/usage-log.js"
import { adoptionSnippet, formatAgentLogScanMarkdown, formatOpportunitiesText, lostTokenSavingsEstimate, scanAgentLogs, scanRemoteAgentLogs } from "../src/agent-log-scan.js"
import { args, option, positionals } from "./argv.js"
import { summarizeTripwireLog } from "./tripwire.js"
import { existsSync } from "node:fs"

export function deltaStr(curr, prev) {
  const d = curr - prev
  if (d === 0) return "→ same"
  const pct = prev > 0 ? ` (${d > 0 ? "+" : ""}${Math.round((d / prev) * 100)}%)` : ""
  return `${d > 0 ? "+" : ""}${d}${pct}`
}

export function efficiencyLine(summary) {
  const perCall = summary.toolCalls ? Math.round(summary.estimatedTokensAvoided / summary.toolCalls) : 0
  return `${summary.estimatedTokensAvoided} estimated tokens avoided across ${summary.toolCalls} tool call(s)${summary.toolCalls ? ` (~${perCall}/call)` : ""}`
}

export function agentEfficiencyLine(summary) {
  const perCall = summary.agentToolCalls ? Math.round(summary.agentEstimatedTokensAvoided / summary.agentToolCalls) : 0
  return `${summary.agentEstimatedTokensAvoided} estimated tokens avoided across ${summary.agentToolCalls} non-test tool call(s)${summary.agentToolCalls ? ` (~${perCall}/call)` : ""}`
}

export function telemetryStats(records) {
  const toolCalls = records.filter((record) => record.event === "tool_call")
  const telemetry = toolCalls.map((record) => record.result?.telemetry).filter(Boolean)
  const positiveSavings = telemetry.filter((item) => (item.estimatedTokensAvoided || 0) > 0).length
  const maxFullBytes = telemetry.reduce((max, item) => Math.max(max, item.fullBytes || 0), 0)
  return { telemetryCount: telemetry.length, positiveSavings, maxFullBytes }
}

export function clientAdoptionHints(summary) {
  const clients = ["claude", "codex", "gemini"]
  return clients
    .filter((client) => (summary.agentStartupClients[client] || 0) > 0 && (summary.agentClients[client] || 0) === 0)
    .map((client) => `${client}: MCP server started ${summary.agentStartupClients[client]} non-test time(s), but no non-test tool calls recorded`)
}

export function relativeTime(iso) {
  if (!iso) return "never"
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function formatEntryCounts(entries, limit = 0) {
  if (!entries?.length) return "none"
  const visible = limit ? entries.slice(0, limit) : entries
  const suffix = limit && entries.length > limit ? `, +${entries.length - limit} more` : ""
  return `${visible.map((entry) => `${entry.key}=${entry.count}`).join(", ")}${suffix}`
}

export function formatCounts(counts, limit = 0) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1])
  if (!entries.length) return "none"
  const visible = limit ? entries.slice(0, limit) : entries
  const suffix = limit && entries.length > limit ? `, +${entries.length - limit} more` : ""
  return `${visible.map(([k, v]) => `${k}=${v}`).join(", ")}${suffix}`
}

export async function usageHealth(days = 7) {
  const logPath = defaultUsageLogPath()
  if (!existsSync(logPath)) return { logPath, records: [] }
  const records = await readUsageLog({ logPath, sinceMs: Date.now() - days * 24 * 60 * 60 * 1000 })
  return { logPath, records }
}

export function latestBy(records, predicate) {
  return [...records].reverse().find(predicate)
}

export async function runAudit() {
  const weekMode = args.includes("--week")
  const tail = option("--tail") ? Number(option("--tail")) : 0
  const days = option("--days") ? Number(option("--days")) : weekMode ? 7 : 2
  const logPath = option("--log") || defaultUsageLogPath()
  const nowMs = Date.now()
  const sinceMs = nowMs - days * 24 * 60 * 60 * 1000
  const records = await readUsageLog({ logPath, sinceMs })
  const tripwire = summarizeTripwireLog({ sinceMs })

  if (tail > 0) {
    const slice = records.slice(-tail)
    console.log(`toolsmith audit --tail ${tail} (${slice.length} of ${records.length} events in last ${days}d)`)
    console.log(`log: ${logPath}`)
    for (const record of slice) console.log(JSON.stringify(record))
    return
  }

  const summary = summarizeUsage(records)
  const includeSessionScan = !args.includes("--no-session-scan")
  const sessionScan = includeSessionScan ? scanAgentLogs({ days, includeExamples: weekMode, maxExamples: weekMode ? 20 : 0 }) : null

  let prevSummary = null
  if (weekMode) {
    const prevSinceMs = sinceMs - days * 24 * 60 * 60 * 1000
    const prevRecords = await readUsageLog({ logPath, sinceMs: prevSinceMs, untilMs: sinceMs })
    prevSummary = summarizeUsage(prevRecords)
  }

  if (args.includes("--json")) {
    const prevSessionScan = null
    console.log(JSON.stringify({ logPath, days, summary, sessionScan, tripwire, prevSummary, prevSessionScan }, null, 2))
    return
  }

  console.log(`toolsmith audit (${days} day${days === 1 ? "" : "s"})`)
  console.log(`log: ${logPath}`)
  console.log(`events: ${summary.totalEvents} (${summary.toolCalls} tool calls, ${summary.startupEvents} startups, ${summary.toolsListEvents} tool-list requests, ${summary.errors} errors)`)
  console.log(`non-test agent tool calls: ${summary.agentToolCalls}; harness/test tool calls: ${summary.harnessToolCalls}`)
  console.log(`startup clients: ${formatCounts(summary.startupClients)}`)
  console.log(`tool-list clients: ${formatCounts(summary.toolsListClients)}`)
  console.log(`non-test tool-list clients: ${formatCounts(summary.agentToolsListClients)}`)
  console.log(`tool-call clients: ${formatCounts(summary.clients)}`)
  console.log(`non-test tool-call clients: ${formatCounts(summary.agentClients)}`)
  console.log(`tools: ${formatCounts(summary.tools)}`)
  console.log(`non-test tools: ${formatCounts(summary.agentTools)}`)
  console.log(`startup workspaces: ${formatCounts(summary.startupWorkspaceNames, 12)}`)
  console.log(`tool-call workspaces: ${formatCounts(summary.toolCallWorkspaceNames, 12)}`)
  console.log(`non-test tool-call workspaces: ${formatCounts(summary.agentWorkspaceNames, 12)}`)
  console.log(`repo/workspace hashes: ${formatCounts(summary.cwdHashes, 12)}`)
  console.log(`edit calls: ${summary.editCalls} (${summary.changedCalls} changed files)`)
  console.log(`non-test edit calls: ${summary.agentEditCalls} (${summary.agentChangedCalls} changed files)`)
  console.log(`estimated tokens avoided: ${efficiencyLine(summary)}`)
  console.log(`non-test estimated tokens avoided: ${agentEfficiencyLine(summary)}`)
  console.log(`savings-positive calls: ${summary.positiveSavingsCalls}/${summary.telemetryCalls}; largest measured file: ${summary.maxFullBytes} bytes`)
  console.log(`non-test savings-positive calls: ${summary.agentPositiveSavingsCalls}/${summary.agentTelemetryCalls}; largest measured file: ${summary.agentMaxFullBytes} bytes`)
  console.log(`tokens avoided by tool: ${formatCounts(summary.tokensAvoidedByTool)}`)
  console.log(`non-test tokens avoided by tool: ${formatCounts(summary.agentTokensAvoidedByTool)}`)
  console.log(`tripwire fires: ${tripwire.total}${tripwire.total ? ` (${formatCounts(tripwire.byId, 8)})` : ""}`)
  if (summary.firstTs) console.log(`window: ${summary.firstTs} → ${summary.lastTs}`)
  if (sessionScan) {
    console.log(`session-log opportunities: ${sessionScan.lostOpportunities.total} hard lost opportunities; ${sessionScan.lostOpportunities.editCandidates} apply_patch candidates`)
    console.log(`session-log by kind: ${formatEntryCounts(sessionScan.lostOpportunities.byKind, 8)}`)
    const missedEst = lostTokenSavingsEstimate(sessionScan.lostOpportunities.lostLines)
    if (missedEst) console.log(`session-log missed savings: ${missedEst}`)
  }

  if (weekMode && prevSummary) {
    const currLostLines = sessionScan?.lostOpportunities?.lostLines ?? 0
    const missedEst = lostTokenSavingsEstimate(currLostLines)
    console.log("\n── weekly postcard ──")
    console.log(`  agent tool calls:  this=${summary.agentToolCalls}  prev=${prevSummary.agentToolCalls}  ${deltaStr(summary.agentToolCalls, prevSummary.agentToolCalls)}`)
    console.log(`  tokens avoided:    this=${summary.agentEstimatedTokensAvoided}  prev=${prevSummary.agentEstimatedTokensAvoided}  ${deltaStr(summary.agentEstimatedTokensAvoided, prevSummary.agentEstimatedTokensAvoided)}`)
    if (missedEst) console.log(`  missed savings:    ${missedEst}`)
    const topLost = sessionScan?.lostOpportunities?.examples?.slice().sort((a, b) => (b.lines || 0) - (a.lines || 0))[0]
    if (topLost) {
      const fname = topLost.file ? topLost.file.split("/").pop() : "unknown"
      console.log(`  biggest missed op: ${topLost.agent} ${topLost.kind} on ${fname}${topLost.lines ? ` (${topLost.lines} lines)` : ""} → ${topLost.use}`)
    }
    console.log("─────────────────────")
  }

  if (summary.toolCalls === 0) {
    console.log("\nNo MCP tool calls recorded yet. Leave the MCP server configured, use Claude/Codex/Gemini normally, then rerun this in a day or two.")
  } else if (summary.agentToolCalls === 0) {
    console.log("\nOnly harness/test Toolsmith calls are recorded so far. Real Claude/Codex/Gemini sessions are starting the MCP server, but not choosing its tools yet.")
  } else if (summary.estimatedTokensAvoided === 0) {
    console.log("\nNo positive savings recorded yet. Recent measured files may be tiny or full-file-equivalent; try real edits on larger files, then run:")
    console.log(`  toolsmith audit --days ${days}`)
    console.log(`  toolsmith doctor --smoke --online`)
  }
}

export async function runAgentLogScan() {
  const days = option("--days") ? Number(option("--days")) : 7
  const maxExamples = option("--max-examples") ? Number(option("--max-examples")) : 12
  const remote = option("--remote")
  const scan = remote
    ? scanRemoteAgentLogs({ remote, days, maxExamples })
    : scanAgentLogs({ days, maxExamples, includeExamples: !args.includes("--no-examples") })

  if (args.includes("--json")) {
    console.log(JSON.stringify(scan, null, 2))
  } else {
    console.log(formatAgentLogScanMarkdown(scan))
  }
}

export async function runOpportunities() {
  const days = option("--days") ? Number(option("--days")) : 7
  const maxExamples = option("--max-examples") ? Number(option("--max-examples")) : 8
  const remote = option("--remote")
  const scan = remote
    ? scanRemoteAgentLogs({ remote, days, maxExamples })
    : scanAgentLogs({ days, maxExamples, includeExamples: !args.includes("--no-examples") })

  if (args.includes("--json")) {
    console.log(JSON.stringify(scan.lostOpportunities, null, 2))
  } else {
    console.log(formatOpportunitiesText(scan))
  }
}

export function runAdoptionSnippet() {
  const [client] = positionals()
  console.log(adoptionSnippet(option("--client") || client || "all"))
}

export async function runCharm() {
  const lines = option("--lines") ? Number(option("--lines")) : 1200
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || "/tmp", "toolsmith-charm-"))
  try {
    const target = path.join(dir, "big-scroll.js")
    const chunks = []
    for (let i = 1; i <= lines; i++) {
      chunks.push(`export function charm_${String(i).padStart(4, "0")}() { return ${i} }`)
    }
    await fs.writeFile(target, `${chunks.join("\n")}\n`, "utf8")

    const charmTools = new WorkspaceTools({ cwd: dir })
    const skeleton = await charmTools.skeleton({ path: "big-scroll.js", maxLines: 20, sessionId: "charm" })
    const targetLine = Math.min(lines, Math.max(1, Math.floor(lines * 0.75)))
    const windowStart = Math.max(1, targetLine - 5)
    const windowEnd = Math.min(lines, targetLine + 5)
    const search = await charmTools.search({ path: "big-scroll.js", query: `charm_${String(targetLine).padStart(4, "0")}`, contextLines: 1, maxMatches: 1, sessionId: "charm" })
    const partial = await charmTools.read({ path: "big-scroll.js", startLine: windowStart, endLine: windowEnd, sessionId: "charm" })
    const items = [
      ["file_skeleton", skeleton.telemetry],
      ["anchored_search", search.telemetry],
      ["partial anchored_read", partial.telemetry],
    ]
    const total = items.reduce((sum, [, telemetry]) => sum + (telemetry?.estimatedTokensAvoided || 0), 0)

    console.log("toolsmith charm ✨\n")
    console.log(`file: big-scroll.js (${lines} lines)`)
    for (const [name, telemetry] of items) {
      console.log(`${name}: ${telemetry.estimatedTokensAvoided} estimated tokens avoided (${telemetry.estimatedFullTokens} full → ${telemetry.estimatedResponseTokens} response tokens)`)
    }
    console.log(`\nTotal: ${total} estimated tokens avoided`)
    console.log("\nTry the same shape on real code:")
    console.log("  toolsmith skeleton path/to/large-file.js --max 80")
    console.log("  toolsmith search path/to/large-file.js SomeSymbol --context 2")
    console.log("  toolsmith get-function path/to/large-file.js SomeSymbol")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
