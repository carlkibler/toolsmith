import assert from "node:assert/strict"
import test from "node:test"
import { ANCHOR_DELIMITER, AnchorStore, fileSkeleton, getFunction } from "../src/index.js"

const content = `import fs from "node:fs"

function alpha() {
  return 1
}

const beta = (value) => {
  return value + 1
}

class Gamma {
  method() {
    return beta(1)
  }
}
`

test("fileSkeleton returns anchored declaration outline", () => {
  const store = new AnchorStore()
  const result = fileSkeleton({ path: "demo.js", content, store, sessionId: "struct" })

  assert.match(result.text, /Skeleton Lines: 4/)
  assert(result.entries.some((entry) => entry.text === "function alpha() {" && entry.kind === "function"))
  assert(result.entries.some((entry) => entry.text === "class Gamma {" && entry.kind === "class"))
  assert.match(result.text, new RegExp(`${result.entries[0].anchor}${ANCHOR_DELIMITER}`))
})

test("getFunction returns anchored range for named JavaScript symbol", () => {
  const store = new AnchorStore()
  const result = getFunction({ path: "demo.js", content, store, sessionId: "struct", name: "beta" })

  assert.equal(result.found, true)
  assert.equal(result.symbolStartLine, 7)
  assert.equal(result.symbolEndLine, 9)
  assert.match(result.text, /§const beta = \(value\) => \{/)
  assert.match(result.text, /§  return value \+ 1/)
})

test("getFunction returns not found without throwing", () => {
  const store = new AnchorStore()
  const result = getFunction({ path: "demo.js", content, store, sessionId: "struct", name: "missing" })

  assert.equal(result.found, false)
  assert.match(result.text, /symbol not found: missing/)
})
