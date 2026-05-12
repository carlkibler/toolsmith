import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const CLI = path.resolve("bin/toolsmith.js")

async function seedHomeWithCodexConfig() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-home-"))
  const codexDir = path.join(home, ".codex")
  const configPath = path.join(codexDir, "config.toml")
  await fs.mkdir(codexDir)
  await fs.writeFile(configPath, `model = "gpt-5.5"

["/home/example/projects/toolsmith/bin/toolsmith-mcp.mjs"]

[mcp_servers.toolsmith]
command = "/old/node"
args = ["/home/example/projects/toolsmith/bin/toolsmith-mcp.mjs"]

[projects."/tmp"]
trust_level = "trusted"

["/home/example/projects/toolsmith/bin/toolsmith-mcp.mjs"]
`, "utf8")

  return { home, configPath }
}

test("setup --global: warns about devupgrade re-trap", async () => {
  // --global triggers npm install -g; the warning about devupgrade must appear regardless.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-home-"))
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "setup", "--global", "--force", "--no-priming"],
      { cwd: path.resolve("."), env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } },
    ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "" }))
    const combined = (result.stdout || "") + (result.stderr || "")
    assert.match(combined, /devupgrade/, "devupgrade warning must appear after --global setup")
    assert.match(combined, /npm uninstall -g/, "must include remediation command")
    // Clean up any installed global package so the npm tree stays clean.
    // Use the same restricted PATH so the uninstall only runs if npm was actually reachable.
    await execFileAsync("npm", ["uninstall", "-g", "@carlkibler/toolsmith"], { env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } }).catch(() => {})
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setup: labels npm-global source without internal wording", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-home-"))
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "setup", "--no-smoke", "--no-priming", "--no-codex-footer"],
      { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", TOOLSMITH_FAKE_NPM_PREFIX: path.dirname(path.resolve(".")) } },
    ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "" }))
    const combined = (result.stdout || "") + (result.stderr || "")
    assert.match(combined, /Setting up toolsmith\.\.\. \(source: npm\)/)
    assert.doesNotMatch(combined, /install kind|npm-global/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setup --no-smoke: skips MCP handshake and exits 0", async () => {
  const { home } = await seedHomeWithCodexConfig()
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "setup", "--no-smoke"],
      { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } },
    ).catch((err) => ({ stdout: err.stdout || "", exitCode: err.code }))
    assert.doesNotMatch(result.stdout || "", /MCP handshake|smoke test failed/, "--no-smoke must skip the handshake")
    assert.match(result.stdout || "", /toolsmith doctor --smoke/, "--no-smoke must remind user to verify manually")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setup: installs Toolsmith package for Pi.dev when pi is available", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-pi-home-"))
  const fakeBin = path.join(home, "bin")
  const callLog = path.join(home, "pi-calls.txt")
  const settings = path.join(home, ".pi", "agent", "settings.json")
  await fs.mkdir(fakeBin, { recursive: true })
  await fs.mkdir(path.dirname(settings), { recursive: true })
  await fs.writeFile(settings, JSON.stringify({ packages: [] }), "utf8")
  await fs.writeFile(path.join(fakeBin, "pi"), `#!/bin/sh
case "$1" in
  --version) echo "0.71.1" ;;
  install) shift; printf '%s\\n' "$*" >> ${JSON.stringify(callLog)} ;;
  list) echo "User packages:" ;;
esac
`, "utf8")
  await fs.chmod(path.join(fakeBin, "pi"), 0o755)

  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "setup", "--no-smoke", "--no-priming", "--force"],
      { cwd: path.resolve("."), env: { ...process.env, HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` } },
    ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "" }))
    const calls = await fs.readFile(callLog, "utf8")
    assert.match(calls, /toolsmith/, "pi install should receive this package path")
    assert.match(result.stdout || "", /Pi\.dev:\s+installed/, "setup should report Pi install")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setup: replaces stale npm Pi.dev toolsmith package with this checkout", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-pi-home-"))
  const fakeBin = path.join(home, "bin")
  const callLog = path.join(home, "pi-calls.txt")
  const settings = path.join(home, ".pi", "agent", "settings.json")
  await fs.mkdir(fakeBin, { recursive: true })
  await fs.mkdir(path.dirname(settings), { recursive: true })
  await fs.writeFile(settings, JSON.stringify({ packages: ["npm:@carlkibler/toolsmith"] }), "utf8")
  await fs.writeFile(path.join(fakeBin, "pi"), `#!/bin/sh
case "$1" in
  --version) echo "0.74.0" ;;
  remove) shift; printf 'remove %s\n' "$*" >> ${JSON.stringify(callLog)} ;;
  install) shift; printf 'install %s\n' "$*" >> ${JSON.stringify(callLog)} ;;
  list) echo "User packages:" ;;
