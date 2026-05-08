import assert from "node:assert/strict"
import test from "node:test"
import { ANCHOR_DELIMITER, AnchorStore, applyAnchoredEdits, readAnchored, searchAnchored, stripAnchors } from "../src/index.js"

function anchoredLine(read, index, content) {
  return `${read.anchors[index]}${ANCHOR_DELIMITER}${content}`
}

test("readAnchored returns file hash and anchored lines", () => {
  const store = new AnchorStore()
  const read = readAnchored({ path: "a.js", content: "one\ntwo", store, sessionId: "s" })
  assert.match(read.text, /^\[File Hash: [a-f0-9]{8}\]/)
  assert.equal(read.anchors.length, 2)
  assert.match(read.text, new RegExp(`${read.anchors[0]}${ANCHOR_DELIMITER}one`))
  assert.equal(read.telemetry.operation, "anchored_read")
  assert.equal(read.telemetry.anchorCount, 2)
})

test("applyAnchoredEdits replaces exact anchored range", () => {
  const store = new AnchorStore()
  const content = "const a = 1\nconst b = 2\nconst c = 3"
  const read = readAnchored({ path: "a.js", content, store, sessionId: "s" })

  const result = applyAnchoredEdits({
    path: "a.js",
    content,
    store,
    sessionId: "s",
    edits: [{
      type: "replace",
      anchor: anchoredLine(read, 1, "const b = 2"),
      endAnchor: anchoredLine(read, 1, "const b = 2"),
      text: "const b = 20",
    }],
  })

  assert.equal(result.ok, true)
  assert.equal(result.content, "const a = 1\nconst b = 20\nconst c = 3")
  assert.equal(result.applied[0].linesDeleted, 1)
  assert.equal(result.applied[0].linesAdded, 1)
})

test("batch applies non-overlapping edits atomically", () => {
  const store = new AnchorStore()
  const content = "a\nb\nc\nd"
  const read = readAnchored({ path: "a.txt", content, store, sessionId: "s" })

  const result = applyAnchoredEdits({
    path: "a.txt",
    content,
    store,
    sessionId: "s",
    edits: [
      { type: "replace", anchor: anchoredLine(read, 0, "a"), endAnchor: anchoredLine(read, 0, "a"), text: "A" },
      { type: "insert_after", anchor: anchoredLine(read, 2, "c"), text: "c2" },
    ],
  })

  assert.equal(result.ok, true)
  assert.equal(result.content, "A\nb\nc\nc2\nd")
})

test("stale or inexact line content aborts atomic batch", () => {
  const store = new AnchorStore()
  const content = "a\nb\nc"
  const read = readAnchored({ path: "a.txt", content, store, sessionId: "s" })

  const result = applyAnchoredEdits({
    path: "a.txt",
    content: "a\nB\nc",
    store,
    sessionId: "s",
    edits: [
      { type: "replace", anchor: anchoredLine(read, 1, "b"), endAnchor: anchoredLine(read, 1, "b"), text: "bb" },
    ],
  })

  assert.equal(result.ok, false)
  assert.equal(result.content, "a\nB\nc")
  assert.match(result.errors[0], /content mismatch|not found/)
})

test("anchors survive insertion before unchanged lines", () => {
  const store = new AnchorStore()
  const content = "alpha\nbeta\ngamma"
  const read = readAnchored({ path: "a.txt", content, store, sessionId: "s" })
  const betaAnchor = read.anchors[1]

  const result = applyAnchoredEdits({
    path: "a.txt",
    content,
    store,
    sessionId: "s",
    edits: [{ type: "insert_before", anchor: anchoredLine(read, 0, "alpha"), text: "zero" }],
  })

  assert.equal(result.ok, true)
  const reread = readAnchored({ path: "a.txt", content: result.content, store, sessionId: "s" })
  assert.equal(reread.anchors[2], betaAnchor)
})

test("overlapping replacements abort", () => {
  const store = new AnchorStore()
  const content = "a\nb\nc"
  const read = readAnchored({ path: "a.txt", content, store, sessionId: "s" })

  const result = applyAnchoredEdits({
    path: "a.txt",
    content,
    store,
    sessionId: "s",
    edits: [
      { type: "replace", anchor: anchoredLine(read, 0, "a"), endAnchor: anchoredLine(read, 1, "b"), text: "ab" },
      { type: "replace", anchor: anchoredLine(read, 1, "b"), endAnchor: anchoredLine(read, 2, "c"), text: "bc" },
    ],
  })

  assert.equal(result.ok, false)
  assert.match(result.errors.at(-1), /overlap/)
})

test("stripAnchors removes generated anchors from replacement text", () => {
  assert.equal(stripAnchors("Aabc123§hello\nworld"), "hello\nworld")
})


test("searchAnchored returns compact anchored snippets", () => {
  const store = new AnchorStore()
  const content = "alpha\nbeta target\ngamma\ntarget delta"

  const result = searchAnchored({ path: "a.txt", content, store, sessionId: "s", query: "target", contextLines: 0 })

  assert.equal(result.matches.length, 2)
  assert.match(result.text, /\[Matches: 2\]/)
  assert.match(result.text, new RegExp(`${result.matches[0].anchor}${ANCHOR_DELIMITER}beta target`))
  assert.equal(result.matches[0].line, 2)
  assert.equal(result.telemetry.operation, "anchored_search")
  assert(result.telemetry.estimatedTokensAvoided >= 0)
})

