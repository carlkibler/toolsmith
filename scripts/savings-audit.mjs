#!/usr/bin/env node
/**
 * Independent token savings audit.
 *
 * Reads usage.jsonl directly — no toolsmith library imports — and computes
 * per-tool savings stats using only records from known real agent clients.
 * Shows the calculation work at every step.
 *
 * Usage:
 *   node scripts/savings-audit.mjs [--log /path/to/usage.jsonl] [--days N] [--json]
 *                                   [--weekly] [--by-client]
 *
 * Flags:
 *   --days N       window in days (default 30)
 *   --weekly       show week-by-week savings trend
 *   --by-client    show per-agent-client breakdown
 *   --json         emit raw JSON instead of text
 *   --log PATH     override usage.jsonl location
 */

import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// ── config ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flagIdx = (f) => args.indexOf(f)
const flagVal = (f) => { const i = flagIdx(f); return i !== -1 ? args[i + 1] : null }
const hasFlagVal = (f) => flagIdx(f) !== -1

const LOG_PATH = flagVal("--log") ?? path.join(os.homedir(), ".local/state/toolsmith/usage.jsonl")
const DAYS = parseInt(flagVal("--days") ?? "30", 10)
const JSON_OUT = hasFlagVal("--json")
const WEEKLY = hasFlagVal("--weekly")
const BY_CLIENT = hasFlagVal("--by-client")
const CUTOFF_MS = Date.now() - DAYS * 24 * 60 * 60 * 1000

// Clients that are definitively real agents (never test harness)
const KNOWN_AGENT_CLIENTS = new Set([
  "codex-mcp-client",   // Codex CLI calling MCP
  "claude-code",        // Claude Code calling MCP
  "claude",             // Claude (non-code)
  "Cline",
  "Roo Code",
  "opencode",
  "cursor-vscode",
  "Windsurf",
  "gemini-cli-mcp-client",
  "continue-client",
  "crush",
  "qwen-cli-mcp-client-toolsmith",
  "kimi-cli-mcp-client",
])

// cwdName patterns that indicate a harness/test workspace
const HARNESS_CWD_PATTERN = /^toolsmith-[A-Za-z0-9]|^codex-workspace$|^claude-workspace$|^gemini-workspace$|^pi-workspace$/

// ── read log ──────────────────────────────────────────────────────────────────

if (!fs.existsSync(LOG_PATH)) {
  console.error(`Log not found: ${LOG_PATH}`)
  process.exit(1)
}

const raw = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n")
const all = raw.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const toolCalls = all.filter((r) => {
  if (r.event !== "tool_call") return false
  const ts = r.ts ? new Date(r.ts).getTime() : 0
  return ts >= CUTOFF_MS
})

// ── classification ─────────────────────────────────────────────────────────────

function classify(r) {
  const client = r.client || "unknown"
  const cwd = r.cwdName || ""
  if (client === "test" || client === "node-test-or-wrapper") return "test"
  if (HARNESS_CWD_PATTERN.test(cwd)) return "harness-workspace"
  if (KNOWN_AGENT_CLIENTS.has(client)) return "agent"
  return "unknown"
}

const byClass = { agent: [], "harness-workspace": [], test: [], unknown: [] }
for (const r of toolCalls) byClass[classify(r)].push(r)

// ── per-tool stats ─────────────────────────────────────────────────────────────