esac
`, "utf8")
  await fs.chmod(path.join(fakeBin, "pi"), 0o755)

  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "setup", "--no-smoke", "--no-priming", "--force"],
      { cwd: path.resolve("."), env: { ...process.env, HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` } },
    ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "" }))
    const calls = await fs.readFile(callLog, "utf8")
    assert.match(calls, /remove npm:@carlkibler\/toolsmith/)
    assert.match(calls, new RegExp(`install ${path.resolve(".").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
    const piLines = (result.stdout || "").split("\n").filter((line) => line.includes("Pi.dev:"))
    assert.equal(piLines.length, 1)
    assert.match(piLines[0], /refreshed/)
    assert.match(piLines[0], /removed 1 stale package entry/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setup: prunes stale Pi.dev package entry when pi remove cannot match it", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-pi-home-"))
  const fakeBin = path.join(home, "bin")
  const callLog = path.join(home, "pi-calls.txt")
  const settings = path.join(home, ".pi", "agent", "settings.json")
  await fs.mkdir(fakeBin, { recursive: true })
  await fs.mkdir(path.dirname(settings), { recursive: true })
  await fs.writeFile(settings, JSON.stringify({ packages: ["npm:pi-web-access", "../../projects/toolsmith"] }), "utf8")
  await fs.writeFile(path.join(fakeBin, "pi"), `#!/bin/sh
case "$1" in
  --version) echo "0.74.0" ;;
  remove) shift; printf 'remove %s\n' "$*" >> ${JSON.stringify(callLog)}; echo "No matching package found for $*" >&2; exit 1 ;;
  install) shift; printf 'install %s\n' "$*" >> ${JSON.stringify(callLog)} ;;
  list) echo "User packages:" ;;
esac
`, "utf8")
  await fs.chmod(path.join(fakeBin, "pi"), 0o755)

  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "setup", "--no-smoke", "--no-priming", "--force"],
      { cwd: path.resolve("."), env: { ...process.env, HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` } },
    ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "" }))
    const calls = await fs.readFile(callLog, "utf8")
    const updated = JSON.parse(await fs.readFile(settings, "utf8"))
    assert.match(calls, /remove \.\.\/\.\.\/projects\/toolsmith/)
    assert.equal(updated.packages.includes("../../projects/toolsmith"), false)
    assert.deepEqual(updated.packages, ["npm:pi-web-access"])
    const piLines = (result.stdout || "").split("\n").filter((line) => line.includes("Pi.dev:"))
    assert.equal(piLines.length, 1)
    assert.match(piLines[0], /refreshed/)
    assert.match(piLines[0], /pruned 1 stale package entry/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setup: orders detected integrations and hides undetected ones", async () => {
  const { home } = await seedHomeWithCodexConfig()
  const fakeBin = path.join(home, "bin")
  await fs.mkdir(fakeBin, { recursive: true })
  await fs.writeFile(path.join(fakeBin, "claude"), `#!/bin/sh
if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then exit 0; fi
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then exit 0; fi
exit 0
`, "utf8")
  await fs.writeFile(path.join(fakeBin, "gemini"), `#!/bin/sh
if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then exit 0; fi
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then exit 0; fi
exit 0
`, "utf8")
  await fs.writeFile(path.join(fakeBin, "pi"), `#!/bin/sh
case "$1" in
  --version) echo "0.74.0" ;;
  install) exit 0 ;;
esac
`, "utf8")
  for (const command of ["opencode", "cline", "zed"]) {
    await fs.writeFile(path.join(fakeBin, command), "#!/bin/sh\ncase \"$1\" in --version) echo 1.0 ;; *) exit 0 ;; esac\n", "utf8")
  }
  for (const command of ["claude", "gemini", "pi", "opencode", "cline", "zed"]) {
    await fs.chmod(path.join(fakeBin, command), 0o755)
  }

  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "setup", "--no-smoke", "--force", "--no-priming"],
      { cwd: path.resolve("."), env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH: `${fakeBin}:/usr/bin:/bin` } },
    ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "" }))
    const lines = (result.stdout || "").split(/\r?\n/)
    const indexOf = (text) => lines.findIndex((line) => line.includes(text))
    const order = ["Claude Code:", "Codex:", "Pi.dev:", "OpenCode:", "Gemini CLI:", "Cline CLI:", "Zed:"].map(indexOf)
    assert.equal(order.every((index) => index !== -1), true, `missing expected output in:\n${result.stdout}`)
    assert.deepEqual([...order].sort((a, b) => a - b), order)
    assert.doesNotMatch(result.stdout || "", /not found — skipping/)
    assert.doesNotMatch(result.stdout || "", /Void:/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setup: MCP smoke runs and reports handshake on successful install", async () => {
  const { home } = await seedHomeWithCodexConfig()
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "setup", "--force"],
      { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", TOOLSMITH_USAGE_LOG: "0" } },
    ).catch((err) => ({ stdout: err.stdout || "", exitCode: err.code ?? 0 }))
    assert.match(result.stdout || "", /MCP handshake/, "successful setup must report MCP handshake result")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})


