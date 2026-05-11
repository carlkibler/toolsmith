import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { WorkspaceTools } from "../src/fs-tools.js"
import { McpTestClient, tempWorkspace } from "./helpers.js"

const execFileAsync = promisify(execFile)

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

test("WorkspaceTools rejects symlink pointing outside workspace", async () => {
  const cwd = await tempWorkspace()
  const link = path.join(cwd, "escape.txt")
  await fs.symlink("/etc/hosts", link)
  const tools = new WorkspaceTools({ cwd })
  await assert.rejects(() => tools.read({ path: "escape.txt" }), /escapes workspace via symlink/)
})

test("WorkspaceTools reads a regular file normally", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "plain.txt"), "hello", "utf8")
  const tools = new WorkspaceTools({ cwd })
  const result = await tools.read({ path: "plain.txt", sessionId: "t" })
  assert.match(result.text, /§hello/)
})

test("WorkspaceTools findAndAnchor searches directories with editable anchors", async () => {
  const cwd = await tempWorkspace()
  await fs.mkdir(path.join(cwd, "src"))
  await fs.writeFile(path.join(cwd, "src", "alpha.js"), "const needle = 1\nconst hay = 2\n", "utf8")
  await fs.writeFile(path.join(cwd, "src", "notes.txt"), "const needle = ignored\n", "utf8")
  const tools = new WorkspaceTools({ cwd })

  const result = await tools.findAndAnchor({ path: "src", query: "needle", glob: "*.js", sessionId: "find", contextLines: 0 })
  assert.equal(result.matchedFiles, 1)
  assert.equal(result.matches.length, 1)
  assert.match(result.text, /src\/alpha\.js/)
  assert.doesNotMatch(result.text, /notes\.txt/)

  const needleLine = result.text.split("\n").find((line) => line.endsWith("§const needle = 1"))
  const edited = await tools.edit({
    path: "src/alpha.js",
    sessionId: "find",
    edits: [{ type: "replace", anchor: needleLine, endAnchor: needleLine, text: "const needle = 2" }],
  })
  assert.equal(edited.ok, true)
  assert.equal(await fs.readFile(path.join(cwd, "src", "alpha.js"), "utf8"), "const needle = 2\nconst hay = 2\n")
})

test("WorkspaceTools findAndAnchor limits matches per file during directory search", async () => {
  const cwd = await tempWorkspace()
  await fs.mkdir(path.join(cwd, "src"))
  await fs.writeFile(path.join(cwd, "src", "one.js"), "needle one\nneedle two\n", "utf8")
  await fs.writeFile(path.join(cwd, "src", "two.js"), "needle three\n", "utf8")
  const tools = new WorkspaceTools({ cwd })

  const result = await tools.findAndAnchor({ path: "src", query: "needle", glob: "*.js", maxMatches: 4, maxMatchesPerFile: 1, sessionId: "find-limit", contextLines: 0 })
  assert.equal(result.matches.length, 2)
  assert.equal(result.maxMatchesPerFile, 1)
  assert(result.matches.some((match) => match.path === "src/one.js"))
  assert(result.matches.some((match) => match.path === "src/two.js"))
})

test("CLI read emits anchored content", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "demo.txt"), "alpha\nbeta", "utf8")

  const { stdout } = await execFileAsync(process.execPath, [path.resolve("bin/toolsmith.js"), "read", "demo.txt"], { cwd })
  assert.match(stdout, /\[File Hash: [a-f0-9]{8}\]/)
  assert.match(stdout, /§alpha/)
})

test("CLI find-and-anchor honors positional path with explicit query", async () => {
  const cwd = await tempWorkspace()
  await fs.mkdir(path.join(cwd, "src"))
  await fs.writeFile(path.join(cwd, "src", "hit.js"), "const needle = 1\n", "utf8")
  await fs.writeFile(path.join(cwd, "miss.js"), "const needle = 2\n", "utf8")

  const { stdout } = await execFileAsync(process.execPath, [path.resolve("bin/toolsmith.js"), "find-and-anchor", "src", "--query", "needle", "--glob", "*.js"], { cwd })
  assert.match(stdout, /src\/hit\.js/)
  assert.doesNotMatch(stdout, /miss\.js/)
})


