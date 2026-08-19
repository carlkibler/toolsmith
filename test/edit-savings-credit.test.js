import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { WorkspaceTools } from "../src/fs-tools.js"
import { classifyErrors } from "../src/usage-log.js"
import { McpTestClient, tempWorkspace } from "./helpers.js"

const BIG = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i} // padding so the file has real token weight`).join("\n")

async function workspaceWith(content = BIG) {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "big.js"), content, "utf8")
  return { cwd, tools: new WorkspaceTools({ cwd }) }
}

test("a failed edit books zero savings", async () => {
  const { tools } = await workspaceWith()
  await tools.read({ path: "big.js", sessionId: "s" })

  const result = await tools.edit({
    path: "big.js",
    sessionId: "s",
    edits: [{ type: "replace", anchor: "Adeadbeef§nope", endAnchor: "Adeadbeef§nope", text: "x" }],
  })

  assert.equal(result.ok, false)
  assert.equal(result.telemetry.estimatedTokensAvoided, 0, "a rejected edit avoided nothing and cost a retry turn")
  assert.equal(result.telemetry.noCreditReason, "failed")
  assert.equal(result.telemetry.compression.savedTokens, 0)
})

test("an edit that changes nothing books zero savings", async () => {
  const { tools } = await workspaceWith()
  const read = await tools.read({ path: "big.js", sessionId: "s" })
  const ref = `${read.anchors[0]}§const line0 = 0 // padding so the file has real token weight`

  const result = await tools.edit({
    path: "big.js",
    sessionId: "s",
    edits: [{ type: "replace", anchor: ref, endAnchor: ref, text: "const line0 = 0 // padding so the file has real token weight" }],
  })

  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(result.telemetry.estimatedTokensAvoided, 0, "a no-op write is not a saving")
  assert.equal(result.telemetry.noCreditReason, "unchanged")
})

test("an edit after a read does not re-claim the whole-file baseline", async () => {
  const { tools } = await workspaceWith()
  const read = await tools.read({ path: "big.js", sessionId: "s" })
  const readAvoided = read.telemetry.estimatedTokensAvoided
  const ref = `${read.anchors[5]}§const line5 = 5 // padding so the file has real token weight`

  const result = await tools.edit({
    path: "big.js",
    sessionId: "s",
    edits: [{ type: "replace", anchor: ref, endAnchor: ref, text: "const line5 = 500" }],
  })

  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.ok(
    readAvoided + result.telemetry.estimatedTokensAvoided <= read.telemetry.estimatedFullTokens,
    "read + edit together cannot claim more than reading the file once",
  )
  assert.ok(result.telemetry.estimatedTokensAvoided <= 0, "the read already booked the avoided whole-file load")
})

test("an edit with no prior read in-session still earns first-contact credit", async () => {
  const { tools } = await workspaceWith()
  // Anchors come from one session; the edit runs under a session that never loaded the
  // file, so it really did avoid pulling the whole thing into that context.
  const read = await tools.read({ path: "big.js", sessionId: "reader", startLine: 1, endLine: 5 })
  const ref = `${read.anchors[0]}§const line0 = 0 // padding so the file has real token weight`

  const result = await tools.edit({
    path: "big.js",
    sessionId: "virgin",
    edits: [{ type: "replace", anchor: ref, endAnchor: ref, text: "const line0 = 999" }],
  })

  assert.equal(result.ok, true)
  assert.ok(result.telemetry.estimatedTokensAvoided > 0, "an edit that replaces a read earns the read's credit")
  assert.ok(result.telemetry.estimatedTokensAvoided < result.telemetry.estimatedFullTokens, "and never more than the file is worth")
})

test("symbol_replace that finds nothing books zero savings", async () => {
  const { tools } = await workspaceWith("function alpha() {\n  return 1\n}\n")
  const result = await tools.symbolReplace({ path: "big.js", sessionId: "s", name: "alpha", search: "no_such_text", replacement: "x" })

  assert.equal(result.ok, false)
  assert.equal(result.telemetry.estimatedTokensAvoided, 0)
  assert.equal(result.telemetry.noCreditReason, "failed")
})

test("edit_many books zero savings for the files that failed", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "a.js"), BIG, "utf8")
  await fs.writeFile(path.join(cwd, "b.js"), BIG, "utf8")
  const tools = new WorkspaceTools({ cwd })
  const readA = await tools.read({ path: "a.js", sessionId: "s" })
  const refA = `${readA.anchors[0]}§const line0 = 0 // padding so the file has real token weight`

  const result = await tools.editMany({
    sessionId: "s",
    atomic: false,
    files: [
      { path: "a.js", edits: [{ type: "replace", anchor: refA, endAnchor: refA, text: "const line0 = 999" }] },
      { path: "b.js", edits: [{ type: "replace", anchor: "Adeadbeef§nope", endAnchor: "Adeadbeef§nope", text: "x" }] },
    ],
  })

  const failed = result.files.find((file) => file.path === "b.js")
  assert.equal(failed.ok, false)
  assert.equal(failed.telemetry.estimatedTokensAvoided, 0, "the failed file in a batch cannot claim savings")
})

