import test from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { TOOLSMITH_REPO_URL, TOOLSMITH_NPM_URL, provenanceTag, shellProvenanceHeader } from "../lib/provenance.js"
import { CODEX_FOOTER_COMMAND, installCodexFooter } from "../lib/codex-footer.js"
import { injectPrimingBlock } from "../lib/setup.js"

const execFileAsync = promisify(execFile)
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "toolsmith.js")

test("provenance builders include repo and npm URLs", () => {
  for (const text of [provenanceTag(), shellProvenanceHeader("x")]) {
    assert.ok(text.includes(TOOLSMITH_REPO_URL), "repo URL present")
    assert.ok(text.includes(TOOLSMITH_NPM_URL), "npm URL present")
  }
})

test("codex footer hook command carries provenance and stays matchable", () => {
  assert.ok(CODEX_FOOTER_COMMAND.includes("toolsmith-token-footer.sh"), "dedupe matcher substring intact")
  assert.ok(CODEX_FOOTER_COMMAND.includes(TOOLSMITH_REPO_URL))
  assert.ok(CODEX_FOOTER_COMMAND.includes(TOOLSMITH_NPM_URL))
})

test("installed codex footer script begins with a provenance header", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-prov-codex-"))
  const prevHome = process.env.HOME
  try {
    await fs.mkdir(path.join(home, ".codex"), { recursive: true })
    process.env.HOME = home
    installCodexFooter()
    const script = await fs.readFile(path.join(home, ".codex", "hooks", "toolsmith-token-footer.sh"), "utf8")
    assert.ok(script.includes(TOOLSMITH_REPO_URL), "footer script names the repo")
    assert.ok(script.includes(TOOLSMITH_NPM_URL), "footer script names the package")
    assert.ok(script.includes("managed by Toolsmith"))
  } finally {
    process.env.HOME = prevHome
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("priming block embeds provenance inside the toolsmith sentinels", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-prov-md-"))
  try {
    const target = path.join(dir, "CLAUDE.md")
    injectPrimingBlock(target)
    const content = await fs.readFile(target, "utf8")
    assert.ok(content.includes(TOOLSMITH_REPO_URL), "repo URL in priming block")
    assert.ok(content.includes(TOOLSMITH_NPM_URL), "npm URL in priming block")
    assert.equal((content.match(/<!-- toolsmith:begin -->/g) || []).length, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("every committed dev hook script carries the provenance header", async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dev", "claude-hooks")
  const scripts = (await fs.readdir(dir)).filter((name) => name.endsWith(".sh"))
  assert.ok(scripts.length > 0, "expected at least one dev hook script")
  for (const name of scripts) {
    const body = await fs.readFile(path.join(dir, name), "utf8")
    assert.ok(body.includes(TOOLSMITH_REPO_URL), `${name} must name the repo`)
    assert.ok(body.includes(TOOLSMITH_NPM_URL), `${name} must name the package`)
    assert.ok(body.includes("Part of Toolsmith"), `${name} must declare it is part of Toolsmith`)
  }
})

test("installed Claude tripwire hook command carries provenance", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-prov-tw-"))
  try {
    await fs.mkdir(path.join(home, ".claude"), { recursive: true })
    await execFileAsync(process.execPath, [CLI, "tripwire", "install", "--client", "claude"], {
      env: { ...process.env, HOME: home },
    })
    const settings = JSON.parse(await fs.readFile(path.join(home, ".claude", "settings.json"), "utf8"))
    const commands = settings.hooks.PreToolUse.flatMap((entry) => entry.hooks).map((hook) => hook.command)
    const tripwire = commands.find((command) => command.includes("toolsmith-tripwire"))
    assert.ok(tripwire, "tripwire hook present")
    assert.ok(tripwire.includes(TOOLSMITH_REPO_URL), "repo URL in tripwire command")
    assert.ok(tripwire.includes(TOOLSMITH_NPM_URL), "npm URL in tripwire command")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
