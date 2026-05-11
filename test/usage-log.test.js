import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { UsageLogger, isLikelyHarnessRecord, readUsageLog, summarizeUsage } from "../src/index.js"

test("usage summary separates live harness noise from real agent calls", () => {
  const records = [
    { ts: "2026-05-05T00:00:00.000Z", event: "startup", client: "claude", cwdName: "memedex" },
    { ts: "2026-05-05T00:00:30.000Z", event: "tools_list", client: "claude", cwdName: "memedex", toolCount: 8 },
    { ts: "2026-05-05T00:01:00.000Z", event: "startup", client: "codex", cwdName: "codex-workspace" },
    { ts: "2026-05-05T00:01:30.000Z", event: "tools_list", client: "codex", cwdName: "codex-workspace", toolCount: 8 },
    {
      ts: "2026-05-05T00:02:00.000Z",
      event: "tool_call",
      client: "codex",
      cwdName: "codex-workspace",
      tool: "file_skeleton",
      args: { path: "/tmp/toolsmith-live/code.js", sessionId: "task" },
      result: { telemetry: { fullBytes: 31, estimatedTokensAvoided: 0 } },
    },
    {
      ts: "2026-05-05T00:03:00.000Z",
      event: "tool_call",
      client: "claude",
      cwdName: "memedex",
      tool: "anchored_read",
      args: { path: "src/large.ts", sessionId: "real-work" },
      result: { telemetry: { fullBytes: 12000, estimatedTokensAvoided: 2500 } },
    },
    {
      ts: "2026-05-05T00:04:00.000Z",
      event: "tool_call",
      client: "node-test-or-wrapper",
      cwdName: "toolsmith-a1b2",
      tool: "anchored_edit_many",
      args: { sessionId: "many-mcp" },
    },
  ]

  const summary = summarizeUsage(records)
  assert.equal(summary.toolCalls, 3)
  assert.equal(summary.agentToolCalls, 1)
  assert.equal(summary.harnessToolCalls, 2)
  assert.equal(summary.agentStartupEvents, 1)
  assert.equal(summary.harnessStartupEvents, 1)
  assert.equal(summary.agentToolsListEvents, 1)
  assert.equal(summary.harnessToolsListEvents, 1)
  assert.deepEqual(summary.agentToolsListClients, { claude: 1 })
  assert.deepEqual(summary.agentClients, { claude: 1 })
  assert.deepEqual(summary.harnessClients, { codex: 1, "node-test-or-wrapper": 1 })
  assert.deepEqual(summary.agentWorkspaceNames, { memedex: 1 })
  assert.deepEqual(summary.harnessWorkspaceNames, { "codex-workspace": 1, "toolsmith-a1b2": 1 })
  assert.equal(summary.agentEstimatedTokensAvoided, 2500)
  assert.equal(summary.agentPositiveSavingsCalls, 1)
  assert.equal(summary.latestAgentToolCallTs, "2026-05-05T00:03:00.000Z")

  assert.equal(isLikelyHarnessRecord(records[4]), true)
  assert.equal(isLikelyHarnessRecord(records[5]), false)
  assert.equal(isLikelyHarnessRecord({ client: "codex", event: "tool_call", tool: "file_skeleton", args: { path: "code.js", sessionId: "task" } }), true)
})

