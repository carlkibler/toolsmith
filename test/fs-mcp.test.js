import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { WorkspaceTools } from "../src/fs-tools.js"

const execFileAsync = promisify(execFile)

async function tempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dirac-edit-core-"))
}

test("WorkspaceTools reads and writes files inside cwd", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "demo.txt"), "one\ntwo\nthree", "utf8")
  const tools = new WorkspaceTools({ cwd })

  const read = await tools.read({ path: "demo.txt", sessionId: "s" })
  const twoRef = `${read.anchors[1]}§two`
  const edited = await tools.edit({
    path: "demo.txt",
    sessionId: "s",
    edits: [{ type: "replace", anchor: twoRef, endAnchor: twoRef, text: "TWO" }],
  })

  assert.equal(edited.ok, true)
  assert.equal(await fs.readFile(path.join(cwd, "demo.txt"), "utf8"), "one\nTWO\nthree")
})

test("WorkspaceTools rejects path traversal", async () => {
  const cwd = await tempWorkspace()
  const tools = new WorkspaceTools({ cwd })
  await assert.rejects(() => tools.read({ path: "../nope" }), /escapes workspace/)
})

test("CLI read emits anchored content", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "demo.txt"), "alpha\nbeta", "utf8")

  const { stdout } = await execFileAsync(process.execPath, [path.resolve("bin/dirac-edit-core.mjs"), "read", "demo.txt"], { cwd })
  assert.match(stdout, /\[File Hash: [a-f0-9]{8}\]/)
  assert.match(stdout, /§alpha/)
})

test("MCP server lists and calls anchored tools", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "demo.txt"), "red\ngreen\nblue", "utf8")

  const client = new Client({ name: "dirac-edit-core-test", version: "0.1.0" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("bin/dirac-edit-core-mcp.mjs")],
    cwd,
    stderr: "pipe",
  })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert(tools.tools.some((tool) => tool.name === "anchored_read"))
    assert(tools.tools.some((tool) => tool.name === "anchored_edit"))

    const readResult = await client.callTool({ name: "anchored_read", arguments: { path: "demo.txt", sessionId: "mcp" } })
    const readText = readResult.content[0].text
    assert.match(readText, /§green/)
    const greenLine = readText.split("\n").find((line) => line.endsWith("§green"))

    const editResult = await client.callTool({
      name: "anchored_edit",
      arguments: {
        path: "demo.txt",
        sessionId: "mcp",
        edits: [{ type: "replace", anchor: greenLine, endAnchor: greenLine, text: "GREEN" }],
      },
    })
    assert.equal(editResult.isError, false)
    assert.match(editResult.content[0].text, /Applied 1 anchored edit/)
    assert.equal(await fs.readFile(path.join(cwd, "demo.txt"), "utf8"), "red\nGREEN\nblue")
  } finally {
    await client.close()
  }
})
