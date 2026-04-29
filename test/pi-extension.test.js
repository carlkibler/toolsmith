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
