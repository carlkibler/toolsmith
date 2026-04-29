import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AnchorStore, symbolReplace } from "../src/index.js"
import { WorkspaceTools } from "../src/fs-tools.js"

const content = `function alpha() {
  return 1
}

function beta() {
  return 1
}
`

test("symbolReplace edits only the named symbol", () => {
  const store = new AnchorStore()
  const result = symbolReplace({ path: "demo.js", content, store, sessionId: "sym", name: "beta", search: "return 1", replacement: "return 2" })

  assert.equal(result.ok, true)
  assert.equal(result.matches, 1)
  assert.equal(result.content, `function alpha() {
  return 1
}

function beta() {
  return 2
}
`)
})

test("symbolReplace fails without writing content when search missing", () => {
  const store = new AnchorStore()
  const result = symbolReplace({ path: "demo.js", content, store, sessionId: "sym", name: "beta", search: "nope", replacement: "x" })

  assert.equal(result.ok, false)
  assert.equal(result.content, content)
  assert.match(result.errors[0], /search not found/)
})


test("WorkspaceTools symbolReplace includes telemetry", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-telemetry-"))
  await fs.writeFile(path.join(cwd, "demo.js"), content, "utf8")
  const tools = new WorkspaceTools({ cwd })

  const result = await tools.symbolReplace({ path: "demo.js", sessionId: "sym", name: "beta", search: "return 1", replacement: "return 2" })

  assert.equal(result.ok, true)
  assert.equal(result.telemetry.operation, "symbol_replace")
  assert.equal(result.telemetry.editDeltaBytes, 0)
  assert(result.telemetry.requestBytes > 0)
})
