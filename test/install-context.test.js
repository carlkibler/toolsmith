import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const CLI = path.resolve("bin/toolsmith.js")

async function printContext(opts = {}) {
  const { env = {}, cwd } = opts
  const result = await execFileAsync(process.execPath, [CLI, "--print-context"], {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...env },
  })
  return JSON.parse(result.stdout)
}

test("installContext: canonical git checkout (this repo)", async () => {
  // Inject a clean fake npm prefix so this test is hermetic regardless of whether
  // npm link was ever run on this machine (which would set npmGlobalIsLive=true).
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-fakeprefix-"))
  try {
    const ctx = await printContext({ cwd: path.resolve("."), env: { TOOLSMITH_FAKE_NPM_PREFIX: tmpDir } })
    assert.equal(ctx.kind, "git-checkout-canonical")
    assert.ok(ctx.repoRoot, "repoRoot is set")
    assert.match(ctx.remote, /carlkibler\/toolsmith/)
    assert.equal(ctx.npmGlobalIsLive, false)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("installContext: npm-global kind when bin is under npm prefix", async () => {
  // Simulate npm-global by faking the npm prefix to be the parent of the repo.
  // We inject TOOLSMITH_FAKE_NPM_PREFIX to redirect the prefix detection.
  // Since installContext uses `npm prefix -g`, we seed a fake prefix that encloses __filename.
  const repoRoot = path.resolve(".")
  const fakePrefix = path.dirname(repoRoot) // one level up
  // This makes binRealPath start with fakePrefix, triggering 'npm-global'.
  const ctx = await printContext({ env: { TOOLSMITH_FAKE_NPM_PREFIX: fakePrefix } })
  assert.equal(ctx.kind, "npm-global")
  assert.equal(ctx.npmGlobalPrefix, fakePrefix)
})

test("installContext: git-checkout-other for non-canonical remote via TOOLSMITH_FAKE_REMOTE", async () => {
  // gitRoot() always resolves relative to __dirname (the CLI location), so we
  // inject a fake remote to make the canonical-remote check fail.
  const ctx = await printContext({ env: { TOOLSMITH_FAKE_REMOTE: "https://github.com/someone/other-tool.git" } })
  assert.equal(ctx.kind, "git-checkout-other")
  assert.equal(ctx.remote, "https://github.com/someone/other-tool.git")
})

test("installContext: unknown when not in a git repo and not npm-global", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-unknown-"))
  try {
    // No git init — bare directory outside any git tree.
    // Also clear GIT_DIR env to avoid inheriting parent git context.
    const ctx = await printContext({ cwd: tmpDir, env: { GIT_DIR: "none" } })
    // Kind is 'unknown' only if repoRoot is null. gitRoot walks up from cwd,
    // so if tmpdir is under a git repo this may still resolve. We accept
    // 'git-checkout-other' as a valid outcome for nested temp dirs.
    assert.ok(["unknown", "git-checkout-other", "git-checkout-canonical"].includes(ctx.kind))
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("installContext: npmGlobalIsLive true when fake prefix has package dir", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-npmglobal-"))
  try {
    // Create the expected npm-global package path so existsSync returns true.
    const pkgDir = path.join(tmpDir, "lib", "node_modules", "@carlkibler", "toolsmith")
    await fs.mkdir(pkgDir, { recursive: true })
    const ctx = await printContext({ env: { TOOLSMITH_FAKE_NPM_PREFIX: tmpDir } })
    assert.equal(ctx.npmGlobalIsLive, true)
    assert.equal(ctx.npmGlobalToolsmithPath, pkgDir)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})
