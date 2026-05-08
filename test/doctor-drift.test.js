import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const CLI = path.resolve("bin/toolsmith.js")

// Run doctor with a controlled $HOME that has only Codex configured.
// Claude and Gemini CLIs are absent (PATH=/bin:/usr/bin only).
async function runDoctorWithCodex(codexConfigContent) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-doctor-"))
  const codexDir = path.join(home, ".codex")
  await fs.mkdir(codexDir)
  await fs.writeFile(path.join(codexDir, "config.toml"), codexConfigContent, "utf8")
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor"],
      {
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
        cwd: path.resolve("."),
      },
    ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.code }))
    return { home, stdout: result.stdout }
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}

function codexConfig(mcpPath) {
  return `[mcp_servers.toolsmith]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(mcpPath)}]\n`
}

test("doctor: Codex stale path detected when file does not exist", async () => {
  const { stdout } = await runDoctorWithCodex(codexConfig("/nonexistent/path/toolsmith-mcp.js"))
  assert.match(stdout, /Codex: registered path does not exist on disk/)
  assert.match(stdout, /nonexistent/)
})

test("doctor: Codex drift detected when file exists but is different checkout", async () => {
  // Create a real file at a temp path so existsSync passes, but it's not our MCP_BIN.
  const tmpMcp = await fs.mkdtemp(path.join(os.tmpdir(), "fake-toolsmith-"))
  const fakeMcpPath = path.join(tmpMcp, "toolsmith-mcp.js")
  await fs.writeFile(fakeMcpPath, "// fake", "utf8")
  try {
    const { stdout } = await runDoctorWithCodex(codexConfig(fakeMcpPath))
    assert.match(stdout, /Codex: registered .+, expected .+/)
  } finally {
    await fs.rm(tmpMcp, { recursive: true, force: true })
  }
})

test("doctor: Codex ok when path matches this checkout", async () => {
  const mcpBin = path.resolve("bin/toolsmith-mcp.js")
  const { stdout } = await runDoctorWithCodex(codexConfig(mcpBin))
  assert.match(stdout, /Codex: toolsmith registered/)
  assert.match(stdout, /Codex: command points at this checkout/)
  assert.doesNotMatch(stdout, /Codex: registered path does not exist/)
  assert.doesNotMatch(stdout, /Codex: registered .+, expected/)
})

