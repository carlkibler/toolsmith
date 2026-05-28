import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { backupConfigFile } from "../lib/config.js"

test("backupConfigFile copies the prior contents to <path>.toolsmith-bak", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-bak-"))
  try {
    const cfg = path.join(dir, "settings.json")
    await fs.writeFile(cfg, '{"original":true}')
    backupConfigFile(cfg)
    assert.equal(await fs.readFile(`${cfg}.toolsmith-bak`, "utf8"), '{"original":true}')

    // A later write + backup captures the most recent prior state (mv restores it).
    await fs.writeFile(cfg, '{"original":false}')
    backupConfigFile(cfg)
    assert.equal(await fs.readFile(`${cfg}.toolsmith-bak`, "utf8"), '{"original":false}')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("backupConfigFile is a no-op for a missing file and never throws", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-bak-"))
  try {
    const missing = path.join(dir, "nope.json")
    assert.doesNotThrow(() => backupConfigFile(missing))
    assert.equal(existsSync(`${missing}.toolsmith-bak`), false)
    assert.doesNotThrow(() => backupConfigFile(undefined))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
