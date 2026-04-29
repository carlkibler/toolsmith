import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import extension from "../extensions/pi-dirac-edit-core.js"

async function tempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dirac-edit-core-pi-"))
}

test("Pi extension registers anchored tools and executes them", async () => {
  const registered = new Map()
  extension({ registerTool(tool) { registered.set(tool.name, tool) } })

  assert(registered.has("pi_anchored_read"))
  assert(registered.has("pi_anchored_edit"))
  assert(registered.has("pi_anchored_edit_many"))
  assert(registered.has("pi_anchored_status"))

  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "demo.txt"), "cat\ndog\neel", "utf8")
  const ctx = { cwd }

  const read = await registered.get("pi_anchored_read").execute("call-1", { path: "demo.txt", sessionId: "pi" }, undefined, undefined, ctx)
  const dogLine = read.content[0].text.split("\n").find((line) => line.endsWith("§dog"))
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

test("Pi extension multi-file tool validates before writing", async () => {
  const registered = new Map()
  extension({ registerTool(tool) { registered.set(tool.name, tool) } })

  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "left.txt"), "left\nkeep", "utf8")
  await fs.writeFile(path.join(cwd, "right.txt"), "right\nkeep", "utf8")
  const ctx = { cwd }

  const leftRead = await registered.get("pi_anchored_read").execute("call-1", { path: "left.txt", sessionId: "pi-many" }, undefined, undefined, ctx)
  const rightRead = await registered.get("pi_anchored_read").execute("call-2", { path: "right.txt", sessionId: "pi-many" }, undefined, undefined, ctx)
  const leftLine = leftRead.content[0].text.split("\n").find((line) => line.endsWith("§left"))
  const staleRightLine = rightRead.content[0].text.split("\n").find((line) => line.endsWith("§right")).replace("right", "stale")

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