test("MCP usage-log disabled startup is quiet on stderr", async () => {
  const cwd = await tempWorkspace()
  const proc = spawn(process.execPath, [path.resolve("bin/toolsmith-mcp.js")], { cwd, env: { ...process.env, TOOLSMITH_USAGE_LOG: "0" }, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  proc.stdout.setEncoding("utf8")
  proc.stderr.setEncoding("utf8")
  proc.stdout.on("data", (chunk) => { stdout += chunk })
  proc.stderr.on("data", (chunk) => { stderr += chunk })
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" }, capabilities: {} } }) + "\n")
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }) + "\n")
  proc.stdin.end()
  await new Promise((resolve) => proc.on("close", resolve))

  assert.equal(stderr, "")
  assert.match(stdout, /"id":1/)
  assert.match(stdout, /"id":2/)
})

test("MCP server lists and calls anchored tools", async () => {
  const cwd = await tempWorkspace()
  const usageLog = path.join(cwd, "usage.jsonl")
  await fs.writeFile(path.join(cwd, "demo.txt"), "red\ngreen\nblue", "utf8")

  const client = await McpTestClient.start(path.resolve("bin/toolsmith-mcp.js"), cwd, { TOOLSMITH_USAGE_LOG: usageLog })
  try {
    const { tools } = await client.listTools()
    assert(tools.some((t) => t.name === "anchored_read"))
    assert(tools.some((t) => t.name === "anchored_edit"))
    assert(tools.some((t) => t.name === "anchored_search"))
    assert(tools.some((t) => t.name === "file_skeleton"))
    assert(tools.some((t) => t.name === "get_function"))
    assert(tools.some((t) => t.name === "find_and_anchor"))
    assert(tools.some((t) => t.name === "symbol_replace"))

    await fs.writeFile(path.join(cwd, "code.js"), "function demo() {\n  return 1\n}\n", "utf8")
    const skeleton = await client.callTool("file_skeleton", { path: "code.js", sessionId: "mcp" })
    assert.doesNotMatch(skeleton.content[0].text, /§function demo/)
    assert.match(skeleton.structuredContent.text, /§function demo/)

    const fn = await client.callTool("get_function", { path: "code.js", name: "demo", sessionId: "mcp" })
    assert.equal(fn.isError, false)
    assert.doesNotMatch(fn.content[0].text, /§  return 1/)
    assert.match(fn.structuredContent.text, /§  return 1/)

    const sym = await client.callTool("symbol_replace", { path: "code.js", name: "demo", search: "return 1", replacement: "return 2", sessionId: "mcp" })
    assert.equal(sym.isError, false)
    assert.match(await fs.readFile(path.join(cwd, "code.js"), "utf8"), /return 2/)

    const found = await client.callTool("find_and_anchor", { path: ".", query: "return 2", glob: "*.js", sessionId: "mcp-find", maxMatches: 3 })
    assert.notEqual(found.isError, true)
    assert.doesNotMatch(found.content[0].text, /§  return 2/)
    assert.match(found.structuredContent.text, /\[Find: return 2\]/)
    assert.match(found.structuredContent.text, /code\.js/)
    assert.match(found.structuredContent.text, /§  return 2/)

    const search = await client.callTool("anchored_search", { path: "demo.txt", query: "green", sessionId: "mcp", contextLines: 0 })
    assert.doesNotMatch(search.content[0].text, /§green/)
    assert.match(search.structuredContent.text, /§green/)

    const read = await client.callTool("anchored_read", { path: "demo.txt", sessionId: "mcp" })
    assert.doesNotMatch(read.content[0].text, /§green/)
    const readText = read.structuredContent.text
    assert.match(readText, /§green/)
    const greenLine = readText.split("\n").find((line) => line.endsWith("§green"))

    const edit = await client.callTool("anchored_edit", {
      path: "demo.txt", sessionId: "mcp",
      edits: [{ type: "replace", anchor: greenLine, endAnchor: greenLine, text: "GREEN" }],
    })
    assert.equal(edit.isError, false)
    assert.match(edit.content[0].text, /Applied 1 anchored edit/)
    assert.equal(await fs.readFile(path.join(cwd, "demo.txt"), "utf8"), "red\nGREEN\nblue")

    const usage = (await fs.readFile(usageLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert(usage.some((r) => r.event === "startup"))
    assert(usage.some((r) => r.event === "tools_list" && r.toolCount >= 9))
    assert(usage.some((r) => r.event === "tool_call" && r.tool === "file_skeleton"))
    assert(usage.some((r) => r.event === "tool_call" && r.tool === "find_and_anchor"))
    assert(usage.some((r) => r.event === "tool_call" && r.tool === "anchored_edit" && r.result.changed === true))
    assert(usage.every((r) => r.schema === "toolsmith.usage.v1"))
  } finally {
    await client.close()
  }
})

test("MCP verbose mode returns anchored text in content", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "demo.txt"), "alpha\nbeta", "utf8")

  const client = await McpTestClient.start(path.resolve("bin/toolsmith-mcp.js"), cwd, { TOOLSMITH_VERBOSE: "1" })
  try {
    const read = await client.callTool("anchored_read", { path: "demo.txt", sessionId: "verbose" })
    assert.match(read.content[0].text, /§alpha/)
    assert.match(read.structuredContent.text, /§alpha/)
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


test("WorkspaceTools editMany rejects duplicate file entries", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "same.txt"), "a\nb", "utf8")
  const tools = new WorkspaceTools({ cwd })
  const read = await tools.read({ path: "same.txt", sessionId: "dup" })
  const aLine = `${read.anchors[0]}§a`
  const bLine = `${read.anchors[1]}§b`

  const result = await tools.editMany({
    sessionId: "dup",
    files: [
      { path: "same.txt", edits: [{ type: "replace", anchor: aLine, endAnchor: aLine, text: "A" }] },
      { path: "./same.txt", edits: [{ type: "replace", anchor: bLine, endAnchor: bLine, text: "B" }] },
    ],
  })

  assert.equal(result.ok, false)
  assert.match(result.errors.join("\n"), /duplicate file entry/)
  assert.equal(await fs.readFile(path.join(cwd, "same.txt"), "utf8"), "a\nb")
})