test("UsageLogger.setClient updates client for subsequent writes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-usagelog-"))
  const logPath = path.join(tmpDir, "usage.jsonl")
  try {
    const logger = new UsageLogger({ logPath, version: "test" })
    await logger.startup() // writes with inferred client
    logger.setClient("codex")
    await logger.toolsList({ toolCount: 3 })
    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l))
    const toolsListRecord = lines.find((r) => r.event === "tools_list")
    assert.ok(toolsListRecord, "tools_list record must exist")
    assert.equal(toolsListRecord.client, "codex", "client must reflect setClient call")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("readUsageLog untilMs filters out records at or after the cutoff", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-usagelog-"))
  const logPath = path.join(tmpDir, "usage.jsonl")
  try {
    const lines = [
      JSON.stringify({ ts: "2026-04-20T00:00:00.000Z", event: "startup", client: "claude" }),
      JSON.stringify({ ts: "2026-04-27T00:00:00.000Z", event: "startup", client: "claude" }),
      JSON.stringify({ ts: "2026-05-04T00:00:00.000Z", event: "startup", client: "claude" }),
    ]
    await fs.writeFile(logPath, lines.join("\n") + "\n")
    const cutoff = Date.parse("2026-04-27T00:00:00.000Z")
    const records = await readUsageLog({ logPath, sinceMs: Date.parse("2026-04-19T00:00:00.000Z"), untilMs: cutoff })
    assert.equal(records.length, 1, "only records before cutoff should be returned")
    assert.equal(records[0].ts, "2026-04-20T00:00:00.000Z")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("audit --week emits weekly postcard with delta lines", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-audit-week-"))
  const logPath = path.join(tmpDir, "usage.jsonl")
  try {
    const prevWeek = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString()
    const thisWeek = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    const lines = [
      JSON.stringify({ ts: prevWeek, event: "tool_call", client: "claude", cwdName: "proj", tool: "anchored_read", args: { sessionId: "s1" }, result: { telemetry: { fullBytes: 5000, estimatedTokensAvoided: 800 } } }),
      JSON.stringify({ ts: thisWeek, event: "tool_call", client: "claude", cwdName: "proj", tool: "anchored_read", args: { sessionId: "s2" }, result: { telemetry: { fullBytes: 8000, estimatedTokensAvoided: 1500 } } }),
      JSON.stringify({ ts: thisWeek, event: "tool_call", client: "claude", cwdName: "proj", tool: "anchored_edit", args: { sessionId: "s2" }, result: { telemetry: { fullBytes: 8000, estimatedTokensAvoided: 200 } } }),
    ]
    await fs.writeFile(logPath, lines.join("\n") + "\n")
    const result = spawnSync(process.execPath, [path.resolve("bin/toolsmith.js"), "audit", "--week", "--no-session-scan", "--log", logPath], { encoding: "utf8" })
    assert.match(result.stdout, /weekly postcard/, "should include weekly postcard header")
    assert.match(result.stdout, /agent tool calls:/, "should include agent tool calls delta")
    assert.match(result.stdout, /tokens avoided:/, "should include tokens avoided delta")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("audit includes tripwire fire counts", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-audit-tripwire-"))
  const usageLog = path.join(tmpDir, "usage.jsonl")
  const tripwireLog = path.join(tmpDir, "tripwire.jsonl")
  try {
    await fs.writeFile(usageLog, "", "utf8")
    await fs.writeFile(tripwireLog, [
      JSON.stringify({ ts: new Date().toISOString(), id: "shell-sed" }),
      JSON.stringify({ ts: new Date().toISOString(), id: "native-read-large-file" }),
    ].join("\n") + "\n", "utf8")
    const result = spawnSync(process.execPath, [path.resolve("bin/toolsmith.js"), "audit", "--days", "1", "--no-session-scan", "--log", usageLog], {
      encoding: "utf8",
      env: { ...process.env, TOOLSMITH_TRIPWIRE_LOG: tripwireLog },
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /tripwire fires: 2/)
    assert.match(result.stdout, /shell-sed=1/)
    assert.match(result.stdout, /native-read-large-file=1/)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("doc alias MCP smoke uses the inline MCP server without external SDK dependency", () => {
  const result = spawnSync(process.execPath, [path.resolve("bin/toolsmith.js"), "doc", "--smoke"], {
    encoding: "utf8",
    env: { ...process.env, TOOLSMITH_USAGE_LOG: "0" },
  })
  assert.match(result.stdout, /MCP handshake\/list-tools succeeded/)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Cannot find package '@modelcontextprotocol\/sdk'/)
})


test("UsageLogger summarizes Pi-style details payloads", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-usagelog-details-"))
  const logPath = path.join(tmpDir, "usage.jsonl")
  const logger = new UsageLogger({ logPath, cwd: tmpDir, client: "pi" })

  await logger.toolCall({
    tool: "pi_anchored_edit",
    args: { path: "demo.txt" },
    result: { details: { ok: true, path: "demo.txt", changed: true, telemetry: { fullBytes: 100, estimatedTokensAvoided: 10 } } },
    durationMs: 1,
  })

  const [record] = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(record.result.ok, true)
  assert.equal(record.result.path, "demo.txt")
  assert.equal(record.result.changed, true)
  assert.equal(record.result.telemetry.estimatedTokensAvoided, 10)
})