test("doctor: stale global Node install warning when fake prefix has package dir", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-npmglobal-"))
  const pkgDir = path.join(tmpDir, "lib", "node_modules", "@carlkibler", "toolsmith")
  await fs.mkdir(pkgDir, { recursive: true })
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-home-"))
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor"],
      {
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", TOOLSMITH_FAKE_NPM_PREFIX: tmpDir },
        cwd: path.resolve("."),
      },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    assert.match(result.stdout, /stale global Node install/)
    assert.match(result.stdout, /toolsmith doctor --fix/)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor: no stale global Node install warning when package dir absent", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-empty-"))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-home-"))
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor"],
      {
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", TOOLSMITH_FAKE_NPM_PREFIX: tmpDir },
        cwd: path.resolve("."),
      },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    assert.doesNotMatch(result.stdout, /stale global Node install/)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor: no stale global Node install warning when global package links to this checkout", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-linkedglobal-"))
  const pkgParent = path.join(tmpDir, "lib", "node_modules", "@carlkibler")
  const pkgDir = path.join(pkgParent, "toolsmith")
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-home-"))
  await fs.mkdir(pkgParent, { recursive: true })
  await fs.symlink(path.resolve("."), pkgDir, "dir")
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor"],
      {
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", TOOLSMITH_FAKE_NPM_PREFIX: tmpDir },
        cwd: path.resolve("."),
      },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    assert.doesNotMatch(result.stdout, /stale global Node install/)
    assert.match(result.stdout, /global Node install links to this checkout/)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor --fix: prints 'no registration issues' when only non-fixable warnings are present", async () => {
  // Use a fake home with no clients configured and no stale global Node install — so doctor
  // produces usage warnings (no MCP clients detected) but nothing in needsFix.
  // --fix should acknowledge it rather than silently doing nothing.
  // PATH="/usr/bin:/bin" hides npm so npmGlobalIsLive stays false (no TOOLSMITH_FAKE_NPM_PREFIX needed).
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-fixempty-"))
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor", "--fix", "--yes"],
      {
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
        cwd: path.resolve("."),
      },
    ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "" }))
    const combined = (result.stdout || "") + (result.stderr || "")
    assert.match(combined, /no registration issues to repair/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor: command-path drift warning when configured Node binary no longer exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-cmddrift-"))
  const codexDir = path.join(home, ".codex")
  await fs.mkdir(codexDir)
  const mcpBin = path.resolve("bin/toolsmith-mcp.js")
  // Point command at a non-existent Node binary; args point at the real MCP bin.
  const toml = `[mcp_servers.toolsmith]\ncommand = "/nonexistent/node/bin/node"\nargs = [${JSON.stringify(mcpBin)}]\n`
  await fs.writeFile(path.join(codexDir, "config.toml"), toml, "utf8")
  try {
    const { stdout } = await runDoctorWithCodex(toml)
    assert.match(stdout, /configured Node binary no longer exists/)
    assert.match(stdout, /nonexistent/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor: usage log NOT writable warning when state dir is read-only", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-logperms-"))
  const stateDir = path.join(home, ".local", "state")
  await fs.mkdir(stateDir, { recursive: true })
  await fs.chmod(stateDir, 0o444) // read-only
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor"],
      {
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", XDG_STATE_HOME: stateDir },
        cwd: path.resolve("."),
      },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    assert.match(result.stdout, /usage log NOT writable/)
  } finally {
    await fs.chmod(stateDir, 0o755).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor: malformed Codex TOML config surfaces as warn", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-badtoml-"))
  const codexDir = path.join(home, ".codex")
  await fs.mkdir(codexDir)
  await fs.writeFile(path.join(codexDir, "config.toml"), "this is not valid toml \x00\xFF", "utf8")
  // Make it unreadable (simulates permission error caught by try/catch).
  await fs.chmod(path.join(codexDir, "config.toml"), 0o000)
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor"],
      {
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
        cwd: path.resolve("."),
      },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    assert.match(result.stdout, /Codex: config unreadable/)
  } finally {
    await fs.chmod(path.join(codexDir, "config.toml"), 0o644).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor: Codex approval_policy warning when non-never", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-approvalpolicy-"))
  const codexDir = path.join(home, ".codex")
  await fs.mkdir(codexDir)
  const mcpBin = path.resolve("bin/toolsmith-mcp.js")
  const toml = `approval_policy = "untrusted"\n\n[mcp_servers.toolsmith]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(mcpBin)}]\n`
  await fs.writeFile(path.join(codexDir, "config.toml"), toml, "utf8")
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor"],
      { env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }, cwd: path.resolve(".") },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    assert.match(result.stdout, /approval_policy.*untrusted/, "must warn about non-never approval_policy")
    assert.match(result.stdout, /silently cancel/, "must mention silent cancellation risk")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor: no approval_policy warning when set to never", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-approvalnever-"))
  const codexDir = path.join(home, ".codex")
  await fs.mkdir(codexDir)
  const mcpBin = path.resolve("bin/toolsmith-mcp.js")
  const toml = `approval_policy = "never"\n\n[mcp_servers.toolsmith]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(mcpBin)}]\n`
  await fs.writeFile(path.join(codexDir, "config.toml"), toml, "utf8")
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor"],
      { env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }, cwd: path.resolve(".") },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    assert.doesNotMatch(result.stdout, /silently cancel/, "must not warn when policy is already never")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor: reports Pi.dev install and strict harness when package is configured", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-pidoctor-"))
  const fakeBin = path.join(home, "bin")
  const settings = path.join(home, ".pi", "agent", "settings.json")
  await fs.mkdir(fakeBin, { recursive: true })
  await fs.mkdir(path.dirname(settings), { recursive: true })
  await fs.writeFile(settings, JSON.stringify({ packages: [path.resolve(".")] }), "utf8")
  await fs.writeFile(path.join(fakeBin, "pi"), `#!/bin/sh
case "$1" in
  --version) echo "0.71.1" ;;
  list) echo "User packages:" ;;
esac
`, "utf8")
  await fs.chmod(path.join(fakeBin, "pi"), 0o755)

  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor"],
      { env: { ...process.env, HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` }, cwd: path.resolve(".") },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    assert.match(result.stdout, /Pi\.dev: toolsmith package installed/)
    assert.match(result.stdout, /Pi\.dev strict harness: toolsmith pi/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor: warns when Pi.dev toolsmith package points at npm instead of this checkout", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-pidoctor-"))
  const fakeBin = path.join(home, "bin")
  const settings = path.join(home, ".pi", "agent", "settings.json")
  await fs.mkdir(fakeBin, { recursive: true })
  await fs.mkdir(path.dirname(settings), { recursive: true })
  await fs.writeFile(settings, JSON.stringify({ packages: ["npm:@carlkibler/toolsmith"] }), "utf8")
  await fs.writeFile(path.join(fakeBin, "pi"), `#!/bin/sh
case "$1" in
  --version) echo "0.74.0" ;;
  list) echo "User packages:" ;;
