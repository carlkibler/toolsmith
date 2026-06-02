import assert from "node:assert/strict"
import test from "node:test"
import { tokenize, scoreDocuments } from "../src/bm25.js"

test("tokenize splits camelCase, snake_case, and punctuation into lowercase subtokens", () => {
  assert.deepEqual(tokenize("getUserName"), ["get", "user", "name"])
  assert.deepEqual(tokenize("save_pretrained"), ["save", "pretrained"])
  assert.deepEqual(tokenize("user.profile()"), ["user", "profile"])
  assert.deepEqual(tokenize("HTTPServer"), ["http", "server"])
})

test("tokenize drops single-character noise tokens", () => {
  assert.deepEqual(tokenize("a x token"), ["token"])
})

test("scoreDocuments ranks the document with more query-term occurrences higher", () => {
  const docs = [
    "nothing relevant here at all",
    "authenticate the user then authenticate again authenticate",
  ]
  const scores = scoreDocuments(tokenize("authenticate"), docs)
  assert.equal(scores.length, 2)
  assert.ok(scores[1] > scores[0])
})

test("scoreDocuments rewards documents matching more distinct query terms (BM25 + IDF)", () => {
  const docs = [
    "save save save save save",   // spams one common term only
    "save the model from disk",   // covers all three distinct query terms
  ]
  const scores = scoreDocuments(tokenize("save model disk"), docs)
  assert.ok(scores[1] > scores[0], "doc covering more distinct query terms should win")
})

test("scoreDocuments returns all zeros when no query terms survive", () => {
  const docs = ["anything", "else"]
  const scores = scoreDocuments(tokenize("a"), docs)
  assert.deepEqual(scores, [0, 0])
})

test("scoreDocuments handles empty document set", () => {
  assert.deepEqual(scoreDocuments(tokenize("query"), []), [])
})
