import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ANCHOR_DELIMITER, AnchorStore, applyAnchoredEdits, detectEol, readAnchored, symbolReplace } from "../src/index.js"
import { WorkspaceTools } from "../src/fs-tools.js"

function ref(read, index, content) {
  return `${read.anchors[index]}${ANCHOR_DELIMITER}${content}`
}

test("detectEol picks the dominant line ending", () => {
  assert.equal(detectEol("a\r\nb\r\nc"), "\r\n")
  assert.equal(detectEol("a\nb\nc"), "\n")
  assert.equal(detectEol(""), "\n")
  assert.equal(detectEol("single line"), "\n")
  // mixed but CRLF-dominant
  assert.equal(detectEol("a\r\nb\r\nc\nd"), "\r\n")
})

test("applyAnchoredEdits preserves CRLF line endings", () => {
  const store = new AnchorStore()
  const content = "const a = 1\r\nconst b = 2\r\nconst c = 3\r\n"
  const read = readAnchored({ path: "a.js", content, store, sessionId: "s" })
  const result = applyAnchoredEdits({
    path: "a.js", content, store, sessionId: "s",
    edits: [{ type: "replace", anchor: ref(read, 1, "const b = 2"), endAnchor: ref(read, 1, "const b = 2"), text: "const b = 20" }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.content, "const a = 1\r\nconst b = 20\r\nconst c = 3\r\n")
})

test("applyAnchoredEdits keeps LF files on LF (no regression)", () => {
  const store = new AnchorStore()
  const content = "a\nb\nc"
  const read = readAnchored({ path: "a.txt", content, store, sessionId: "s" })
  const result = applyAnchoredEdits({
    path: "a.txt", content, store, sessionId: "s",
    edits: [{ type: "replace", anchor: ref(read, 0, "a"), endAnchor: ref(read, 0, "a"), text: "A" }],
  })
  assert.equal(result.content, "A\nb\nc")
})

test("applyAnchoredEdits with multiline CRLF replacement text uses the file's EOL", () => {
  const store = new AnchorStore()
  const content = "x\r\ny\r\nz\r\n"
  const read = readAnchored({ path: "a.txt", content, store, sessionId: "s" })
  // replacement text arrives with LF but must be rewritten with the file's CRLF
  const result = applyAnchoredEdits({
    path: "a.txt", content, store, sessionId: "s",
    edits: [{ type: "replace", anchor: ref(read, 1, "y"), endAnchor: ref(read, 1, "y"), text: "y1\ny2" }],
  })
  assert.equal(result.content, "x\r\ny1\r\ny2\r\nz\r\n")
})

test("symbolReplace preserves CRLF line endings", () => {
  const store = new AnchorStore()
  const content = "function foo() {\r\n  return 1\r\n}\r\n"
  const result = symbolReplace({ path: "a.js", content, store, sessionId: "s", name: "foo", search: "return 1", replacement: "return 2" })
  assert.equal(result.ok, true)
  assert.equal(result.content, "function foo() {\r\n  return 2\r\n}\r\n")
})

test("WorkspaceTools.edit preserves CRLF on disk", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-eol-"))
  try {
    const file = path.join(dir, "f.txt")
    await fs.writeFile(file, "one\r\ntwo\r\nthree\r\n")
    const tools = new WorkspaceTools({ cwd: dir })
    const read = await tools.read({ path: "f.txt", sessionId: "s" })
    await tools.edit({
      path: "f.txt", sessionId: "s",
      edits: [{ type: "replace", anchor: ref(read, 1, "two"), endAnchor: ref(read, 1, "two"), text: "TWO" }],
    })
    const after = await fs.readFile(file, "utf8")
    assert.equal(after, "one\r\nTWO\r\nthree\r\n")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("editMany is atomic across files: a write failure commits nothing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-atomic-"))
  const dirB = path.join(root, "b")
  try {
    const dirA = path.join(root, "a")
    await fs.mkdir(dirA)
    await fs.mkdir(dirB)
    const fileA = path.join(dirA, "a.txt")
    const fileB = path.join(dirB, "b.txt")
    await fs.writeFile(fileA, "a1\na2\n")
    await fs.writeFile(fileB, "b1\nb2\n")
    const tools = new WorkspaceTools({ cwd: root })
    const readA = await tools.read({ path: "a/a.txt", sessionId: "s" })
    const readB = await tools.read({ path: "b/b.txt", sessionId: "s" })
    // Make dirB unwritable so staging B's temp file fails after A is already staged.
    await fs.chmod(dirB, 0o500)
    await assert.rejects(tools.editMany({
      sessionId: "s",
      files: [
        { path: "a/a.txt", edits: [{ type: "replace", anchor: ref(readA, 0, "a1"), endAnchor: ref(readA, 0, "a1"), text: "A1" }] },
        { path: "b/b.txt", edits: [{ type: "replace", anchor: ref(readB, 0, "b1"), endAnchor: ref(readB, 0, "b1"), text: "B1" }] },
      ],
    }))
    await fs.chmod(dirB, 0o700)
    // A must be untouched: the batch aborted before committing any rename.
    assert.equal(await fs.readFile(fileA, "utf8"), "a1\na2\n")
    // No stray temp files left behind in A's directory.
    const leftovers = (await fs.readdir(dirA)).filter((n) => n.includes(".toolsmith-"))
    assert.deepEqual(leftovers, [])
  } finally {
    await fs.chmod(dirB, 0o700).catch(() => {})
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("read refuses a file with a NUL byte beyond the first 8KB", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-bin-"))
  try {
    const file = path.join(dir, "big.txt")
    const buf = Buffer.concat([Buffer.from("a".repeat(9000)), Buffer.from([0]), Buffer.from("b".repeat(10))])
    await fs.writeFile(file, buf)
    const tools = new WorkspaceTools({ cwd: dir })
    await assert.rejects(tools.read({ path: "big.txt", sessionId: "s" }), /binary/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
