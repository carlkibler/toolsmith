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
    // cwd = dir so the file is inside the workspace (otherwise the catch-22 guard downgrades deny).
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file }, cwd: dir })
    const result = runTripwire(payload, ["--mode", "deny"])
    assert.equal(result.status, 0)
    const out = JSON.parse(result.stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny")
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /toolsmith/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("bypassPermissions downgrades even a fixed deny to a silent nudge (always haltable)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-bypass-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd: dir, permission_mode: "bypassPermissions" })
    // Even with an explicit --mode deny, bypass mode means the user opted out of all prompts/blocks.
    assert.equal(decisionOf(runTripwire(payload, ["--mode", "deny"]).stdout), "allow")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("tripwire run reads a fixed mode from env; default is allow (no prompts)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-mode-"))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-mode-state-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file }, cwd: dir, session_id: "env-test" })
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

test("tripwire allows near-threshold Markdown spec reads", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-spec-read-"))
  try {
    const file = path.join(dir, "SPEC-04-target-design.md")
    await fs.writeFile(file, Array.from({ length: 201 }, (_, i) => `# Section ${i + 1}\n\nSpec prose that the agent may need to read in full.`).join("\n"), "utf8")
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file }, cwd: dir })
    const result = runTripwire(payload, ["--mode", "deny"])
    assert.equal(result.status, 0)
    assert.equal(result.stdout.trim(), "")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("tripwire still protects edits to near-threshold Markdown specs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-spec-edit-"))
  try {
    const file = path.join(dir, "SPEC-05-agentic-rules-and-gating.md")
    await fs.writeFile(file, Array.from({ length: 201 }, (_, i) => `# Section ${i + 1}\n\nSpec prose line.`).join("\n"), "utf8")
    const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd: dir })
    assert.equal(decisionOf(runTripwire(payload, ["--mode", "deny"]).stdout), "deny")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("tripwire still nudges large code reads at the normal threshold", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-code-read-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file }, cwd: dir })
    assert.equal(decisionOf(runTripwire(payload, ["--mode", "deny"]).stdout), "deny")
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

test("opt-in adaptive escalates allow → ask and never auto-denies", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-esc-"))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-esc-state-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd: dir, session_id: "esc-test" })
    const decisions = []
    for (let i = 0; i < 6; i += 1) {
      const r = spawnSync(process.execPath, [CLI, "tripwire", "run", "--format", "claude", "--mode", "adaptive"], {
        input: payload,
        encoding: "utf8",
        env: { ...process.env, TOOLSMITH_STATE_DIR: state, TOOLSMITH_TRIPWIRE_LOG: "0", TOOLSMITH_NO_UPDATE_CHECK: "1", TOOLSMITH_TRIPWIRE_MODE: "" },
      })
      decisions.push(decisionOf(r.stdout))
    }
    // ask after 3, then caps at ask — adaptive never auto-denies (deny is opt-in via fixed --mode)
    assert.deepEqual(decisions.slice(0, 2), ["allow", "allow"])
    assert.equal(decisions[2], "ask")
    assert.equal(decisions[5], "ask")
    assert.equal(decisions.includes("deny"), false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(state, { recursive: true, force: true })
  }
})