esac
`, "utf8")
  await fs.chmod(path.join(fakeBin, "pi"), 0o755)

  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor"],
      { env: { ...process.env, HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` }, cwd: path.resolve(".") },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    assert.match(result.stdout, /Pi\.dev: toolsmith package points at npm:@carlkibler\/toolsmith/)
    assert.match(result.stdout, new RegExp(path.resolve(".").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor: adoption gap warn when no agent calls in log", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-adoptgap-"))
  const stateDir = path.join(home, ".local", "state", "toolsmith")
  await fs.mkdir(stateDir, { recursive: true })
  // Write only harness records so agentToolCalls=0
  const logPath = path.join(stateDir, "usage.jsonl")
  const harness = { ts: new Date().toISOString(), event: "tool_call", client: "node-test-or-wrapper", cwdName: "toolsmith-a1b2", tool: "anchored_read", args: { sessionId: "harness" } }
  await fs.writeFile(logPath, JSON.stringify(harness) + "\n", "utf8")
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor"],
      { env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", XDG_STATE_HOME: path.join(home, ".local", "state") }, cwd: path.resolve(".") },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    assert.match(result.stdout, /no non-test agent tool calls/, "must warn about zero agent calls")
    assert.match(result.stdout, /toolsmith adopt --inject/, "must suggest the adopt command")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor: reports adoption count when real agent calls exist", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-adopthappy-"))
  const stateDir = path.join(home, ".local", "state", "toolsmith")
  await fs.mkdir(stateDir, { recursive: true })
  const logPath = path.join(stateDir, "usage.jsonl")
  const agentCall = { ts: new Date().toISOString(), event: "tool_call", client: "claude", cwdName: "myproject", tool: "anchored_read", args: { sessionId: "real", path: "src/big.ts" } }
  await fs.writeFile(logPath, JSON.stringify(agentCall) + "\n", "utf8")
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor"],
      { env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", XDG_STATE_HOME: path.join(home, ".local", "state") }, cwd: path.resolve(".") },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    assert.match(result.stdout, /latest agent tool call claude\/anchored_read/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("doctor --fix --yes: stale global Node install prompts to run npm uninstall", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-fixnpm-"))
  const pkgDir = path.join(tmpDir, "lib", "node_modules", "@carlkibler", "toolsmith")
  await fs.mkdir(pkgDir, { recursive: true })
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-fixnpmhome-"))
  // Create a fake npm shim that records invocations so we can verify --fix calls it.
  const fakeNpmDir = path.join(home, "bin")
  await fs.mkdir(fakeNpmDir)
  const fakeNpmPath = path.join(fakeNpmDir, "npm")
  const callLog = path.join(home, "npm-calls.txt")
  await fs.writeFile(fakeNpmPath, `#!/bin/sh\necho "$@" >> ${callLog}\n`, "utf8")
  await fs.chmod(fakeNpmPath, 0o755)
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "doctor", "--fix", "--yes"],
      {
        env: { ...process.env, HOME: home, PATH: `${fakeNpmDir}:/usr/bin:/bin`, TOOLSMITH_FAKE_NPM_PREFIX: tmpDir },
        cwd: path.resolve("."),
      },
    ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "" }))
    const combined = (result.stdout || "") + (result.stderr || "")
    assert.match(combined, /stale global Node install/)
    const calls = await fs.readFile(callLog, "utf8").catch(() => "")
    assert.match(calls, /uninstall.*-g.*@carlkibler\/toolsmith/)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})