test("edit validation suggests exact full anchor reference", () => {
  const store = new AnchorStore()
  const content = "one\ntwo"
  const read = readAnchored({ path: "a.txt", content, store, sessionId: "s" })

  const result = applyAnchoredEdits({
    path: "a.txt",
    content,
    store,
    sessionId: "s",
    edits: [{ type: "replace", anchor: read.anchors[1], endAnchor: read.anchors[1], text: "TWO" }],
  })

  assert.equal(result.ok, false)
  assert.match(result.errors[0], new RegExp(`${read.anchors[1]}${ANCHOR_DELIMITER}two`))
})

test("anchored_read telemetry reports tokens avoided on partial read", () => {
  const store = new AnchorStore()
  // 100 long lines so a 3-line slice is clearly smaller than the full file
  const content = Array.from({ length: 100 }, (_, i) =>
    `const someVeryLongVariableName${i} = ${i} * 100 + Math.floor(Math.random() * 1000) + "extra padding text here"`,
  ).join("\n")
  const partial = readAnchored({ path: "a.txt", content, store, sessionId: "s", startLine: 10, endLine: 12 })

  assert.equal(partial.telemetry.operation, "anchored_read")
  assert(partial.telemetry.estimatedTokensAvoided > 0, "partial read should report tokens avoided")
  assert(partial.telemetry.responseBytes < partial.telemetry.fullBytes, "partial response smaller than full file")
  assert.equal(partial.anchors.length, 3)
  assert.equal(partial.startLine, 10)
  assert.equal(partial.endLine, 12)
})

test("different sessionIds have isolated anchor stores after edits", () => {
  const store = new AnchorStore()
  const original = "alpha\nbeta\ngamma"

  const s1 = readAnchored({ path: "f.txt", content: original, store, sessionId: "s1" })
  readAnchored({ path: "f.txt", content: original, store, sessionId: "s2" })

  const betaAnchor = s1.anchors[1]

  // s1 edits beta → BETA, updating s1's store to track the new content
  applyAnchoredEdits({
    path: "f.txt",
    content: original,
    store,
    sessionId: "s1",
    edits: [{ type: "replace", anchor: `${betaAnchor}§beta`, endAnchor: `${betaAnchor}§beta`, text: "BETA" }],
  })

  const s1State = store.get("f.txt", { sessionId: "s1" })
  const s2State = store.get("f.txt", { sessionId: "s2" })

  // s1's store reflects the edit: beta anchor is gone, replaced by a new anchor for BETA
  assert(!s1State.anchors.includes(betaAnchor), "s1 store should no longer track the old beta anchor")
  // s2's store is unaffected: still tracks original content with beta anchor intact
  assert(s2State.anchors.includes(betaAnchor), "s2 store is isolated from s1's edit")
})

test("searchAnchored telemetry shows tokens avoided vs full file", () => {
  const store = new AnchorStore()
  const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n")
  const result = searchAnchored({ path: "big.txt", content, store, sessionId: "s", query: "line 25", contextLines: 0 })

  assert(result.telemetry.estimatedTokensAvoided > 0, "search result is much smaller than the full file")
  assert.equal(result.matches.length, 1)
})

test("searchAnchored returns error for catastrophically backtracking regex", { timeout: 1000 }, () => {
  const store = new AnchorStore()
  const content = "aaaaaaaaaaaa"
  const result = searchAnchored({ path: "test.txt", content, store, sessionId: "s", query: "(a+)+$", regex: true })
  assert.ok(result.error)
  assert.match(result.error, /backtrack/)
})

test("applyAnchoredEdits content-mismatch error includes human hint", () => {
  const store = new AnchorStore()
  const content = "const a = 1\nconst b = 2\nconst c = 3"
  const read = readAnchored({ path: "a.js", content, store, sessionId: "s" })
  // Use an anchor from the read but pass wrong line content to trigger content-mismatch
  const anchor = read.anchors[1]
  const result = applyAnchoredEdits({
    path: "a.js",
    content,
    store,
    sessionId: "s",
    edits: [{ type: "replace", anchor: `${anchor}§wrong content here`, endAnchor: `${anchor}§wrong content here`, text: "x" }],
  })
  assert.equal(result.ok, false)
  const errMsg = result.errors.join("\n")
  assert.match(errMsg, /content mismatch/)
  assert.match(errMsg, /Hint: this protects against silent overwrites/)
})

test("applyAnchoredEdits content-mismatch hint suppressed under TOOLSMITH_TERSE=1", () => {
  const store = new AnchorStore()
  const content = "line1\nline2"
  const read = readAnchored({ path: "x.js", content, store, sessionId: "s" })
  const anchor = read.anchors[0]
  const orig = process.env.TOOLSMITH_TERSE
  process.env.TOOLSMITH_TERSE = "1"
  try {
    const result = applyAnchoredEdits({
      path: "x.js",
      content,
      store,
      sessionId: "s",
      edits: [{ type: "replace", anchor: `${anchor}§stale`, endAnchor: `${anchor}§stale`, text: "y" }],
    })
    assert.equal(result.ok, false)
    const errMsg = result.errors.join("\n")
    assert.doesNotMatch(errMsg, /Hint:/)
  } finally {
    if (orig === undefined) delete process.env.TOOLSMITH_TERSE
    else process.env.TOOLSMITH_TERSE = orig
  }
})
