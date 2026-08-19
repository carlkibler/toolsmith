import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { scanAgentLogs, formatAgentLogScanMarkdown } from "../src/agent-log-scan.js"

// topEntries() emits [{ key, count }], not pairs.
const kindCount = (scan, kind) => (scan.lostOpportunities.byKind.find((e) => e.key === kind) || {}).count

// omp writes ~/.omp/agent/sessions/<project>/<stamp>_<id>.jsonl, one JSON object per
// line, with tool calls as {type:"toolCall"} blocks inside a message's content array.
async function ompWorkspace({ bigLines = 400, calls = [] } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ts-omp-"))
  const project = path.join(home, "proj")
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(project, "big.js"), Array.from({ length: bigLines }, (_, i) => `const x${i} = ${i}`).join("\n"), "utf8")
  await fs.writeFile(path.join(project, "small.js"), "const a = 1\n", "utf8")

  const dir = path.join(home, ".omp", "agent", "sessions", "-proj")
  await fs.mkdir(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd: project }),
    ...calls.map((c) => JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: c.name, arguments: c.args }] },
    })),
  ]
  await fs.writeFile(path.join(dir, "2026-08-19T00-00-00-000Z_s1.jsonl"), lines.join("\n"), "utf8")
  return { home, project }
}

test("omp sessions are scanned at all", async () => {
  const { home } = await ompWorkspace({ calls: [{ name: "read", args: { path: "small.js" } }] })
  const scan = scanAgentLogs({ home, days: 7, claudeRoot: path.join(home, "none"), codexRoot: path.join(home, "none") })
  assert.equal(scan.sessions.omp, 1, "omp is Carl's most-used harness; it cannot be invisible to the scanner")
  assert.ok(scan.records.omp > 0)
  assert.ok(scan.tools.omp.some((entry) => entry.key === "read"))
})

test("an unbounded omp read of a large file is a lost opportunity", async () => {
  const { home } = await ompWorkspace({ calls: [{ name: "read", args: { path: "big.js" } }] })
  const scan = scanAgentLogs({ home, days: 7, claudeRoot: path.join(home, "none"), codexRoot: path.join(home, "none") })
  assert.equal(kindCount(scan, "omp_native_read_large_file"), 1)
  assert.equal(scan.lostOpportunities.lostLines, 400)
})

test("a small file is not a lost opportunity", async () => {
  const { home } = await ompWorkspace({ calls: [{ name: "read", args: { path: "small.js" } }] })
  const scan = scanAgentLogs({ home, days: 7, claudeRoot: path.join(home, "none"), codexRoot: path.join(home, "none") })
  assert.equal(scan.lostOpportunities.total, 0)
})

test("a bounded omp read is not counted against it", async () => {
  const { home } = await ompWorkspace({ calls: [{ name: "read", args: { path: "big.js", offset: 10, limit: 40 } }] })
  const scan = scanAgentLogs({ home, days: 7, claudeRoot: path.join(home, "none"), codexRoot: path.join(home, "none") })
  assert.equal(scan.lostOpportunities.total, 0, "reading 40 lines of a big file is the behaviour we want, not a miss")
})

test("an omp edit on a large file is a lost opportunity", async () => {
  const { home } = await ompWorkspace({ calls: [{ name: "edit", args: { path: "big.js" } }] })
  const scan = scanAgentLogs({ home, days: 7, claudeRoot: path.join(home, "none"), codexRoot: path.join(home, "none") })
  assert.equal(kindCount(scan, "omp_native_edit_large_file"), 1)
})

test("omp toolsmith calls count toward adoption", async () => {
  const { home } = await ompWorkspace({ calls: [{ name: "mcp__toolsmith__anchored_read", args: { path: "big.js" } }] })
  const scan = scanAgentLogs({ home, days: 7, claudeRoot: path.join(home, "none"), codexRoot: path.join(home, "none") })
  assert.equal(scan.toolsmith.toolCalls, 1, "using toolsmith from omp must register as adoption")
  assert.equal(scan.lostOpportunities.total, 0)
})

test("the markdown report includes omp", async () => {
  const { home } = await ompWorkspace({ calls: [{ name: "read", args: { path: "big.js" } }] })
  const scan = scanAgentLogs({ home, days: 7, claudeRoot: path.join(home, "none"), codexRoot: path.join(home, "none") })
  const md = formatAgentLogScanMarkdown(scan)
  assert.match(md, /\|\s*omp\s*\|/i, "omp needs a row in the table or its numbers are invisible")
  assert.match(md, /omp_native_read_large_file/)
})

test("skill:// pseudo-paths are ignored", async () => {
  const { home } = await ompWorkspace({ calls: [{ name: "read", args: { path: "skill://chezmoi-drift" } }] })
  const scan = scanAgentLogs({ home, days: 7, claudeRoot: path.join(home, "none"), codexRoot: path.join(home, "none") })
  assert.equal(scan.lostOpportunities.total, 0, "omp loads skills through read; those are not files")
})
