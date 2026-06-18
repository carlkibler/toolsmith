import assert from "node:assert/strict"
import test from "node:test"
import { clientAdoptionHints } from "../lib/audit.js"

test("clientAdoptionHints maps startup clients to MCP tool-call client names", () => {
  const hints = clientAdoptionHints({
    agentStartupClients: { claude: 3, codex: 2, gemini: 1 },
    agentClients: { "claude-code": 7, "codex-mcp-client": 4 },
  })

  assert.equal(hints.some((hint) => hint.startsWith("claude:")), false)
  assert.equal(hints.some((hint) => hint.startsWith("codex:")), false)
  assert.equal(hints.length, 1)
  assert.match(hints[0], /^gemini:/)
})


test("clientAdoptionHints counts startup aliases too", () => {
  const hints = clientAdoptionHints({
    agentStartupClients: { "claude-code": 2 },
    agentClients: {},
  })

  assert.deepEqual(hints, ["claude: MCP server started 2 non-test time(s), but no non-test tool calls recorded by claude/claude-code"])
})
