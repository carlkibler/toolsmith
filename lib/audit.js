import fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceTools } from "../src/fs-tools.js"
import { defaultUsageLogPath, isLikelyHarnessRecord, readUsageLog, summarizeUsage } from "../src/usage-log.js"
import { AVG_TOKENS_PER_LINE, REDUCIBLE_FRACTION, adoptionSnippet, formatAgentLogScanMarkdown, formatOpportunitiesText, lostTokenSavingsEstimate, scanAgentLogs, scanRemoteAgentLogs } from "../src/agent-log-scan.js"
import { args, option, positionals } from "./argv.js"
import os from "node:os"
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

// Split the headline into the part you can defend and the part that's an upper bound,
// so the number can't be dismissed as marketing. Read-family savings use a realistic
// counterfactual (the agent would have read the whole file). Edit-family savings credit
// the whole pre-edit file even for a 1-line change — an upper bound, since the agent
// usually already read the file (and that read was counted separately).
export function savingsBreakdownLine(summary) {
  const read = summary.agentReadTokensAvoided || 0
  const edit = summary.agentEditTokensAvoided || 0
  return `  └─ defensible (read/search/skeleton): ${read} tokens · edit-family upper bound: ${edit} tokens across ${summary.agentEditCalls} edit(s)`
}