test("setup: installs Codex token footer without duplicating or clobbering hooks", async () => {
  const { home } = await seedHomeWithCodexConfig()
  const hooksPath = path.join(home, ".codex", "hooks.json")
  await fs.writeFile(hooksPath, JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "Read", hooks: [{ type: "command", command: "tl-hook run", timeout: 3 }] },
      ],
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: "bash ~/.codex/hooks/auto-rename-session.sh", timeout: 20 }] },
      ],
    },
  }, null, 2), "utf8")

  const runSetup = () => execFileAsync(
    process.execPath,
    [CLI, "setup", "--no-smoke", "--force", "--no-priming"],
    { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } },
  ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "" }))

  try {
    const first = await runSetup()
    await runSetup()
    const hooks = JSON.parse(await fs.readFile(hooksPath, "utf8"))
    const stopHooks = hooks.hooks.Stop.flatMap((group) => group.hooks || [])
    const footerHooks = stopHooks.filter((hook) => String(hook.command || "").includes("toolsmith-token-footer.sh"))
    assert.equal(footerHooks.length, 1, "footer hook must be installed exactly once after repeated setup")
    assert.equal(footerHooks[0].timeout, 3)
    assert.equal(stopHooks.some((hook) => hook.command === "bash ~/.codex/hooks/auto-rename-session.sh"), true, "existing Stop hooks must be preserved")
    assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, "tl-hook run", "unrelated hook events must be preserved")
    const script = await fs.stat(path.join(home, ".codex", "hooks", "toolsmith-token-footer.sh"))
    assert.equal((script.mode & 0o111) !== 0, true, "footer script must be executable")
    assert.match(first.stdout || "", /Codex footer:\s+installed/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})


