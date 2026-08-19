import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { primingTargets } from "../lib/setup.js"

async function fakeHome(dirs = []) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ts-home-"))
  for (const dir of dirs) await fs.mkdir(path.join(home, dir), { recursive: true })
  return home
}

test("priming reaches omp's own instruction file when omp is installed", async () => {
  const home = await fakeHome([".claude", ".omp/agent"])
  const targets = primingTargets({ home, cwd: home })
  assert.ok(targets.includes(path.join(home, ".omp", "agent", "AGENTS.md")), `omp missing from ${targets.join(", ")}`)
})

test("omp is skipped when it is not installed", async () => {
  const home = await fakeHome([".claude"])
  const targets = primingTargets({ home, cwd: home })
  assert.ok(!targets.some((t) => t.includes(".omp")), "do not create config for a harness the user does not have")
})

test("priming still covers claude, codex and gemini", async () => {
  const home = await fakeHome([".claude", ".codex", ".gemini"])
  const targets = primingTargets({ home, cwd: home })
  assert.ok(targets.includes(path.join(home, ".claude", "CLAUDE.md")))
  assert.ok(targets.includes(path.join(home, ".codex", "AGENTS.md")))
  assert.ok(targets.includes(path.join(home, ".gemini", "GEMINI.md")))
})

test("targets are unique so a file is never primed twice", async () => {
  const home = await fakeHome([".claude", ".omp/agent"])
  await fs.writeFile(path.join(home, "AGENTS.md"), "# home\n", "utf8")
  const targets = primingTargets({ home, cwd: home })
  assert.equal(new Set(targets).size, targets.length, `duplicate target in ${targets.join(", ")}`)
})
