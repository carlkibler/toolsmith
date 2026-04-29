import assert from "node:assert/strict"
import test from "node:test"
import { AnchorStore, symbolReplace } from "../src/index.js"

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