test("WorkspaceTools findAndAnchor surfaces regex errors", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "demo.txt"), "aaaaaaaaaaaa", "utf8")
  const tools = new WorkspaceTools({ cwd })

  const result = await tools.findAndAnchor({ path: ".", query: "(a+)+$", regex: true })

  assert.match(result.error, /backtrack/)
  assert.match(result.text, /error:/)
})

test("WorkspaceTools findAndAnchor reports candidate truncation", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "one.txt"), "needle one", "utf8")
  await fs.writeFile(path.join(cwd, "two.txt"), "needle two", "utf8")
  const tools = new WorkspaceTools({ cwd })

  const result = await tools.findAndAnchor({ path: ".", query: "needle", maxFiles: 1 })

  assert.equal(result.truncated, true)
  assert.match(result.text, /Files scanned: 1\/1\+/)
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

test("WorkspaceTools read respects startLine and endLine", async () => {
  const cwd = await tempWorkspace()
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`).join("\n")
  await fs.writeFile(path.join(cwd, "big.txt"), lines, "utf8")
  const tools = new WorkspaceTools({ cwd })

  const partial = await tools.read({ path: "big.txt", sessionId: "partial", startLine: 5, endLine: 8 })

  assert.equal(partial.startLine, 5)
  assert.equal(partial.endLine, 8)
  assert.equal(partial.anchors.length, 4)
  assert.match(partial.text, /line 5/)
  assert.match(partial.text, /line 8/)
  assert(!partial.text.includes("line 4"), "should not include line before startLine")
  assert(!partial.text.includes("line 9"), "should not include line after endLine")
  assert(partial.telemetry.estimatedTokensAvoided > 0, "partial read should avoid tokens")
})

test("MCP anchored_edit_many applies cross-file batch", async () => {
  const cwd = await tempWorkspace()
  await fs.writeFile(path.join(cwd, "one.txt"), "a\nb", "utf8")
  await fs.writeFile(path.join(cwd, "two.txt"), "c\nd", "utf8")

  const client = await McpTestClient.start(path.resolve("bin/toolsmith-mcp.js"), cwd)
  try {
    const { tools } = await client.listTools()
    assert(tools.some((t) => t.name === "anchored_edit_many"))

    const oneRead = await client.callTool("anchored_read", { path: "one.txt", sessionId: "many-mcp" })
    const twoRead = await client.callTool("anchored_read", { path: "two.txt", sessionId: "many-mcp" })
    const aLine = oneRead.structuredContent.text.split("\n").find((line) => line.endsWith("§a"))
    const dLine = twoRead.structuredContent.text.split("\n").find((line) => line.endsWith("§d"))

    const result = await client.callTool("anchored_edit_many", {
      sessionId: "many-mcp",
      files: [
        { path: "one.txt", edits: [{ type: "replace", anchor: aLine, endAnchor: aLine, text: "A" }] },
        { path: "two.txt", edits: [{ type: "replace", anchor: dLine, endAnchor: dLine, text: "D" }] },
      ],
    })

    assert.equal(result.isError, false)
    assert.equal(await fs.readFile(path.join(cwd, "one.txt"), "utf8"), "A\nb")
    assert.equal(await fs.readFile(path.join(cwd, "two.txt"), "utf8"), "c\nD")
  } finally {
    await client.close()
  }
})