test("opt-in adaptive never hard-blocks a READ — caps at ask even after many bypasses", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-read-cap-"))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-read-cap-state-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file }, cwd: dir, session_id: "read-cap" })
    let last = "allow"
    for (let i = 0; i < 10; i += 1) {
      last = decisionOf(spawnSync(process.execPath, [CLI, "tripwire", "run", "--format", "claude", "--mode", "adaptive"], {
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

test("using Toolsmith resets escalation: reset-session drops a session back to a nudge", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-reset-"))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-reset-state-"))
  try {
    const file = await makeLargeFile(dir)
    const editPayload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd: dir, session_id: "reset-e2e" })
    const env = { TOOLSMITH_STATE_DIR: state, TOOLSMITH_TRIPWIRE_LOG: "0", TOOLSMITH_NO_UPDATE_CHECK: "1" }
    // Opt into adaptive and bypass enough to reach "ask".
    let last
    for (let i = 0; i < 4; i += 1) last = decisionOf(runTripwire(editPayload, ["--mode", "adaptive"], env).stdout)
    assert.equal(last, "ask")
    // Agent uses a Toolsmith tool → PostToolUse reset hook fires.
    const resetPayload = JSON.stringify({ tool_name: "mcp__toolsmith__anchored_read", session_id: "reset-e2e" })
    const r = spawnSync(process.execPath, [CLI, "tripwire", "reset-session"], { input: resetPayload, encoding: "utf8", env: { ...process.env, ...env } })
    assert.equal(r.status, 0)
    // Next bypass starts gentle again.
    assert.equal(decisionOf(runTripwire(editPayload, ["--mode", "adaptive"], env).stdout), "allow")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(state, { recursive: true, force: true })
  }
})

test("fixed deny can block an outside-cwd edit because Toolsmith can reach it", async () => {
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-oow-file-"))
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-oow-cwd-"))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-oow-state-"))
  try {
    const file = await makeLargeFile(fileDir) // lives outside workDir
    const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd: workDir, session_id: "oow" })
    assert.equal(decisionOf(runTripwire(payload, ["--mode", "deny"], { TOOLSMITH_STATE_DIR: state, TOOLSMITH_NO_UPDATE_CHECK: "1" }).stdout), "deny")
  } finally {
    await fs.rm(fileDir, { recursive: true, force: true })
    await fs.rm(workDir, { recursive: true, force: true })
    await fs.rm(state, { recursive: true, force: true })
  }
})

test("adaptive never blocks an edit on a file larger than toolsmith's read limit", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-big-"))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-big-state-"))
  try {
    const file = path.join(dir, "huge.js")
    // > 512 KB and > 200 lines: toolsmith refuses to read it, so the tripwire must not block.
    await fs.writeFile(file, Array.from({ length: 600 }, (_, i) => `const x${i} = "${"y".repeat(1000)}"`).join("\n"))
    const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd: dir, session_id: "big" })
    for (let i = 0; i < 10; i += 1) {
      assert.notEqual(decisionOf(runTripwire(payload, ["--mode", "deny"], { TOOLSMITH_STATE_DIR: state, TOOLSMITH_NO_UPDATE_CHECK: "1" }).stdout), "deny", `oversized edit must never deny even in deny mode (fire ${i + 1})`)
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

test("install bakes the EXPLICIT mode for allow/deny/adaptive (never omits it)", async () => {
  // Regression: omitting --mode for "allow" fell back to the adaptive runtime default,
  // so `install --mode allow` silently produced an asking hook. Every mode must be baked.
  for (const mode of ["allow", "deny", "adaptive"]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-home-"))
    try {
      const r = spawnSync(process.execPath, [CLI, "tripwire", "install", "--client", "claude", "--mode", mode], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      })
      assert.equal(r.status, 0)
      const settings = JSON.parse(await fs.readFile(path.join(home, ".claude", "settings.json"), "utf8"))
      const cmd = settings.hooks.PreToolUse.flatMap((e) => e.hooks).map((h) => h.command).join("\n")
      assert.match(cmd, new RegExp(`tripwire run --format claude --mode ${mode}\\b`), `install --mode ${mode} must bake it`)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  }
})

test("a baked --mode allow hook never asks, even after many bypasses (end-to-end)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-allowbake-"))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-allowbake-state-"))
  try {
    const file = await makeLargeFile(dir)
    const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd: dir, session_id: "allowbake" })
    for (let i = 0; i < 6; i += 1) {
      // simulate the baked hook: fixed --mode allow
      const out = runTripwire(payload, ["--mode", "allow"], { TOOLSMITH_STATE_DIR: state }).stdout
      assert.equal(decisionOf(out), "allow")
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(state, { recursive: true, force: true })
  }
})
