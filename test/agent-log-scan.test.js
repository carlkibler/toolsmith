import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { formatAgentLogScanMarkdown, formatOpportunitiesText, scanAgentLogs } from "../src/index.js"

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-logscan-"))
}

async function writeJsonl(file, records) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8")
}

test("scanAgentLogs reports adoption and large-file lost opportunities", async () => {
  const home = await tempDir()
  const project = path.join(home, "dev", "project")
  await fs.mkdir(project, { recursive: true })
  const largePath = path.join(project, "large.js")
  const largeContent = Array.from({ length: 230 }, (_, index) => `export const value${index + 1} = ${index + 1}`).join("\n")
  await fs.writeFile(largePath, largeContent + "\n", "utf8")

  await writeJsonl(path.join(home, ".claude", "projects", "project", "session.jsonl"), [
    {
      type: "user",
      timestamp: "2026-05-05T10:00:00.000Z",
      cwd: project,
      message: { role: "user", content: [{ type: "text", text: "fix this confusing release jank and make sure toolsmith works" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-05-05T10:01:00.000Z",
      cwd: project,
      message: { role: "assistant", content: [{ type: "tool_use", id: "read1", name: "Read", input: { file_path: largePath } }] },
    },
    {
      type: "user",
      timestamp: "2026-05-05T10:02:00.000Z",
      cwd: project,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read1", content: largeContent }] },
    },
    {
      type: "assistant",
      timestamp: "2026-05-05T10:03:00.000Z",
      cwd: project,
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolsmith1", name: "mcp__toolsmith__file_skeleton", input: { path: "large.js" } }] },
    },
  ])

  await writeJsonl(path.join(home, ".codex", "sessions", "2026", "05", "05", "session.jsonl"), [
    { type: "session_meta", payload: { id: "codex-session", cwd: project } },
    {
      type: "response_item",
      timestamp: "2026-05-05T10:04:00.000Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "why is status odd and visual qa broke" }] },
    },
    {
      type: "response_item",
      timestamp: "2026-05-05T10:05:00.000Z",
      payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "sed -n '1,240p' large.js", workdir: project }) },
    },
    {
      type: "response_item",
      timestamp: "2026-05-05T10:06:00.000Z",
      payload: { type: "function_call", name: "tool_search_tool", arguments: "toolsmith anchored_read file_skeleton" },
    },
    {
      type: "response_item",
      timestamp: "2026-05-05T10:07:00.000Z",
      payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: large.js\n@@\n-old\n+new\n*** End Patch" },
    },
  ])

  const scan = scanAgentLogs({ home, host: "test-host", days: 30, maxExamples: 5 })

  assert.equal(scan.sessions.claude, 1)
  assert.equal(scan.sessions.codex, 1)
  assert.equal(scan.toolsmith.toolCalls, 1)
  assert(scan.toolsmith.activationSearches >= 1)
  assert.equal(scan.lostOpportunities.total, 2)
  assert.equal(scan.lostOpportunities.editCandidates, 1)
  assert(scan.lostOpportunities.lostLines >= 230, "lostLines should accumulate file line counts")
  assert(scan.lostOpportunities.byKind.some((entry) => entry.key === "claude_native_read_large_file"))
  assert(scan.lostOpportunities.byKind.some((entry) => entry.key === "codex_shell_sed_large_file"))
  assert(scan.interactionSignals.themes.some((entry) => entry.key === "agent productivity"))
  assert(scan.interactionSignals.frustrationSignals.some((entry) => entry.key === "why/confusing"))

  const markdown = formatAgentLogScanMarkdown(scan)
  assert.match(markdown, /Toolsmith adoption/)
  assert.match(markdown, /Lost opportunities/)

  const opportunities = formatOpportunitiesText(scan)
  assert.match(opportunities, /hard lost opportunities: 2/)
  assert.match(opportunities, /apply_patch candidates: 1/)
  assert.match(opportunities, /token estimate:.*tokens/, "should include token savings estimate")
})