export function versionReductionLine(summary) {
  const entries = Object.entries(summary.tokensByVersion || {})
    .filter(([, v]) => v.full > 0)
    .sort((a, b) => b[1].calls - a[1].calls)
  if (!entries.length) return null
  return entries
    .map(([ver, v]) => `${ver}=${Math.round(v.avoided / v.full * 100)}% (${v.calls} calls)`)
    .join(", ")
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
  console.log(`estimated tokens avoided (gross): ${efficiencyLine(summary)}`)
  console.log(`non-test estimated tokens avoided (gross): ${agentEfficiencyLine(summary)}`)
  console.log(savingsBreakdownLine(summary))
  console.log(`savings-positive calls: ${summary.positiveSavingsCalls}/${summary.telemetryCalls}; largest measured file: ${summary.maxFullBytes} bytes`)
  console.log(`non-test savings-positive calls: ${summary.agentPositiveSavingsCalls}/${summary.agentTelemetryCalls}; largest measured file: ${summary.agentMaxFullBytes} bytes`)
  console.log(`tokens avoided by tool: ${formatCounts(summary.tokensAvoidedByTool)}`)
  console.log(`non-test tokens avoided by tool: ${formatCounts(summary.agentTokensAvoidedByTool)}`)
  const verLine = versionReductionLine(summary)
  if (verLine) console.log(`token reduction by version: ${verLine}`)
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

export async function runTrends() {
  const days = option("--days") ? Number(option("--days")) : 30
  const logPath = option("--log") || defaultUsageLogPath()
  const nowMs = Date.now()
  const sinceMs = nowMs - days * 24 * 60 * 60 * 1000

  if (!existsSync(logPath)) {
    console.log("No usage log found. Use toolsmith tools for a few days, then run trends again.")
    return
  }

  const records = await readUsageLog({ logPath, sinceMs })
  const agentRecords = records.filter((r) => r.event === "tool_call" && !isLikelyHarnessRecord(r))
  const sessionScan = scanAgentLogs({ days, includeExamples: false })

  // ── weekly buckets ──────────────────────────────────────────────────────────
  const weeks = Math.max(1, Math.ceil(days / 7))
  const buckets = Array.from({ length: weeks }, (_, i) => {
    const end = nowMs - i * 7 * 24 * 60 * 60 * 1000
    const start = end - 7 * 24 * 60 * 60 * 1000
    const bucket = agentRecords.filter((r) => {
      const ts = r.ts ? new Date(r.ts).getTime() : 0
      return ts >= start && ts < end
    })
    const tel = bucket.map((r) => r.result?.telemetry).filter(Boolean)
    const totalFull = tel.reduce((s, t) => s + (t.estimatedFullTokens || 0), 0)
    const totalAvoided = tel.reduce((s, t) => s + (t.estimatedTokensAvoided || 0), 0)
    const d = new Date(start)
    const label = `${d.getMonth() + 1}/${d.getDate()}–${new Date(end).getMonth() + 1}/${new Date(end).getDate()}`
    return { label, calls: tel.length, totalFull, totalAvoided, pct: totalFull > 0 ? totalAvoided / totalFull * 100 : 0 }
  }).reverse()

  // ── per-client breakdown ────────────────────────────────────────────────────
  const byClient = {}
  for (const r of agentRecords) {
    const client = r.client || "unknown"
    if (!byClient[client]) byClient[client] = { calls: 0, avoided: 0, full: 0 }
    const tel = r.result?.telemetry
    if (tel) {
      byClient[client].calls++
      byClient[client].avoided += tel.estimatedTokensAvoided || 0
      byClient[client].full += tel.estimatedFullTokens || 0
    }
  }

  // ── per-tool breakdown ──────────────────────────────────────────────────────
  const byTool = {}
  for (const r of agentRecords) {
    const tool = r.tool || "unknown"
    const tel = r.result?.telemetry
    if (!tel) continue
    if (!byTool[tool]) byTool[tool] = { calls: 0, avoided: 0, full: 0 }
    byTool[tool].calls++
    byTool[tool].avoided += tel.estimatedTokensAvoided || 0
    byTool[tool].full += tel.estimatedFullTokens || 0
  }

  // ── interception rate ───────────────────────────────────────────────────────
  const telAll = agentRecords.map((r) => r.result?.telemetry).filter(Boolean)
  const totalCaught = telAll.reduce((s, t) => s + (t.estimatedTokensAvoided || 0), 0)
  const totalFull = telAll.reduce((s, t) => s + (t.estimatedFullTokens || 0), 0)
  const lostLines = sessionScan?.lostOpportunities?.lostLines || 0
  // NOTE: totalCaught is MEASURED (telemetry); missedSavings is MODELED (lost lines ×
  // assumed tokens/line × assumed reducible fraction). The interception rate therefore
  // mixes a measurement with a model and is labeled "modeled" below — directional, not exact.
  const missedCtxTokens = Math.round(lostLines * AVG_TOKENS_PER_LINE)
  const missedSavings = Math.round(missedCtxTokens * REDUCIBLE_FRACTION)
  const totalOpportunity = totalCaught + missedSavings
  const interceptionRate = totalOpportunity > 0 ? totalCaught / totalOpportunity * 100 : 0

  if (args.includes("--json")) {
    console.log(JSON.stringify({
      host: os.hostname(), date: new Date().toISOString(), days,
      agentCalls: agentRecords.length, telemetryCalls: telAll.length,
      totalCaught, totalFull, aggregatePct: totalFull > 0 ? totalCaught / totalFull * 100 : 0,
      missedSavings, interceptionRate,
      byWeek: buckets, byClient, byTool,
    }, null, 2))
    return
  }

  const nn = (x) => Math.round(x).toLocaleString("en-US")
  const pp = (x) => x.toFixed(1) + "%"
  const spark = (vals) => {
    const max = Math.max(...vals)
    if (max === 0) return "▁".repeat(vals.length)
    const chars = "▁▂▃▄▅▆▇█"
    return vals.map((v) => chars[Math.min(7, Math.floor((v / max) * 7))]).join("")
  }

  console.log(`\n${"─".repeat(72)}`)
  console.log(`  toolsmith trends  ·  ${os.hostname()}  ·  last ${days} days`)
  console.log(`${"─".repeat(72)}\n`)

  // summary
  console.log(`SUMMARY`)
  console.log(`  agent calls with telemetry:  ${nn(telAll.length)}`)
  console.log(`  tokens caught by toolsmith:  ${nn(totalCaught)} (${pp(totalFull > 0 ? totalCaught / totalFull * 100 : 0)} reduction on intercepted calls, measured)`)
  console.log(`  estimated missed savings:    ${nn(missedSavings)}  (modeled: ${sessionScan?.lostOpportunities?.total || 0} lost ops × ${AVG_TOKENS_PER_LINE} tok/line × ${REDUCIBLE_FRACTION})`)
  if (totalOpportunity > 0) {
    console.log(`  interception rate (modeled): ${pp(interceptionRate)}  (measured caught ÷ [measured caught + modeled missed])`)
    console.log(`\n  honest overall picture: on every large-file operation, toolsmith saves ~${pp(totalFull > 0 ? totalCaught / totalFull * 100 : 0)}`)
    console.log(`  of the tokens when used (measured). It's used on ~${pp(interceptionRate)} of the estimated total opportunity (modeled).`)
    console.log(`  The gap is the adoption lever — it closes as agents learn to prefer toolsmith tools.`)
  }

  // weekly trend
  console.log(`\n${"─".repeat(72)}`)
  console.log(`WEEKLY TREND`)
  console.log(`${"─".repeat(72)}`)
  const avoidedSpark = spark(buckets.map((b) => b.totalAvoided))
  const callSpark = spark(buckets.map((b) => b.calls))
  console.log(`  avoided ${avoidedSpark}`)
  console.log(`  calls   ${callSpark}\n`)
  console.log(`  ${"week".padEnd(14)} ${"calls".padStart(6)} ${"pct".padStart(7)} ${"caught".padStart(11)} ${"full".padStart(11)}`)
  console.log(`  ${"-".repeat(52)}`)
  for (const w of buckets) {
    console.log(`  ${w.label.padEnd(14)} ${w.calls.toString().padStart(6)} ${(w.calls > 0 ? pp(w.pct) : "—").padStart(7)} ${nn(w.totalAvoided).padStart(11)} ${nn(w.totalFull).padStart(11)}`)
  }
  if (buckets.length >= 2) {
    const recent = buckets.at(-1)
    const prior = buckets.at(-2)
    const delta = recent.totalAvoided - prior.totalAvoided
    const sign = delta >= 0 ? "+" : ""
    console.log(`\n  week-over-week: ${sign}${nn(delta)} tokens caught  (${sign}${Math.round(delta / Math.max(prior.totalAvoided, 1) * 100)}%)`)
  }

  // per-client
  console.log(`\n${"─".repeat(72)}`)
  console.log(`BY CLIENT`)
  console.log(`${"─".repeat(72)}`)
  const clientEntries = Object.entries(byClient).sort((a, b) => b[1].avoided - a[1].avoided)
  console.log(`  ${"client".padEnd(30)} ${"calls".padStart(6)} ${"pct".padStart(7)} ${"caught".padStart(11)}`)
  console.log(`  ${"-".repeat(57)}`)
  for (const [client, c] of clientEntries) {
    const clientPct = c.full > 0 ? c.avoided / c.full * 100 : 0
    console.log(`  ${client.padEnd(30)} ${c.calls.toString().padStart(6)} ${pp(clientPct).padStart(7)} ${nn(c.avoided).padStart(11)}`)
  }

  // per-tool
  console.log(`\n${"─".repeat(72)}`)
  console.log(`BY TOOL`)
  console.log(`${"─".repeat(72)}`)
  const toolEntries = Object.entries(byTool).sort((a, b) => b[1].avoided - a[1].avoided)
  console.log(`  ${"tool".padEnd(22)} ${"calls".padStart(6)} ${"pct".padStart(7)} ${"caught".padStart(11)}`)
  console.log(`  ${"-".repeat(48)}`)
  for (const [tool, t] of toolEntries) {
    const toolPct = t.full > 0 ? t.avoided / t.full * 100 : 0
    console.log(`  ${tool.padEnd(22)} ${t.calls.toString().padStart(6)} ${pp(toolPct).padStart(7)} ${nn(t.avoided).padStart(11)}`)
  }
  console.log()
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