function statsForRecords(records) {
  const byTool = {}
  for (const r of records) {
    const tool = r.tool || "unknown"
    const tel = r.result?.telemetry
    if (!tel) continue
    if (!byTool[tool]) byTool[tool] = { full: [], response: [], avoided: [] }
    byTool[tool].full.push(tel.estimatedFullTokens || 0)
    byTool[tool].response.push(tel.estimatedResponseTokens || 0)
    byTool[tool].avoided.push(tel.estimatedTokensAvoided || 0)
  }

  const result = {}
  for (const [tool, d] of Object.entries(byTool)) {
    const calls = d.full.length
    const totalFull = d.full.reduce((a, b) => a + b, 0)
    const totalResponse = d.response.reduce((a, b) => a + b, 0)
    const totalAvoided = d.avoided.reduce((a, b) => a + b, 0)
    const pctPerCall = d.full.map((f, i) => f > 0 ? (d.avoided[i] / f) * 100 : 0)
    pctPerCall.sort((a, b) => a - b)
    const median = pctPerCall[Math.floor(pctPerCall.length / 2)] ?? 0
    const positive = d.avoided.filter((v) => v > 0).length

    const buckets = { "0–10%": 0, "10–50%": 0, "50–90%": 0, "90–99%": 0, "≥99%": 0 }
    for (const p of pctPerCall) {
      if (p < 10) buckets["0–10%"]++
      else if (p < 50) buckets["10–50%"]++
      else if (p < 90) buckets["50–90%"]++
      else if (p < 99) buckets["90–99%"]++
      else buckets["≥99%"]++
    }

    result[tool] = {
      calls,
      positive,
      totalFull,
      totalResponse,
      totalAvoided,
      aggregatePct: totalFull > 0 ? (totalAvoided / totalFull * 100) : 0,
      medianPct: median,
      avgFullTokens: Math.round(totalFull / calls),
      avgResponseTokens: Math.round(totalResponse / calls),
      buckets,
    }
  }
  return result
}

const agentStats = statsForRecords(byClass.agent)
const allRealStats = statsForRecords([...byClass.agent, ...byClass.unknown])

// ── aggregate ─────────────────────────────────────────────────────────────────

function aggregate(stats) {
  let totalFull = 0, totalResponse = 0, totalAvoided = 0, calls = 0, positive = 0
  for (const v of Object.values(stats)) {
    totalFull += v.totalFull
    totalResponse += v.totalResponse
    totalAvoided += v.totalAvoided
    calls += v.calls
    positive += v.positive
  }
  return { totalFull, totalResponse, totalAvoided, calls, positive,
    pct: totalFull > 0 ? (totalAvoided / totalFull * 100) : 0 }
}

const agentAgg = aggregate(agentStats)

// ── time-series: weekly buckets ───────────────────────────────────────────────

function weeklyBuckets(records, totalDays) {
  const now = Date.now()
  const weeks = Math.max(1, Math.ceil(totalDays / 7))
  return Array.from({ length: weeks }, (_, i) => {
    const end = now - i * 7 * 24 * 60 * 60 * 1000
    const start = end - 7 * 24 * 60 * 60 * 1000
    const bucket = records.filter((r) => {
      const ts = r.ts ? new Date(r.ts).getTime() : 0
      return ts >= start && ts < end
    })
    const d = new Date(start)
    const label = `${d.getMonth() + 1}/${d.getDate()}–${new Date(end).getMonth() + 1}/${new Date(end).getDate()}`
    const stats = statsForRecords(bucket)
    const agg = aggregate(stats)
    return { label, start, end, records: bucket.length, ...agg }
  }).reverse()
}

// ── per-client stats ──────────────────────────────────────────────────────────

function clientStats(records) {
  const byClient = {}
  for (const r of records) {
    const client = r.client || "unknown"
    if (!byClient[client]) byClient[client] = []
    byClient[client].push(r)
  }
  return Object.entries(byClient)
    .map(([client, recs]) => {
      const stats = statsForRecords(recs)
      const agg = aggregate(stats)
      const topTool = Object.entries(stats).sort((a, b) => b[1].totalAvoided - a[1].totalAvoided)[0]?.[0] ?? "—"
      return { client, records: recs.length, ...agg, topTool }
    })
    .sort((a, b) => b.totalAvoided - a.totalAvoided)
}

// ── output ────────────────────────────────────────────────────────────────────

if (JSON_OUT) {
  const weeks = WEEKLY ? weeklyBuckets(byClass.agent, DAYS) : null
  const clients = BY_CLIENT ? clientStats(byClass.agent) : null
  const allRealAgg = aggregate(allRealStats)
  console.log(JSON.stringify({
    host: os.hostname(), date: new Date().toISOString(), days: DAYS, log: LOG_PATH,
    classification: { agent: byClass.agent.length, harness: byClass["harness-workspace"].length,
      test: byClass.test.length, unknown: byClass.unknown.length },
    agentOnly: { ...agentAgg, byTool: agentStats },
    agentPlusUnknown: { ...allRealAgg, byTool: allRealStats },
    weekly: weeks,
    byClient: clients,
  }, null, 2))
  process.exit(0)
}

