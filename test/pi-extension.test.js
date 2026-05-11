import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import extension from "../extensions/pi-toolsmith.js"
import { tempWorkspace } from "./helpers.js"

test("Pi extension registers anchored tools and executes them", async () => {
  const registered = new Map()
  extension({ registerTool(tool) { registered.set(tool.name, tool) } })

  assert(registered.has("pi_anchored_read"))
  assert(registered.has("pi_anchored_search"))
  assert(registered.has("pi_file_skeleton"))
  assert(registered.has("pi_get_function"))
  assert(registered.has("pi_symbol_replace"))
  assert(registered.has("pi_anchored_edit"))
  assert(registered.has("pi_anchored_edit_many"))
  assert(registered.has("pi_anchored_status"))

  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "demo.txt"), "cat\ndog\neel", "utf8")
  await fs.writeFile(path.join(cwd, "code.js"), "function demo() {\n  return 1\n}\n", "utf8")
  const ctx = { cwd }

  const skeleton = await registered.get("pi_file_skeleton").execute("call-skeleton", { path: "code.js", sessionId: "pi" }, undefined, undefined, ctx)
  assert.doesNotMatch(skeleton.content[0].text, /§function demo/)
  assert.match(skeleton.details.text, /§function demo/)
  const fn = await registered.get("pi_get_function").execute("call-function", { path: "code.js", name: "demo", sessionId: "pi" }, undefined, undefined, ctx)
  assert.equal(fn.isError, false)
  assert.doesNotMatch(fn.content[0].text, /§  return 1/)
  assert.match(fn.details.text, /§  return 1/)
  const sym = await registered.get("pi_symbol_replace").execute("call-symbol", { path: "code.js", name: "demo", search: "return 1", replacement: "return 2", sessionId: "pi" }, undefined, undefined, ctx)
  assert.equal(sym.isError, false)
  assert.match(await fs.readFile(path.join(cwd, "code.js"), "utf8"), /return 2/)

  const search = await registered.get("pi_anchored_search").execute("call-1", { path: "demo.txt", query: "dog", sessionId: "pi", contextLines: 0 }, undefined, undefined, ctx)
  assert.doesNotMatch(search.content[0].text, /§dog/)
  const dogLine = search.details.text.split("\n").find((line) => line.endsWith("§dog"))
  assert(dogLine)

  const edit = await registered.get("pi_anchored_edit").execute("call-2", {
    path: "demo.txt",
    sessionId: "pi",
    edits: [{ type: "replace", anchor: dogLine, endAnchor: dogLine, text: "DOG" }],
  }, undefined, undefined, ctx)

  assert.equal(edit.isError, false)
  assert.match(edit.content[0].text, /Applied 1 anchored edit/)
  assert.equal(await fs.readFile(path.join(cwd, "demo.txt"), "utf8"), "cat\nDOG\neel")
})

test("Pi extension verbose mode returns anchored text in content", async () => {
  const registered = new Map()
  extension({ registerTool(tool) { registered.set(tool.name, tool) } })

  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "demo.txt"), "alpha\nbeta", "utf8")
  const previous = process.env.TOOLSMITH_VERBOSE
  process.env.TOOLSMITH_VERBOSE = "1"
  try {
    const read = await registered.get("pi_anchored_read").execute("call-verbose", { path: "demo.txt", sessionId: "pi-verbose" }, undefined, undefined, { cwd })
    assert.match(read.content[0].text, /§alpha/)
    assert.match(read.details.text, /§alpha/)
  } finally {
    if (previous === undefined) delete process.env.TOOLSMITH_VERBOSE
    else process.env.TOOLSMITH_VERBOSE = previous
  }
})


test("Pi extension status and tools tolerate missing ctx cwd", async () => {
  const registered = new Map()
  extension({ registerTool(tool) { registered.set(tool.name, tool) } })

  const status = await registered.get("pi_anchored_status").execute("status")
  assert.equal(status.details.cwd, process.cwd())
  assert.match(status.details.version, /^0\.1\./)
})

test("Pi symbol_replace treats not-found as guidance, not a hard adapter error", async () => {
  const registered = new Map()
  extension({ registerTool(tool) { registered.set(tool.name, tool) } })

  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "code.js"), "function demo() {\n  return 1\n}\n", "utf8")

  const result = await registered.get("pi_symbol_replace").execute("missing", { path: "code.js", name: "demo", search: "return 9", replacement: "return 2" }, undefined, undefined, { cwd })

  assert.equal(result.isError, false)
  assert.equal(result.details.notFound, true)
  assert.match(result.content[0].text, /pi_get_function/)
})

test("Pi extension multi-file tool validates before writing", async () => {
  const registered = new Map()
  extension({ registerTool(tool) { registered.set(tool.name, tool) } })

  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "left.txt"), "left\nkeep", "utf8")
  await fs.writeFile(path.join(cwd, "right.txt"), "right\nkeep", "utf8")
  const ctx = { cwd }

  const leftRead = await registered.get("pi_anchored_read").execute("call-1", { path: "left.txt", sessionId: "pi-many" }, undefined, undefined, ctx)
  const rightRead = await registered.get("pi_anchored_read").execute("call-2", { path: "right.txt", sessionId: "pi-many" }, undefined, undefined, ctx)
  const leftLine = leftRead.details.text.split("\n").find((line) => line.endsWith("§left"))
  const staleRightLine = rightRead.details.text.split("\n").find((line) => line.endsWith("§right")).replace("right", "stale")

  const result = await registered.get("pi_anchored_edit_many").execute("call-3", {
    sessionId: "pi-many",
    files: [
      { path: "left.txt", edits: [{ type: "replace", anchor: leftLine, endAnchor: leftLine, text: "LEFT" }] },
      { path: "right.txt", edits: [{ type: "replace", anchor: staleRightLine, endAnchor: staleRightLine, text: "RIGHT" }] },
    ],
  }, undefined, undefined, ctx)

  assert.equal(result.isError, true)
  assert.equal(await fs.readFile(path.join(cwd, "left.txt"), "utf8"), "left\nkeep")
  assert.equal(await fs.readFile(path.join(cwd, "right.txt"), "utf8"), "right\nkeep")
})
