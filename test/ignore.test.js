import assert from "node:assert/strict"
import test from "node:test"
import { compileIgnore } from "../src/ignore.js"

test("compileIgnore returns null for empty or comment-only content", () => {
  assert.equal(compileIgnore(""), null)
  assert.equal(compileIgnore("# just a comment\n\n   \n"), null)
})

test("unanchored glob matches the basename at any depth", () => {
  const ig = compileIgnore("*.log")
  assert.equal(ig.ignores("foo.log"), true)
  assert.equal(ig.ignores("a/b/c.log"), true)
  assert.equal(ig.ignores("foo.txt"), false)
})

test("bare directory name matches as a directory at any depth", () => {
  const ig = compileIgnore("node_modules/")
  assert.equal(ig.ignores("node_modules", true), true)
  assert.equal(ig.ignores("pkg/node_modules", true), true)
  assert.equal(ig.ignores("node_modules", false), false, "dir-only pattern must not match files")
})

test("leading slash anchors the pattern to the root", () => {
  const ig = compileIgnore("/dist")
  assert.equal(ig.ignores("dist", true), true)
  assert.equal(ig.ignores("src/dist", true), false)
})

test("negation re-includes a path excluded by an earlier rule (last match wins)", () => {
  const ig = compileIgnore("*.log\n!keep.log")
  assert.equal(ig.ignores("debug.log"), true)
  assert.equal(ig.ignores("keep.log"), false)
})

test("internal slash pattern anchors to root and matches subtrees", () => {
  const ig = compileIgnore("build/output")
  assert.equal(ig.ignores("build/output", true), true)
  assert.equal(ig.ignores("build/output/app.js"), true)
  assert.equal(ig.ignores("src/build/output"), false)
})
