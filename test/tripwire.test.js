import assert from "node:assert/strict"
import { execFile, spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { evaluateTripwire, summarizeTripwireLog } from "../lib/tripwire.js"

const execFileAsync = promisify(execFile)
const CLI = path.resolve("bin/toolsmith.js")

async function makeLargeFile(dir, name = "large.js") {
  const file = path.join(dir, name)
  await fs.writeFile(file, Array.from({ length: 220 }, (_, i) => `line${i}`).join("\n"), "utf8")
  return file
}

test("tripwire nudges native Read on large files toward Toolsmith", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-tripwire-"))
  try {
    const file = await makeLargeFile(dir)
    const result = evaluateTripwire({ tool_name: "Read", tool_input: { file_path: file } })
    assert.equal(result.id, "native-read-large-file")
    assert.match(result.message, /file_skeleton/)
    assert.match(result.message, /anchored_read/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("tripwire nudges shell sed on large files toward anchored_read", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-tripwire-"))
  try {
    const file = await makeLargeFile(dir)
    const result = evaluateTripwire({ tool_name: "Bash", tool_input: { command: `sed -n '1,260p' ${file}` } })
    assert.equal(result.id, "shell-sed")
    assert.match(result.message, /anchored_read/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("tripwire run emits Claude hook JSON and logs fired nudges", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-tripwire-"))
  try {
    const file = await makeLargeFile(dir)
    const logPath = path.join(dir, "tripwire.jsonl")
    const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file } })
    const result = spawnSync(process.execPath, [CLI, "tripwire", "run", "--format", "claude"], {
      input: payload,
      encoding: "utf8",
      env: { ...process.env, TOOLSMITH_TRIPWIRE_LOG: logPath },
    })
    assert.equal(result.status, 0)
    const out = JSON.parse(result.stdout)
    assert.equal(out.decision, "allow")
    assert.match(out.systemMessage, /anchored_edit/)
    assert.equal(out.hookSpecificOutput.permissionDecision, "allow")
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /anchored_edit/)
    assert.match(out.hookSpecificOutput.systemMessage, /anchored_edit/)
    const rows = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(rows[0].id, "native-edit-large-file")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("tripwire log summary tolerates missing and malformed rows", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-tripwire-"))
  try {
    const missing = summarizeTripwireLog({ logPath: path.join(dir, "missing.jsonl") })
    assert.equal(missing.total, 0)
    assert.deepEqual(missing.byId, {})

    const logPath = path.join(dir, "tripwire.jsonl")
    await fs.writeFile(logPath, [
      JSON.stringify({ ts: "2026-05-07T00:00:00.000Z", id: "shell-sed" }),
      "not-json",
      JSON.stringify({ ts: "2026-05-07T01:00:00.000Z", id: "shell-sed" }),
      JSON.stringify({ ts: "2026-05-07T02:00:00.000Z", id: "native-read-large-file" }),
    ].join("\n") + "\n", "utf8")
    const summary = summarizeTripwireLog({ logPath, sinceMs: Date.parse("2026-05-07T00:30:00.000Z") })
    assert.equal(summary.total, 2)
    assert.deepEqual(summary.byId, { "shell-sed": 1, "native-read-large-file": 1 })
    assert.equal(summary.latestTs, "2026-05-07T02:00:00.000Z")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("tripwire install is idempotent and remove cleans the Claude hook", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-tripwire-home-"))
  try {
    await execFileAsync(process.execPath, [CLI, "tripwire", "install", "--client", "claude"], {
      env: { ...process.env, HOME: home },
    })
    await execFileAsync(process.execPath, [CLI, "tripwire", "install", "--client", "claude"], {
      env: { ...process.env, HOME: home },
    })
    const settingsPath = path.join(home, ".claude", "settings.json")
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"))
    const tripwireHooks = settings.hooks.PreToolUse.flatMap((entry) => entry.hooks).filter((hook) => hook.command.includes("toolsmith-tripwire"))
    assert.equal(tripwireHooks.length, 1)
    assert.match(settings.hooks.PreToolUse[0].matcher, /Read/)

    await execFileAsync(process.execPath, [CLI, "tripwire", "remove"], { env: { ...process.env, HOME: home } })
    const removed = JSON.parse(await fs.readFile(settingsPath, "utf8"))
    assert.equal(JSON.stringify(removed.hooks).includes("toolsmith-tripwire"), false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
