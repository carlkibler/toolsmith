import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const CLI = path.resolve("bin/toolsmith.js")

async function makeFakeGlobal() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-update-"))
  const binDir = path.join(tmpDir, "bin")
  const prefix = path.join(tmpDir, "npm-global")
  const globalBinDir = path.join(prefix, "bin")
  const npmLog = path.join(tmpDir, "npm.log")
  const setupLog = path.join(tmpDir, "setup.log")
  await fs.mkdir(binDir, { recursive: true })
  await fs.mkdir(globalBinDir, { recursive: true })
  await fs.writeFile(path.join(binDir, "npm"), `#!/bin/sh
printf '%s\n' "$@" >> "$TOOLSMITH_NPM_LOG"
if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then
  printf '%s\n' "$TOOLSMITH_FAKE_NPM_PREFIX"
  exit 0
fi
exit 0
`)
  await fs.chmod(path.join(binDir, "npm"), 0o755)
  await fs.writeFile(path.join(globalBinDir, "toolsmith"), `#!/bin/sh
printf '%s\n' "$@" >> "$TOOLSMITH_SETUP_LOG"
exit 0
`)
  await fs.chmod(path.join(globalBinDir, "toolsmith"), 0o755)
  return { tmpDir, binDir, prefix, npmLog, setupLog }
}

async function runUpdate(opts = {}) {
  const { cwd, env = {}, args = [], noSetup = true } = opts
  const cliArgs = [CLI, "update", ...(noSetup ? ["--no-setup"] : []), ...args]
  const result = await execFileAsync(
    process.execPath,
    cliArgs,
    { cwd: cwd || process.cwd(), env: { ...process.env, ...env } },
  ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.code || 1 }))
  return result
}

test("update --github: installs latest GitHub release even when running from checkout", async () => {
  const fake = await makeFakeGlobal()
  try {
    const result = await runUpdate({
      args: ["--github"],
      env: {
        PATH: `${fake.binDir}:${process.env.PATH}`,
        TOOLSMITH_FAKE_NPM_PREFIX: fake.prefix,
        TOOLSMITH_FAKE_RELEASE_TAG: "v9.9.9",
        TOOLSMITH_NPM_LOG: fake.npmLog,
      },
    })
    assert.equal(result.exitCode, undefined)
    const combined = (result.stdout || "") + (result.stderr || "")
    assert.match(combined, /Updating toolsmith from github \(v9\.9\.9\)/)
    const log = await fs.readFile(fake.npmLog, "utf8")
    assert.match(log, /uninstall\n-g\n@carlkibler\/toolsmith\n--silent/)
    assert.match(log, /install\n-g\ngithub:carlkibler\/toolsmith#v9\.9\.9\n--silent/)
  } finally {
    await fs.rm(fake.tmpDir, { recursive: true, force: true })
  }
})

test("update --from PATH: installs explicit local source instead of release", async () => {
  const fake = await makeFakeGlobal()
  const source = path.join(fake.tmpDir, "checkout")
  await fs.mkdir(source)
  try {
    const result = await runUpdate({
      args: ["--from", source],
      env: {
        PATH: `${fake.binDir}:${process.env.PATH}`,
        TOOLSMITH_FAKE_NPM_PREFIX: fake.prefix,
        TOOLSMITH_FAKE_RELEASE_TAG: "v9.9.9",
        TOOLSMITH_NPM_LOG: fake.npmLog,
      },
    })
    assert.equal(result.exitCode, undefined)
    const log = await fs.readFile(fake.npmLog, "utf8")
    assert.match(log, new RegExp(`install\\n-g\\n${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n--silent`))
    assert.ok(!log.includes("github:carlkibler/toolsmith"), "--from should not install the release package")
  } finally {
    await fs.rm(fake.tmpDir, { recursive: true, force: true })
  }
})

test("update --check --github: reports current source and latest release without installing", async () => {
  const fake = await makeFakeGlobal()
  try {
    const result = await runUpdate({
      args: ["--check", "--github"],
      env: {
        PATH: `${fake.binDir}:${process.env.PATH}`,
        TOOLSMITH_FAKE_NPM_PREFIX: fake.prefix,
        TOOLSMITH_FAKE_RELEASE_TAG: "v9.9.9",
        TOOLSMITH_FAKE_RELEASE_PUBLISHED_AT: "2026-05-07T12:00:00Z",
        TOOLSMITH_NPM_LOG: fake.npmLog,
      },
    })
    assert.equal(result.exitCode, undefined)
    const combined = (result.stdout || "") + (result.stderr || "")
    assert.match(combined, /current: v/)
    assert.match(combined, /latest github release: v9\.9\.9, published 2026-05-07/)
    const log = await fs.readFile(fake.npmLog, "utf8")
    assert.equal(log, "prefix\n-g\n")
  } finally {
    await fs.rm(fake.tmpDir, { recursive: true, force: true })
  }
})


test("update --check: labels npm-global installs as npm packages", async () => {
  const result = await runUpdate({
    args: ["--check"],
    env: {
      TOOLSMITH_FAKE_NPM_PREFIX: path.dirname(path.resolve(".")),
      TOOLSMITH_FAKE_RELEASE_TAG: "v9.9.9",
      TOOLSMITH_FAKE_RELEASE_PUBLISHED_AT: "2026-05-07T12:00:00Z",
    },
  })
  assert.equal(result.exitCode, undefined)
  const combined = (result.stdout || "") + (result.stderr || "")
  assert.match(combined, /current: v.*npm/)
  assert.doesNotMatch(combined, /npm-global/)
})

test("update: refreshes client integrations through the newly installed global binary", async () => {
  const fake = await makeFakeGlobal()
  try {
    const result = await runUpdate({
      noSetup: false,
      args: ["--no-codex-footer"],
      env: {
        PATH: `${fake.binDir}:${process.env.PATH}`,
        TOOLSMITH_FAKE_NPM_PREFIX: fake.prefix,
        TOOLSMITH_FAKE_RELEASE_TAG: "v9.9.9",
        TOOLSMITH_NPM_LOG: fake.npmLog,
        TOOLSMITH_SETUP_LOG: fake.setupLog,
      },
    })
    assert.equal(result.exitCode, undefined)
    const setup = await fs.readFile(fake.setupLog, "utf8")
    assert.equal(setup, "setup\n--force\n--no-smoke\n--no-priming\n--no-summary\n--no-codex-footer\n")
  } finally {
    await fs.rm(fake.tmpDir, { recursive: true, force: true })
  }
})
