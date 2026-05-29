import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { installClaudePrime, installClaudeTripwire, removeClaudeTripwire } from "../lib/tripwire.js"

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

// A nudge (allow) sets no permissionDecision; treat its absence as "allow".
function decisionOf(stdout) {
  return JSON.parse(stdout).hookSpecificOutput?.permissionDecision ?? "allow"
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
    // No mode set → adaptive; an isolated fresh session's first fire is a gentle allow (no decision).
    const dfltOut = runTripwire(payload, [], { TOOLSMITH_STATE_DIR: state, TOOLSMITH_TRIPWIRE_MODE: "" }).stdout
    assert.equal(decisionOf(dfltOut), "allow")
    assert.equal(JSON.parse(dfltOut).hookSpecificOutput, undefined)
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
    assert.equal(decisionOf(runTripwire(payload, ["--mode", "nonsense"]).stdout), "allow")
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
    // Edit on an EXISTING large file can escalate all the way to deny.
    const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, session_id: "esc-test" })
    const decisions = []
    for (let i = 0; i < 6; i += 1) {
      const r = spawnSync(process.execPath, [CLI, "tripwire", "run", "--format", "claude"], {
        input: payload,
        encoding: "utf8",
        env: { ...process.env, TOOLSMITH_STATE_DIR: state, TOOLSMITH_TRIPWIRE_LOG: "0", TOOLSMITH_NO_UPDATE_CHECK: "1", TOOLSMITH_TRIPWIRE_MODE: "" },
      })
      decisions.push(decisionOf(r.stdout))
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

test("adaptive never hard-blocks a READ — caps at ask even after many bypasses", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-read-cap-"))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-read-cap-state-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file }, session_id: "read-cap" })
    let last = "allow"
    for (let i = 0; i < 10; i += 1) {
      last = decisionOf(spawnSync(process.execPath, [CLI, "tripwire", "run", "--format", "claude"], {
        input: payload, encoding: "utf8",
        env: { ...process.env, TOOLSMITH_STATE_DIR: state, TOOLSMITH_TRIPWIRE_LOG: "0", TOOLSMITH_NO_UPDATE_CHECK: "1" },
      }).stdout)
      assert.notEqual(last, "deny", `read should never be denied (fire ${i + 1})`)
    }
    assert.equal(last, "ask") // firmest a read ever gets
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(state, { recursive: true, force: true })
  }
})

test("adaptive never blocks a Write to a not-yet-existing file (only Write can create it)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-newwrite-"))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-newwrite-state-"))
  try {
    const newFile = path.join(dir, "brand-new.js")
    const bigContent = Array.from({ length: 250 }, (_, i) => `const x${i} = ${i}`).join("\n")
    const payload = JSON.stringify({ tool_name: "Write", tool_input: { file_path: newFile, content: bigContent }, session_id: "newwrite" })
    for (let i = 0; i < 10; i += 1) {
      assert.equal(decisionOf(spawnSync(process.execPath, [CLI, "tripwire", "run", "--format", "claude"], {
        input: payload, encoding: "utf8",
        env: { ...process.env, TOOLSMITH_STATE_DIR: state, TOOLSMITH_TRIPWIRE_LOG: "0", TOOLSMITH_NO_UPDATE_CHECK: "1" },
      }).stdout), "allow")
    }
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
      assert.equal(decisionOf(r.stdout), "allow")
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(state, { recursive: true, force: true })
  }
})

test("prime command prints the re-priming rule (for the SessionStart hook)", () => {
  const r = spawnSync(process.execPath, [CLI, "prime"], { encoding: "utf8", env: { ...process.env, TOOLSMITH_NO_UPDATE_CHECK: "1" } })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /mcp__toolsmith__/)
  assert.match(r.stdout, /200 lines/)
})

test("prime SessionStart hook installs; tripwire remove cleans both prime and tripwire", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-prime-"))
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    installClaudeTripwire("adaptive")
    installClaudePrime()
    const settingsPath = path.join(home, ".claude", "settings.json")
    let hooks = JSON.stringify(JSON.parse(await fs.readFile(settingsPath, "utf8")).hooks)
    assert.equal(hooks.includes("toolsmith-tripwire"), true)
    assert.equal(hooks.includes("toolsmith-prime"), true)
    assert.match(hooks, /SessionStart/)
    const { removed } = removeClaudeTripwire()
    assert.equal(removed, true)
    hooks = JSON.stringify(JSON.parse(await fs.readFile(settingsPath, "utf8")).hooks || {})
    assert.equal(hooks.includes("toolsmith-tripwire"), false)
    assert.equal(hooks.includes("toolsmith-prime"), false)
  } finally {
    if (prev === undefined) delete process.env.HOME
    else process.env.HOME = prev
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("install/remove never deletes an unrelated user hook that mentions 'tripwire run'", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-usersafe-"))
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    const settingsPath = path.join(home, ".claude", "settings.json")
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    const userCmd = "my-linter --tripwire run --strict"
    await fs.writeFile(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: userCmd }] }] },
    }))
    installClaudeTripwire("adaptive")
    removeClaudeTripwire()
    const after = await fs.readFile(settingsPath, "utf8")
    assert.equal(after.includes(userCmd), true, "user's unrelated hook must survive install+remove")
    assert.equal(after.includes("toolsmith-tripwire"), false)
  } finally {
    if (prev === undefined) delete process.env.HOME
    else process.env.HOME = prev
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
