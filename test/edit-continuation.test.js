import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { WorkspaceTools } from "../src/fs-tools.js"
import { McpTestClient, tempWorkspace } from "./helpers.js"

const BIG = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i} // pad`).join("\n")

async function workspaceWith(content = BIG) {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "big.js"), content, "utf8")
  return { cwd, tools: new WorkspaceTools({ cwd }) }
}

const ref = (anchor, line) => `${anchor}§${line}`

test("an edit hands back anchored lines for the region it changed", async () => {
  const { tools } = await workspaceWith()
  const read = await tools.read({ path: "big.js", sessionId: "s", startLine: 1, endLine: 20 })
  const target = ref(read.anchors[5], "const line5 = 5 // pad")

  const result = await tools.edit({
    path: "big.js",
    sessionId: "s",
    edits: [{ type: "replace", anchor: target, endAnchor: target, text: "const line5 = 500 // pad\nconst line5b = 1 // pad" }],
  })

  assert.equal(result.ok, true)
  assert.ok(result.editedText, "the changed region comes back anchored, so a second edit needs no re-read")
  assert.match(result.editedText, /A[a-z0-9]+§const line5 = 500 \/\/ pad/)
  assert.match(result.editedText, /A[a-z0-9]+§const line5b = 1 \/\/ pad/)
  assert.ok(result.editedText.split("\n").length <= 20, "and it stays small — this is a token-efficiency tool")
})

test("the anchors an edit returns are immediately usable for the next edit", async () => {
  const { cwd, tools } = await workspaceWith()
  const read = await tools.read({ path: "big.js", sessionId: "s", startLine: 1, endLine: 20 })
  const target = ref(read.anchors[5], "const line5 = 5 // pad")

  const first = await tools.edit({
    path: "big.js",
    sessionId: "s",
    edits: [{ type: "replace", anchor: target, endAnchor: target, text: "const line5 = 500 // pad" }],
  })

  // Take an anchor straight out of the previous response — no intervening read.
  const line = first.editedText.split("\n").find((l) => l.includes("const line5 = 500"))
  const second = await tools.edit({
    path: "big.js",
    sessionId: "s",
    edits: [{ type: "replace", anchor: line, endAnchor: line, text: "const line5 = 5000 // pad" }],
  })

  assert.equal(second.ok, true, second.errors?.join("; "))
  assert.match(await fs.readFile(path.join(cwd, "big.js"), "utf8"), /const line5 = 5000 \/\/ pad/, "the chained edit really landed")
})

test("multiple edits in one call each report their changed region", async () => {
  const { tools } = await workspaceWith()
  const read = await tools.read({ path: "big.js", sessionId: "s" })
  const a = ref(read.anchors[10], "const line10 = 10 // pad")
  const b = ref(read.anchors[300], "const line300 = 300 // pad")

  const result = await tools.edit({
    path: "big.js",
    sessionId: "s",
    edits: [
      { type: "replace", anchor: a, endAnchor: a, text: "const line10 = 1010 // pad" },
      { type: "replace", anchor: b, endAnchor: b, text: "const line300 = 3030 // pad" },
    ],
  })

  assert.equal(result.ok, true)
  assert.match(result.editedText, /const line10 = 1010/)
  assert.match(result.editedText, /const line300 = 3030/)
  // Two distant regions must not drag the whole file back with them.
  assert.ok(result.editedText.split("\n").length < 40, `expected a bounded preview, got ${result.editedText.split("\n").length} lines`)
})

test("a far-apart edit set stays bounded on a huge file", async () => {
  const huge = Array.from({ length: 12000 }, (_, i) => `const line${i} = ${i} // pad`).join("\n")
  const { tools } = await workspaceWith(huge)
  const read = await tools.read({ path: "big.js", sessionId: "s" })
  const edits = [0, 3000, 6000, 9000, 11500].map((i) => {
    const r = ref(read.anchors[i], `const line${i} = ${i} // pad`)
    return { type: "replace", anchor: r, endAnchor: r, text: `const line${i} = ${i}00 // pad` }
  })

  const result = await tools.edit({ path: "big.js", sessionId: "s", edits })
  assert.equal(result.ok, true)
  assert.ok(result.editedText.split("\n").length < 60, "the preview is capped regardless of how scattered the edits are")
  assert.ok(result.telemetry.estimatedTokensAvoided !== undefined)
})

test("a failed edit returns no region preview", async () => {
  const { tools } = await workspaceWith()
  await tools.read({ path: "big.js", sessionId: "s" })
  const result = await tools.edit({
    path: "big.js",
    sessionId: "s",
    edits: [{ type: "replace", anchor: "Abogus§nope", endAnchor: "Abogus§nope", text: "x" }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.editedText, undefined)
})

test("a dry run previews the region it would change without writing", async () => {
  const { cwd, tools } = await workspaceWith()
  const read = await tools.read({ path: "big.js", sessionId: "s", startLine: 1, endLine: 20 })
  const target = ref(read.anchors[5], "const line5 = 5 // pad")

  const result = await tools.edit({
    path: "big.js",
    sessionId: "s",
    dryRun: true,
    edits: [{ type: "replace", anchor: target, endAnchor: target, text: "const line5 = 500 // pad" }],
  })

  assert.equal(result.ok, true)
  assert.match(await fs.readFile(path.join(cwd, "big.js"), "utf8"), /const line5 = 5 \/\/ pad/, "dry run must not write")
})

test("MCP: the edit response carries the anchors and says a re-read is unnecessary", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "big.js"), BIG, "utf8")
  const client = await McpTestClient.start(path.resolve("bin/toolsmith-mcp.js"), cwd)

  try {
    const read = await client.callTool("anchored_read", { path: "big.js", sessionId: "s", startLine: 1, endLine: 10 })
    const body = read.structuredContent?.text || read.content[0].text
    const anchor = body.split("\n").find((l) => l.includes("const line5 = 5 //")).split("§")[0]

    const edited = await client.callTool("anchored_edit", {
      path: "big.js",
      sessionId: "s",
      edits: [{ type: "replace", anchor: `${anchor}§const line5 = 5 // pad`, endAnchor: `${anchor}§const line5 = 5 // pad`, text: "const line5 = 500 // pad" }],
    })

    const text = edited.content[0].text
    assert.match(text, /A[a-z0-9]+§const line5 = 500 \/\/ pad/, "the agent gets a usable anchor back")
    assert.match(text, /without re-reading|no re-read/i, "and is told plainly it does not need another read")
  } finally {
    await client.close()
  }
})