test("Codex token footer is quiet by default and opt-in with env", async () => {
  const { home } = await seedHomeWithCodexConfig()
  try {
    await execFileAsync(
      process.execPath,
      [CLI, "setup", "--no-smoke", "--force", "--no-priming"],
      { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } },
    )
    const stateDir = path.join(home, ".local", "state", "toolsmith")
    await fs.mkdir(stateDir, { recursive: true })
    await fs.writeFile(path.join(stateDir, "usage.jsonl"), JSON.stringify({
      ts: new Date().toISOString(),
      event: "tool_call",
      result: { telemetry: { estimatedTokensAvoided: 1234 } },
    }) + "\n", "utf8")
    const script = path.join(home, ".codex", "hooks", "toolsmith-token-footer.sh")
    const quiet = await execFileAsync("bash", ["-c", "printf '{}' | \"$1\"", "bash", script], {
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
    })
    assert.equal(quiet.stdout, "")

    const visible = await execFileAsync("bash", ["-c", "printf '{}' | \"$1\"", "bash", script], {
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", TOOLSMITH_CODEX_FOOTER: "1" },
    })
    assert.match(visible.stdout, /Toolsmith saved 1\.23k estimated tokens/)

    const transcript = path.join(home, "session.jsonl")
    const now = Math.floor(Date.now() / 1000)
    await fs.writeFile(transcript, JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 400,
            output_tokens: 250,
            reasoning_output_tokens: 50,
            total_tokens: 1250,
          },
        },
      },
      rate_limits: {
        primary: { used_percent: 25, window_minutes: 300, resets_at: now + 90 * 60 },
        secondary: { used_percent: 5, window_minutes: 10080, resets_at: now + 25 * 60 * 60 },
      },
    }) + "\n", "utf8")
    const withLimits = await execFileAsync("bash", ["-c", "printf '%s' \"$2\" | \"$1\"", "bash", script, JSON.stringify({ transcript_path: transcript })], {
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", TOOLSMITH_CODEX_FOOTER: "1" },
    })
    assert.match(withLimits.stdout, /Codex usage: total=1,250 input=1,000/)
    assert.match(withLimits.stdout, /5h 75% ↺1h[0-9]+m/)
    assert.match(withLimits.stdout, /7d 95% ↺1d[0-9]+h/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})


test("setup --no-codex-footer skips Codex footer hook", async () => {
  const { home } = await seedHomeWithCodexConfig()
  try {
    await execFileAsync(
      process.execPath,
      [CLI, "setup", "--no-smoke", "--force", "--no-priming", "--no-codex-footer"],
      { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    await assert.rejects(fs.stat(path.join(home, ".codex", "hooks", "toolsmith-token-footer.sh")))
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setup: skips Codex footer safely when hooks.json is malformed", async () => {
  const { home } = await seedHomeWithCodexConfig()
  const hooksPath = path.join(home, ".codex", "hooks.json")
  await fs.writeFile(hooksPath, "{ not json", "utf8")
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "setup", "--no-smoke", "--force", "--no-priming"],
      { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } },
    ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "" }))
    assert.match(result.stdout || "", /Codex footer:\s+skipped/)
    assert.equal(await fs.readFile(hooksPath, "utf8"), "{ not json", "malformed user hooks.json must be left untouched")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

