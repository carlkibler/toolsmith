import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { wireCanary } from "../lib/config.js"
import { readWireVouch, recordWireVouch } from "../lib/tripwire-session.js"

const CLI = path.resolve("bin/toolsmith.js")
const VERSION = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")).version

// A minimal MCP server that reproduces the 0.1.53 regression: content[0].text carries the
// anchored body, but structuredContent has the text stripped (telemetry-only).
const BROKEN_SERVER = `
const lines = require("node:readline").createInterface({ input: process.stdin })
lines.on("line", (line) => {
  let msg; try { msg = JSON.parse(line) } catch { return }
  if (msg.method === "initialize") reply(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "broken", version: "0.0.0" } })
  else if (msg.method === "tools/call") reply(msg.id, {
    content: [{ type: "text", text: "[File: canary.txt]\\nAaaa§wire-canary-line-1\\nAbbb§wire-canary-line-2\\nAccc§wire-canary-line-3" }],
    structuredContent: { path: "canary.txt", telemetry: { estimatedTokensAvoided: 999 } },
    isError: false,
  })
  else if (msg.id !== undefined) reply(msg.id, {})
})
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n") }
`

test("wireCanary passes against the real MCP server", async () => {
  const verdict = await wireCanary()
  assert.equal(verdict.ok, true, verdict.detail)
  assert.match(verdict.detail, /both channels/)
})

test("wireCanary fails when structuredContent is telemetry-only (0.1.53 regression shape)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-broken-"))
  try {
    const server = path.join(dir, "broken-server.cjs")
    await fs.writeFile(server, BROKEN_SERVER, "utf8")
    const verdict = await wireCanary({ commandArgs: [server] })
    assert.equal(verdict.ok, false)
    assert.match(verdict.detail, /structuredContent/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("wire-vouch cache: round trip, version invalidation, TTL expiry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-vouch-"))
  const prev = process.env.TOOLSMITH_STATE_DIR
  process.env.TOOLSMITH_STATE_DIR = dir
  try {
    assert.equal(readWireVouch("1.0.0"), null)
    recordWireVouch("1.0.0", true, "all good")
    assert.deepEqual(readWireVouch("1.0.0"), { ok: true, detail: "all good" })
    assert.equal(readWireVouch("2.0.0"), null, "a version change must invalidate the cache")
    // A pass expires after a day; a failure retries within the hour.
    const now = Date.now()
    assert.equal(readWireVouch("1.0.0", now + 25 * 3600_000), null)
    recordWireVouch("1.0.0", false, "broken")
    assert.equal(readWireVouch("1.0.0", now + 2 * 3600_000), null)
    assert.equal(readWireVouch("1.0.0").ok, false)
  } finally {
    if (prev === undefined) delete process.env.TOOLSMITH_STATE_DIR
    else process.env.TOOLSMITH_STATE_DIR = prev
    await fs.rm(dir, { recursive: true, force: true })
  }
})

function runTripwire(payload, state, env = {}) {
  return spawnSync(process.execPath, [CLI, "tripwire", "run", "--format", "claude"], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, TOOLSMITH_TRIPWIRE_LOG: "0", TOOLSMITH_NO_UPDATE_CHECK: "1", TOOLSMITH_STATE_DIR: state, ...env },
  })
}

test("tripwire stays silent when the wire vouch failed, nudges when it passed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-vouch-trip-"))
  const prev = process.env.TOOLSMITH_STATE_DIR
  process.env.TOOLSMITH_STATE_DIR = dir
  try {
    const file = path.join(dir, "big.js")
    await fs.writeFile(file, Array.from({ length: 220 }, (_, i) => `line${i}`).join("\n"), "utf8")
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file }, cwd: dir, session_id: "vouch-test" })

    recordWireVouch(VERSION, false, "simulated delivery failure")
    const silenced = runTripwire(payload, dir)
    assert.equal(silenced.status, 0)
    assert.equal(silenced.stdout.trim(), "", "an unverified tool must not be recommended")

    // The opt-out restores pre-vouch behavior even with a failing cache.
    const optOut = runTripwire(payload, dir, { TOOLSMITH_TRIPWIRE_VOUCH: "0" })
    assert.match(optOut.stdout, /Toolsmith/)

    recordWireVouch(VERSION, true, "verified")
    const nudged = runTripwire(payload, dir)
    assert.match(nudged.stdout, /Toolsmith/)
  } finally {
    if (prev === undefined) delete process.env.TOOLSMITH_STATE_DIR
    else process.env.TOOLSMITH_STATE_DIR = prev
    await fs.rm(dir, { recursive: true, force: true })
  }
})