const n = (x) => Math.round(x).toLocaleString("en-US")
const pct = (x) => x.toFixed(1) + "%"
const bar = (p, w = 20) => "█".repeat(Math.round(p / 100 * w)).padEnd(w)
const spark = (vals) => {
  if (!vals.length) return ""
  const max = Math.max(...vals)
  if (max === 0) return "▁".repeat(vals.length)
  const chars = "▁▂▃▄▅▆▇█"
  return vals.map((v) => chars[Math.min(7, Math.floor((v / max) * 7))]).join("")
}

console.log(`\n${"─".repeat(72)}`)
console.log(`  toolsmith savings audit  ·  ${os.hostname()}  ·  last ${DAYS} days`)
console.log(`  log: ${LOG_PATH}`)
console.log(`${"─".repeat(72)}\n`)

console.log(`RECORD BREAKDOWN (total tool_call events in window: ${toolCalls.length})`)
console.log(`  ✓  agent (known real clients):           ${byClass.agent.length.toString().padStart(5)}`)
console.log(`  ?  unknown client:                       ${byClass.unknown.length.toString().padStart(5)}  (excluded from primary stats)`)
console.log(`  ✗  harness workspace:                    ${byClass["harness-workspace"].length.toString().padStart(5)}  (excluded)`)
console.log(`  ✗  test / node-test-or-wrapper:          ${byClass.test.length.toString().padStart(5)}  (excluded)`)
console.log(`\n  Known agent clients: ${[...KNOWN_AGENT_CLIENTS].join(", ")}\n`)

function printStats(label, stats, agg) {
  console.log(`${"─".repeat(72)}`)
  console.log(`${label}  (${agg.calls} calls with telemetry, ${agg.positive} had positive savings)`)
  console.log(`${"─".repeat(72)}`)
  console.log(`\n  HOW WE CALCULATE:`)
  console.log(`    each tool_call record has telemetry.estimatedFullTokens (what a native`)
  console.log(`    Read would have sent) and telemetry.estimatedResponseTokens (what`)
  console.log(`    toolsmith actually returned).`)
  console.log(`    reduction% = (fullTokens - responseTokens) / fullTokens × 100\n`)

  const sorted = Object.entries(stats).sort((a, b) => b[1].totalAvoided - a[1].totalAvoided)
  const hdr = `  ${"tool".padEnd(22)} ${"calls".padStart(6)} ${"pos".padStart(5)} ${"avg full".padStart(9)} ${"avg resp".padStart(9)} ${"agg%".padStart(7)} ${"median%".padStart(8)}`
  console.log(hdr)
  console.log(`  ${"-".repeat(70)}`)
  for (const [tool, s] of sorted) {
    const row = [
      tool.padEnd(22),
      s.calls.toString().padStart(6),
      s.positive.toString().padStart(5),
      n(s.avgFullTokens).padStart(9),
      n(s.avgResponseTokens).padStart(9),
      pct(s.aggregatePct).padStart(7),
      pct(s.medianPct).padStart(8),
    ]
    console.log(`  ${row.join(" ")}`)
    const b = s.buckets
    const total = Object.values(b).reduce((a, x) => a + x, 0)
    if (total > 0) {
      const parts = Object.entries(b).map(([k, v]) => `${k}:${v}`).join("  ")
      console.log(`  ${"".padEnd(22)}  distribution: ${parts}`)
    }
  }
  console.log(`\n  AGGREGATE`)
  console.log(`  ${"─".repeat(50)}`)
  console.log(`  total full tokens (native would have sent):  ${n(agg.totalFull).padStart(14)}`)
  console.log(`  total response tokens (toolsmith sent):      ${n(agg.totalResponse).padStart(14)}`)
  console.log(`  tokens avoided:                              ${n(agg.totalAvoided).padStart(14)}`)
  console.log(`  aggregate reduction:  ${n(agg.totalAvoided)} / ${n(agg.totalFull)} = ${pct(agg.pct)}`)
  console.log(`  visual: ${bar(agg.pct)} ${pct(agg.pct)} avoided\n`)

  console.log(`  CAVEATS`)
  console.log(`  • "full tokens" = estimate of sending the ENTIRE file; toolsmith is`)
  console.log(`    called when agents CHOOSE to use it, often on large files, so the`)
  console.log(`    denominator is already biased toward large. This measures "how much`)
  console.log(`    did toolsmith save vs a naive full-file read on the same call" —`)
  console.log(`    not "how much did toolsmith save vs the entire session."`)
  console.log(`  • edit/replace tools report full-file tokens as the "would have sent"`)
  console.log(`    baseline (a native Edit sends the whole new file content).`)
  console.log(`  • token counts are byte÷4 estimates, not exact model token counts.\n`)
}