for (const command of ["setup", "install"]) {
  test(`toolsmith ${command} repairs Codex config without leaving orphan toolsmith path tables`, async () => {
    const { home, configPath } = await seedHomeWithCodexConfig()

    const result = await execFileAsync(process.execPath, [path.resolve("bin/toolsmith.js"), command, "--force"], {
      cwd: home,
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
    })

    const updated = await fs.readFile(configPath, "utf8")
    assert.equal(updated.match(/\[mcp_servers\.toolsmith\]/g)?.length, 1)
    assert.equal(updated.match(/^\[".*toolsmith-mcp\.(?:js|mjs)"\]$/gm), null)
    assert.match(updated, /\[projects\."\/tmp"\]\ntrust_level = "trusted"/)
    assert.match(updated, new RegExp(`command = ${JSON.stringify(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
    assert.match(result.stdout, /Codex:\s+refreshed/)
  })
}

test("setup: injects priming block into ~/.claude/CLAUDE.md", async () => {
  const { home } = await seedHomeWithCodexConfig()
  const claudeDir = path.join(home, ".claude")
  const claudeMd = path.join(claudeDir, "CLAUDE.md")
  await fs.mkdir(claudeDir, { recursive: true })
  await fs.writeFile(claudeMd, "# My Config\n\nsome existing content\n", "utf8")
  try {
    await execFileAsync(
      process.execPath,
      [CLI, "setup", "--no-smoke", "--force"],
      { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    const content = await fs.readFile(claudeMd, "utf8")
    assert.match(content, /<!-- toolsmith:begin -->/, "priming sentinel must be present")
    assert.match(content, /mcp__toolsmith__file_skeleton/, "priming block content must include file_skeleton")
    assert.match(content, /<!-- toolsmith:end -->/, "end sentinel must be present")
    assert.match(content, /some existing content/, "original content must be preserved")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setup: priming injection is idempotent — second run produces one block", async () => {
  const { home } = await seedHomeWithCodexConfig()
  const claudeDir = path.join(home, ".claude")
  const claudeMd = path.join(claudeDir, "CLAUDE.md")
  await fs.mkdir(claudeDir, { recursive: true })
  await fs.writeFile(claudeMd, "", "utf8")
  const runSetup = () => execFileAsync(
    process.execPath,
    [CLI, "setup", "--no-smoke", "--force"],
    { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } },
  ).catch((err) => ({ stdout: err.stdout || "" }))
  try {
    await runSetup()
    await runSetup()
    const content = await fs.readFile(claudeMd, "utf8")
    assert.equal((content.match(/<!-- toolsmith:begin -->/g) || []).length, 1, "exactly one priming block after two setups")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setup --no-priming: skips priming injection", async () => {
  const { home } = await seedHomeWithCodexConfig()
  const claudeDir = path.join(home, ".claude")
  const claudeMd = path.join(claudeDir, "CLAUDE.md")
  await fs.mkdir(claudeDir, { recursive: true })
  await fs.writeFile(claudeMd, "# original\n", "utf8")
  try {
    await execFileAsync(
      process.execPath,
      [CLI, "setup", "--no-smoke", "--force", "--no-priming"],
      { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    const content = await fs.readFile(claudeMd, "utf8")
    assert.doesNotMatch(content, /<!-- toolsmith:begin -->/, "--no-priming must not inject block")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("setup --tripwire installs Claude hook without priming", async () => {
  const { home } = await seedHomeWithCodexConfig()
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI, "setup", "--no-smoke", "--force", "--no-priming", "--tripwire"],
      { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    const settingsPath = path.join(home, ".claude", "settings.json")
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"))
    assert.match(result.stdout || "", /Toolsmith tripwire: installed/)
    assert.equal(JSON.stringify(settings.hooks).includes("toolsmith-tripwire"), true)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("toolsmith adopt --tripwire installs and removes Claude hook", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-adopt-tripwire-"))
  try {
    await execFileAsync(
      process.execPath,
      [CLI, "adopt", "--tripwire"],
      { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } },
    )
    const settingsPath = path.join(home, ".claude", "settings.json")
    const installed = JSON.parse(await fs.readFile(settingsPath, "utf8"))
    assert.equal(JSON.stringify(installed.hooks).includes("toolsmith-tripwire"), true)

    await execFileAsync(
      process.execPath,
      [CLI, "adopt", "--tripwire", "--remove"],
      { cwd: home, env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } },
    )
    const removed = JSON.parse(await fs.readFile(settingsPath, "utf8"))
    assert.equal(JSON.stringify(removed.hooks).includes("toolsmith-tripwire"), false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("toolsmith adopt --inject then --remove round-trips cleanly", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-adopt-"))
  const claudeDir = path.join(tmpDir, ".claude")
  const claudeMd = path.join(claudeDir, "CLAUDE.md")
  await fs.mkdir(claudeDir)
  await fs.writeFile(claudeMd, "# My Config\n\noriginal content\n", "utf8")
  try {
    // inject
    await execFileAsync(
      process.execPath,
      [CLI, "adopt", "--inject"],
      { cwd: tmpDir, env: { ...process.env, HOME: tmpDir, PATH: "/usr/bin:/bin" } },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    const after = await fs.readFile(claudeMd, "utf8")
    assert.match(after, /<!-- toolsmith:begin -->/)
    assert.match(after, /original content/)

    // remove
    await execFileAsync(
      process.execPath,
      [CLI, "adopt", "--remove"],
      { cwd: tmpDir, env: { ...process.env, HOME: tmpDir, PATH: "/usr/bin:/bin" } },
    ).catch((err) => ({ stdout: err.stdout || "" }))
    const restored = await fs.readFile(claudeMd, "utf8")
    assert.doesNotMatch(restored, /<!-- toolsmith:begin -->/, "sentinel must be removed")
    assert.match(restored, /original content/, "original content must be preserved after removal")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})
