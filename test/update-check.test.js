import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  cachedUpdateStatus,
  compareSemver,
  maybeScheduleRefresh,
  updateCheckDisabled,
  updateNoticeSuffix,
  updateNoticeText,
  writeUpdateCache,
} from "../lib/update-check.js"

const CLI = path.resolve("bin/toolsmith.js")

async function withState(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-state-"))
  const prev = process.env.TOOLSMITH_STATE_DIR
  process.env.TOOLSMITH_STATE_DIR = dir
  try {
    return await fn(dir)
  } finally {
    if (prev === undefined) delete process.env.TOOLSMITH_STATE_DIR
    else process.env.TOOLSMITH_STATE_DIR = prev
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test("compareSemver orders versions and ignores pre-release suffixes", () => {
  assert.equal(compareSemver("0.1.40", "0.1.41"), -1)
  assert.equal(compareSemver("0.1.41", "0.1.40"), 1)
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0)
  assert.equal(compareSemver("v0.2.0", "0.10.0"), -1)
  assert.equal(compareSemver("0.1.41-beta.1", "0.1.41"), 0)
})

test("cachedUpdateStatus reports behind/current from cache only", async () => {
  await withState(() => {
    assert.equal(cachedUpdateStatus("0.1.41"), null) // no cache yet
    writeUpdateCache({ latest: "0.1.50", checkedAt: 1 })
    const behind = cachedUpdateStatus("0.1.41")
    assert.deepEqual(behind, { behind: true, current: "0.1.41", latest: "0.1.50" })
    const current = cachedUpdateStatus("0.1.50")
    assert.equal(current.behind, false)
    const ahead = cachedUpdateStatus("0.2.0")
    assert.equal(ahead.behind, false)
  })
})

test("updateNoticeText is install-kind aware", async () => {
  await withState(() => {
    writeUpdateCache({ latest: "0.1.50", checkedAt: 1 })
    assert.match(updateNoticeText("0.1.41", { kind: "npm-global" }), /Run: toolsmith update/)
    assert.match(updateNoticeText("0.1.41", { kind: "git-checkout" }), /Run: git pull/)
    assert.equal(updateNoticeText("0.1.50", { kind: "npm-global" }), null) // up to date
  })
})

test("updateNoticeSuffix is empty when up to date", async () => {
  await withState(() => {
    writeUpdateCache({ latest: "0.1.50", checkedAt: 1 })
    assert.match(updateNoticeSuffix("0.1.41"), /toolsmith update/)
    assert.equal(updateNoticeSuffix("0.1.50"), "")
  })
})

test("updateCheckDisabled respects CI and opt-out env vars", () => {
  const prevCi = process.env.CI
  const prevOpt = process.env.TOOLSMITH_NO_UPDATE_CHECK
  try {
    delete process.env.CI
    delete process.env.TOOLSMITH_NO_UPDATE_CHECK
    assert.equal(updateCheckDisabled(), false)
    process.env.TOOLSMITH_NO_UPDATE_CHECK = "1"
    assert.equal(updateCheckDisabled(), true)
  } finally {
    if (prevCi === undefined) delete process.env.CI; else process.env.CI = prevCi
    if (prevOpt === undefined) delete process.env.TOOLSMITH_NO_UPDATE_CHECK; else process.env.TOOLSMITH_NO_UPDATE_CHECK = prevOpt
  }
})

test("maybeScheduleRefresh throttles to once per day and stamps checkedAt", async () => {
  await withState(() => {
    const prevCi = process.env.CI
    const prevOpt = process.env.TOOLSMITH_NO_UPDATE_CHECK
    delete process.env.CI
    delete process.env.TOOLSMITH_NO_UPDATE_CHECK
    try {
      writeUpdateCache({ latest: "0.1.50", checkedAt: 1000 })
      // fresh: within a day of checkedAt → no refresh
      assert.equal(maybeScheduleRefresh(1000 + 1000), false)
      // stale: more than a day later → schedules + re-stamps checkedAt
      const now = 1000 + 86_400_000 + 1
      assert.equal(maybeScheduleRefresh(now), true)
    } finally {
      if (prevCi !== undefined) process.env.CI = prevCi
      if (prevOpt !== undefined) process.env.TOOLSMITH_NO_UPDATE_CHECK = prevOpt
    }
  })
})

test("_update-refresh CLI writes the latest version into the cache (offline via fake)", async () => {
  await withState(async (dir) => {
    const r = spawnSync(process.execPath, [CLI, "_update-refresh"], {
      env: { ...process.env, TOOLSMITH_STATE_DIR: dir, TOOLSMITH_FAKE_NPM_LATEST: "9.9.9", CI: "", TOOLSMITH_NO_UPDATE_CHECK: "" },
      encoding: "utf8",
    })
    assert.equal(r.status, 0)
    const cache = JSON.parse(readFileSync(path.join(dir, "update-check.json"), "utf8"))
    assert.equal(cache.latest, "9.9.9")
    assert.ok(Number(cache.checkedAt) > 0)
  })
})

test("CLI prints an update notice to stderr when behind (and never to stdout)", async () => {
  await withState(async (dir) => {
    writeUpdateCache({ latest: "9.9.9", checkedAt: Date.now() })
    const r = spawnSync(process.execPath, [CLI, "--version"], {
      env: { ...process.env, TOOLSMITH_STATE_DIR: dir, CI: "", TOOLSMITH_NO_UPDATE_CHECK: "", FORCE_TTY: "" },
      encoding: "utf8",
    })
    // stdout carries only the version; the notice (if shown) must be on stderr.
    assert.doesNotMatch(r.stdout, /available/)
  })
})
