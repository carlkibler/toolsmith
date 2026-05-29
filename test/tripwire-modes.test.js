import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const CLI = path.resolve("bin/toolsmith.js")

async function makeLargeFile(dir, name = "big.js") {
  const file = path.join(dir, name)
  await fs.writeFile(file, Array.from({ length: 220 }, (_, i) => `line${i}`).join("\n"), "utf8")
  return file
}

function runTripwire(payload, extraArgs = [], env = {}) {
  return spawnSync(process.execPath, [CLI, "tripwire", "run", "--format", "claude", ...extraArgs], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, TOOLSMITH_TRIPWIRE_LOG: "0", ...env },
  })
}

test("tripwire run fails OPEN on malformed stdin (never blocks the tool)", () => {
  const result = runTripwire("this is not json{{{")
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), "")
})

test("tripwire run --mode deny blocks a native large-file op", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-mode-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file } })
    const result = runTripwire(payload, ["--mode", "deny"])
    assert.equal(result.status, 0)
    const out = JSON.parse(result.stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny")
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /toolsmith/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("tripwire run reads mode from env; default is allow", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-mode-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file } })
    const ask = JSON.parse(runTripwire(payload, [], { TOOLSMITH_TRIPWIRE_MODE: "ask" }).stdout)
    assert.equal(ask.hookSpecificOutput.permissionDecision, "ask")
    const dflt = JSON.parse(runTripwire(payload, []).stdout)
    assert.equal(dflt.hookSpecificOutput.permissionDecision, "allow")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("invalid mode falls back to allow (never accidentally blocks)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-mode-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file } })
    const out = JSON.parse(runTripwire(payload, ["--mode", "nonsense"]).stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, "allow")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("installed hook bakes an absolute node path and a PATH fallback (no nvm hard dependency)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-home-"))
  try {
    const r = spawnSync(process.execPath, [CLI, "tripwire", "install", "--client", "claude"], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    })
    assert.equal(r.status, 0)
    const settings = JSON.parse(await fs.readFile(path.join(home, ".claude", "settings.json"), "utf8"))
    const cmd = settings.hooks.PreToolUse.flatMap((e) => e.hooks).map((h) => h.command).join("\n")
    assert.match(cmd, /toolsmith-tripwire/)
    assert.match(cmd, /command -v node/) // graceful fallback when the baked path is gone
    assert.doesNotMatch(cmd, /nvm\.sh/) // no longer hard-depends on nvm
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("install --mode deny bakes the mode into the hook command", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-home-"))
  try {
    const r = spawnSync(process.execPath, [CLI, "tripwire", "install", "--client", "claude", "--mode", "deny"], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    })
    assert.equal(r.status, 0)
    const settings = JSON.parse(await fs.readFile(path.join(home, ".claude", "settings.json"), "utf8"))
    const cmd = settings.hooks.PreToolUse.flatMap((e) => e.hooks).map((h) => h.command).join("\n")
    assert.match(cmd, /--mode deny/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
