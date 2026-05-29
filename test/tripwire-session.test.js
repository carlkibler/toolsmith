import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { adaptiveMode, escalationThresholds, recordFire, pruneOldSessions } from "../lib/tripwire-session.js"

async function withState(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-tw-"))
  const prev = process.env.TOOLSMITH_STATE_DIR
  process.env.TOOLSMITH_STATE_DIR = dir
  try { return await fn(dir) } finally {
    if (prev === undefined) delete process.env.TOOLSMITH_STATE_DIR
    else process.env.TOOLSMITH_STATE_DIR = prev
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test("adaptiveMode escalates allow → ask → deny by fire count", () => {
  const { askAfter, denyAfter } = escalationThresholds
  assert.equal(adaptiveMode(1), "allow")
  assert.equal(adaptiveMode(askAfter - 1), "allow")
  assert.equal(adaptiveMode(askAfter), "ask")
  assert.equal(adaptiveMode(denyAfter - 1), "ask")
  assert.equal(adaptiveMode(denyAfter), "deny")
  assert.equal(adaptiveMode(denyAfter + 50), "deny")
})

test("recordFire increments per session and isolates sessions", async () => {
  await withState(() => {
    assert.equal(recordFire("sess-A"), 1)
    assert.equal(recordFire("sess-A"), 2)
    assert.equal(recordFire("sess-A"), 3)
    assert.equal(recordFire("sess-B"), 1) // a different session starts gentle again
  })
})

test("recordFire never throws and returns 1 when state is unwritable", () => {
  const prev = process.env.TOOLSMITH_STATE_DIR
  // Point at a path that cannot be a directory (a child of /dev/null) so mkdir/write fail.
  process.env.TOOLSMITH_STATE_DIR = "/dev/null/nope"
  try {
    assert.equal(recordFire("x"), 1)
  } finally {
    if (prev === undefined) delete process.env.TOOLSMITH_STATE_DIR
    else process.env.TOOLSMITH_STATE_DIR = prev
  }
})

test("pruneOldSessions removes stale counters but keeps recent ones", async () => {
  await withState(async (dir) => {
    recordFire("recent")
    recordFire("stale")
    const staleFile = path.join(dir, "tripwire-sessions", "stale.json")
    const old = Date.now() - 10 * 86_400_000
    await fs.utimes(staleFile, new Date(old), new Date(old))
    pruneOldSessions()
    assert.equal(existsSync(staleFile), false)
    assert.equal(existsSync(path.join(dir, "tripwire-sessions", "recent.json")), true)
  })
})
