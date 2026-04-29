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
  return fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-"))
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

  const { stdout } = await execFileAsync(process.execPath, [path.resolve("bin/toolsmith.mjs"), "read", "demo.txt"], { cwd })
  assert.match(stdout, /\[File Hash: [a-f0-9]{8}\]/)
  assert.match(stdout, /§alpha/)
})

test("MCP server lists and calls anchored tools", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "demo.txt"), "red\ngreen\nblue", "utf8")

  const client = new Client({ name: "toolsmith-test", version: "0.1.0" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("bin/toolsmith-mcp.mjs")],
    cwd,
    stderr: "pipe",
  })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert(tools.tools.some((tool) => tool.name === "anchored_read"))
    assert(tools.tools.some((tool) => tool.name === "anchored_edit"))
    assert(tools.tools.some((tool) => tool.name === "anchored_search"))
    assert(tools.tools.some((tool) => tool.name === "file_skeleton"))
    assert(tools.tools.some((tool) => tool.name === "get_function"))
    assert(tools.tools.some((tool) => tool.name === "symbol_replace"))

    await fs.writeFile(path.join(cwd, "code.js"), "function demo() {\n  return 1\n}\n", "utf8")
    const skeletonResult = await client.callTool({ name: "file_skeleton", arguments: { path: "code.js", sessionId: "mcp" } })
    assert.match(skeletonResult.content[0].text, /§function demo/)
    const functionResult = await client.callTool({ name: "get_function", arguments: { path: "code.js", name: "demo", sessionId: "mcp" } })
    assert.equal(functionResult.isError, false)
    assert.match(functionResult.content[0].text, /§  return 1/)
    const symbolReplaceResult = await client.callTool({ name: "symbol_replace", arguments: { path: "code.js", name: "demo", search: "return 1", replacement: "return 2", sessionId: "mcp" } })
    assert.equal(symbolReplaceResult.isError, false)
    assert.match(await fs.readFile(path.join(cwd, "code.js"), "utf8"), /return 2/)

    const searchResult = await client.callTool({ name: "anchored_search", arguments: { path: "demo.txt", query: "green", sessionId: "mcp", contextLines: 0 } })
    assert.match(searchResult.content[0].text, /§green/)

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

test("WorkspaceTools editMany validates all files before writing any file", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "one.txt"), "a\nb", "utf8")
  await fs.writeFile(path.join(cwd, "two.txt"), "c\nd", "utf8")
  const tools = new WorkspaceTools({ cwd })

  const one = await tools.read({ path: "one.txt", sessionId: "many" })
  const two = await tools.read({ path: "two.txt", sessionId: "many" })
  const aLine = `${one.anchors[0]}§a`
  const staleDLine = `${two.anchors[1]}§not-d`

  const result = await tools.editMany({
    sessionId: "many",
    files: [
      { path: "one.txt", edits: [{ type: "replace", anchor: aLine, endAnchor: aLine, text: "A" }] },
      { path: "two.txt", edits: [{ type: "replace", anchor: staleDLine, endAnchor: staleDLine, text: "D" }] },
    ],
  })

  assert.equal(result.ok, false)
  assert.equal(await fs.readFile(path.join(cwd, "one.txt"), "utf8"), "a\nb")
  assert.equal(await fs.readFile(path.join(cwd, "two.txt"), "utf8"), "c\nd")
})

test("WorkspaceTools dryRun validates without writing", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "demo.txt"), "one\ntwo", "utf8")
  const tools = new WorkspaceTools({ cwd })
  const read = await tools.read({ path: "demo.txt", sessionId: "dry" })
  const oneLine = `${read.anchors[0]}§one`

  const result = await tools.edit({
    path: "demo.txt",
    sessionId: "dry",
    dryRun: true,
    edits: [{ type: "replace", anchor: oneLine, endAnchor: oneLine, text: "ONE" }],
  })

  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(await fs.readFile(path.join(cwd, "demo.txt"), "utf8"), "one\ntwo")
})

test("MCP anchored_edit_many applies cross-file batch", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "one.txt"), "a\nb", "utf8")
  await fs.writeFile(path.join(cwd, "two.txt"), "c\nd", "utf8")

  const client = new Client({ name: "toolsmith-test", version: "0.1.0" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("bin/toolsmith-mcp.mjs")],
    cwd,
    stderr: "pipe",
  })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert(tools.tools.some((tool) => tool.name === "anchored_edit_many"))

    const oneRead = await client.callTool({ name: "anchored_read", arguments: { path: "one.txt", sessionId: "many-mcp" } })
    const twoRead = await client.callTool({ name: "anchored_read", arguments: { path: "two.txt", sessionId: "many-mcp" } })
    const aLine = oneRead.content[0].text.split("\n").find((line) => line.endsWith("§a"))
    const dLine = twoRead.content[0].text.split("\n").find((line) => line.endsWith("§d"))

    const result = await client.callTool({
      name: "anchored_edit_many",
      arguments: {
        sessionId: "many-mcp",
        files: [
          { path: "one.txt", edits: [{ type: "replace", anchor: aLine, endAnchor: aLine, text: "A" }] },
          { path: "two.txt", edits: [{ type: "replace", anchor: dLine, endAnchor: dLine, text: "D" }] },
        ],
      },
    })

    assert.equal(result.isError, false)
    assert.equal(await fs.readFile(path.join(cwd, "one.txt"), "utf8"), "A\nb")
    assert.equal(await fs.readFile(path.join(cwd, "two.txt"), "utf8"), "c\nD")
  } finally {
    await client.close()
  }
})