printStats("PRIMARY: known agent clients only", agentStats, agentAgg)

// ── per-client breakdown ──────────────────────────────────────────────────────

if (BY_CLIENT) {
  const clients = clientStats(byClass.agent)
  console.log(`${"─".repeat(72)}`)
  console.log(`PER-CLIENT BREAKDOWN  (agent records only)`)
  console.log(`${"─".repeat(72)}\n`)
  const hdr = `  ${"client".padEnd(30)} ${"calls".padStart(6)} ${"agg%".padStart(7)} ${"avoided".padStart(10)} ${"top tool".padStart(20)}`
  console.log(hdr)
  console.log(`  ${"-".repeat(73)}`)
  for (const c of clients) {
    const row = [
      c.client.padEnd(30),
      c.records.toString().padStart(6),
      pct(c.pct).padStart(7),
      n(c.totalAvoided).padStart(10),
      c.topTool.padStart(20),
    ]
    console.log(`  ${row.join(" ")}`)
  }
  console.log()
}

// ── weekly trend ──────────────────────────────────────────────────────────────

if (WEEKLY) {
  const weeks = weeklyBuckets(byClass.agent, DAYS)
  console.log(`${"─".repeat(72)}`)
  console.log(`WEEKLY TREND  (${DAYS} days → ${weeks.length} week${weeks.length === 1 ? "" : "s"})`)
  console.log(`${"─".repeat(72)}\n`)

  const avoidedVals = weeks.map((w) => w.totalAvoided)
  const callVals = weeks.map((w) => w.calls)
  console.log(`  savings spark: ${spark(avoidedVals)}  (tokens avoided per week)`)
  console.log(`  calls spark:   ${spark(callVals)}  (calls with telemetry per week)\n`)

  const hdr = `  ${"week".padEnd(14)} ${"calls".padStart(6)} ${"pct".padStart(7)} ${"avoided".padStart(11)} ${"full".padStart(11)}`
  console.log(hdr)
  console.log(`  ${"-".repeat(52)}`)
  for (const w of weeks) {
    const row = [
      w.label.padEnd(14),
      w.calls.toString().padStart(6),
      (w.calls > 0 ? pct(w.pct) : "—").padStart(7),
      n(w.totalAvoided).padStart(11),
      n(w.totalFull).padStart(11),
    ]
    console.log(`  ${row.join(" ")}`)
  }
  console.log()

  if (weeks.length >= 2) {
    const recent = weeks.at(-1)
    const prior = weeks.at(-2)
    const delta = recent.totalAvoided - prior.totalAvoided
    const sign = delta >= 0 ? "+" : ""
    console.log(`  week-over-week: ${sign}${n(delta)} tokens avoided  (${sign}${Math.round(delta / Math.max(prior.totalAvoided, 1) * 100)}%)\n`)
  }
}

// ── sensitivity check ─────────────────────────────────────────────────────────

if (byClass.unknown.length > 0) {
  const allRealAgg = aggregate(allRealStats)
  console.log(`${"─".repeat(72)}`)
  console.log(`SENSITIVITY CHECK: agent + unknown clients combined`)
  console.log(`(unknown client = MCP server started in a way that didn't send clientInfo)`)
  console.log(`${"─".repeat(72)}`)
  console.log(`  aggregate: ${n(allRealAgg.totalAvoided)} / ${n(allRealAgg.totalFull)} = ${pct(allRealAgg.pct)} reduction`)
  console.log(`  (vs ${pct(agentAgg.pct)} for known-agent-only)\n`)
}
