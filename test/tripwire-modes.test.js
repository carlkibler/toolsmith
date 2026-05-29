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

test("tripwire run reads a fixed mode from env; default is adaptive (first fire allows)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-mode-"))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-mode-state-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file }, session_id: "env-test" })
    const ask = JSON.parse(runTripwire(payload, [], { TOOLSMITH_TRIPWIRE_MODE: "ask", TOOLSMITH_STATE_DIR: state }).stdout)
    assert.equal(ask.hookSpecificOutput.permissionDecision, "ask")
    // No mode set → adaptive; an isolated fresh session's first fire is a gentle allow.
    const dflt = JSON.parse(runTripwire(payload, [], { TOOLSMITH_STATE_DIR: state, TOOLSMITH_TRIPWIRE_MODE: "" }).stdout)
    assert.equal(dflt.hookSpecificOutput.permissionDecision, "allow")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(state, { recursive: true, force: true })
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

test("adaptive mode (the default) escalates allow → ask → deny across a session", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-esc-"))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-esc-state-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file }, session_id: "esc-test" })
    const decisions = []
    for (let i = 0; i < 6; i += 1) {
      const r = spawnSync(process.execPath, [CLI, "tripwire", "run", "--format", "claude"], {
        input: payload,
        encoding: "utf8",
        env: { ...process.env, TOOLSMITH_STATE_DIR: state, TOOLSMITH_TRIPWIRE_LOG: "0", TOOLSMITH_NO_UPDATE_CHECK: "1", TOOLSMITH_TRIPWIRE_MODE: "" },
      })
      decisions.push(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision)
    }
    // defaults: ask after 3, deny after 6
    assert.deepEqual(decisions.slice(0, 2), ["allow", "allow"])
    assert.equal(decisions[2], "ask")
    assert.equal(decisions[5], "deny")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(state, { recursive: true, force: true })
  }
})

test("a fixed mode opts out of escalation (stays allow across many fires)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-fixed-"))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-fixed-state-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file }, session_id: "fixed-test" })
    for (let i = 0; i < 5; i += 1) {
      const r = spawnSync(process.execPath, [CLI, "tripwire", "run", "--format", "claude", "--mode", "allow"], {
        input: payload,
        encoding: "utf8",
        env: { ...process.env, TOOLSMITH_STATE_DIR: state, TOOLSMITH_TRIPWIRE_LOG: "0", TOOLSMITH_NO_UPDATE_CHECK: "1" },
      })
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow")
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(state, { recursive: true, force: true })
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