test("a stale anchor error names the current anchor for that line", async () => {
  const { tools } = await workspaceWith()
  const read = await tools.read({ path: "big.js", sessionId: "s" })
  const first = `${read.anchors[0]}§const line0 = 0 // padding so the file has real token weight`
  await tools.edit({ path: "big.js", sessionId: "s", edits: [{ type: "insert_before", anchor: first, text: "// header" }] })

  // Retry with an anchor the agent captured before that insertion.
  const stale = `Anotreal§const line7 = 7 // padding so the file has real token weight`
  const result = await tools.edit({
    path: "big.js",
    sessionId: "s",
    edits: [{ type: "replace", anchor: stale, endAnchor: stale, text: "const line7 = 700" }],
  })

  assert.equal(result.ok, false)
  const message = result.errors.join("\n")
  assert.match(message, /now line 9/, "the error locates the line the agent meant")
  assert.match(message, /A[a-z0-9]+§const line7 = 7/, "the error hands back a usable anchor so the retry costs one turn, not a re-read")
})

test("classifyErrors turns edit failures into aggregatable codes without leaking source", () => {
  assert.deepEqual(classifyErrors(['edit 0: anchor "Ax" content mismatch; expected full reference "Ax§secret = 1"']), ["anchor_content_mismatch"])
  assert.deepEqual(classifyErrors(["edit 0: anchor \"Ax\" no anchors registered for this path/session; call anchored_read first"]), ["no_anchors_registered"])
  assert.deepEqual(classifyErrors(['edit 0: anchor "Ax" not found in 42 current anchors; re-read the file if it has changed']), ["anchor_stale"])
  assert.deepEqual(classifyErrors(["symbol not found: alpha"]), ["symbol_not_found"])
  assert.deepEqual(classifyErrors(["edits overlap: edit[0] (Ax) and edit[1] (Ay) share a line range"]), ["edits_overlap"])
  assert.deepEqual(classifyErrors(["something nobody has seen before"]), ["other"])
  assert.equal(classifyErrors([]), undefined)

  const codes = classifyErrors(['a.js: edit 0: anchor "Ax" content mismatch; expected x', 'b.js: edit 0: anchor "Ay" content mismatch; expected y'])
  assert.deepEqual(codes, ["anchor_content_mismatch"], "codes are deduped")
  for (const code of classifyErrors(['edit 0: anchor "Ax" content mismatch; expected full reference "Ax§API_KEY = abc123"'])) {
    assert.ok(!code.includes("abc123"), "classification never carries file content")
  }
})

test("MCP: a failed edit logs a classified reason and books zero savings", async () => {
  const cwd = await tempWorkspace()
  const usageLog = path.join(cwd, "usage.jsonl")
  await fs.writeFile(path.join(cwd, "big.js"), BIG, "utf8")
  const client = await McpTestClient.start(path.resolve("bin/toolsmith-mcp.js"), cwd, { TOOLSMITH_USAGE_LOG: usageLog })

  try {
    const read = await client.callTool("anchored_read", { path: "big.js", sessionId: "s", startLine: 1, endLine: 3 })
    // The MCP result trims the anchors array; the anchored text is the wire format.
    const body = read.structuredContent?.text || read.content[0].text
    const anchor = body.split("\n")[1].split("§")[0]
    const line = "const line0 = 0 // padding so the file has real token weight"

    const good = await client.callTool("anchored_edit", {
      path: "big.js",
      sessionId: "s",
      edits: [{ type: "replace", anchor: `${anchor}§${line}`, endAnchor: `${anchor}§${line}`, text: "const line0 = 999" }],
    })
    assert.equal(good.structuredContent.ok, true)
    assert.ok(good.structuredContent.telemetry.estimatedTokensAvoided <= 0, "the read in this session already booked the avoided load")

    const bad = await client.callTool("anchored_edit", {
      path: "big.js",
      sessionId: "s",
      edits: [{ type: "replace", anchor: "Abogus§nope", endAnchor: "Abogus§nope", text: "x" }],
    })
    assert.equal(bad.structuredContent.telemetry.estimatedTokensAvoided, 0)
    assert.equal(bad.structuredContent.telemetry.noCreditReason, "failed")
  } finally {
    await client.close()
  }

  const failures = (await fs.readFile(usageLog, "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((record) => record.result?.isError)
  assert.equal(failures.length, 1)
  assert.deepEqual(failures[0].result.errorCodes, ["anchor_stale"], "the log says WHY the edit failed, not just that it did")
  assert.equal(failures[0].result.telemetry.estimatedTokensAvoided, 0)
})
