import assert from "node:assert/strict"
import test from "node:test"
import { AnchorStore } from "../src/anchors.js"
import { readAnchored } from "../src/read.js"
import { findAndAnchor } from "../src/find-anchor.js"
import { estimateTokens } from "../src/telemetry.js"

// In-memory filesystem keyed by POSIX-style relative path under "/root".
function fakeFs(files) {
  const ROOT = "/root"
  const rel = (abs) => (abs === ROOT ? "" : abs.slice(ROOT.length + 1))
  const dirEntry = (name, isDir) => ({ name, isDirectory: () => isDir, isFile: () => !isDir })
  return {
    rootAbsolute: ROOT,
    statPath: async (abs) => {
      const r = rel(abs)
      if (r in files) return { isDirectory: () => false, isFile: () => true, size: Buffer.byteLength(files[r]) }
      return { isDirectory: () => true, isFile: () => false, size: 0 }
    },
    listDir: async (abs) => {
      const r = rel(abs)
      const prefix = r === "" ? "" : `${r}/`
      const names = new Map()
      for (const f of Object.keys(files)) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        const slash = rest.indexOf("/")
        if (slash === -1) names.set(rest, false)
        else names.set(rest.slice(0, slash), true)
      }
      return [...names].map(([name, isDir]) => dirEntry(name, isDir))
    },
    readFile: async (abs) => {
      const r = rel(abs)
      if (r in files) return files[r]
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    },
  }
}

test("creditRead: first read saves, re-reads net the cost back out", () => {
  const store = new AnchorStore()
  const base = { sessionId: "s", workspaceKey: "w", hash: "h", baselineTokens: 1000 }
  const first = store.creditRead("f.js", { ...base, responseTokens: 200 })
  assert.equal(first.incrementalAvoided, 800, "first read avoids whole-file minus its chunk")
  assert.equal(first.cumulativeAvoided, 800)

  const second = store.creditRead("f.js", { ...base, responseTokens: 200 })
  assert.equal(second.incrementalAvoided, -200, "re-reading the same file costs, it does not save")
  assert.equal(second.cumulativeAvoided, 600)

  // The whole point: per-call increments telescope to the cumulative — no double count.
  assert.equal(first.incrementalAvoided + second.incrementalAvoided, second.cumulativeAvoided)
})

test("creditRead: cumulative can never exceed reading the file once", () => {
  const store = new AnchorStore()
  const base = { sessionId: "s", hash: "h", baselineTokens: 500 }
  let sum = 0
  for (let i = 0; i < 6; i += 1) sum += store.creditRead("f.js", { ...base, responseTokens: 200 }).incrementalAvoided
  // Spent 1200 tokens reading a 500-token file in pieces → net savings floors at 0.
  assert.equal(sum, 0, "fragmented re-reads cannot manufacture savings")
  assert.equal(store.creditRead("f.js", { ...base, responseTokens: 1 }).cumulativeAvoided, 0)
})

test("creditRead: a changed file resets the baseline", () => {
  const store = new AnchorStore()
  store.creditRead("f.js", { sessionId: "s", hash: "h1", baselineTokens: 1000, responseTokens: 900 })
  const afterEdit = store.creditRead("f.js", { sessionId: "s", hash: "h2", baselineTokens: 1000, responseTokens: 200 })
  assert.equal(afterEdit.incrementalAvoided, 800, "new content is a fresh whole-file baseline")
})

test("readAnchored: chunked reads of one file do not multiply the savings", () => {
  const store = new AnchorStore()
  const content = Array.from({ length: 300 }, (_, i) => `const line${i} = ${i} // padding to give the line some token weight`).join("\n")
  const baseline = estimateTokens(content)

  let sum = 0
  let firstAvoided = null
  for (const [startLine, endLine] of [[1, 100], [101, 200], [201, 300]]) {
    const r = readAnchored({ path: "f.js", content, store, sessionId: "s", startLine, endLine })
    if (firstAvoided === null) firstAvoided = r.telemetry.estimatedTokensAvoided
    sum += r.telemetry.estimatedTokensAvoided
  }

  assert.ok(firstAvoided > 0, "first partial read still reports real savings")
  assert.ok(sum >= 0, "summed savings telescope to a non-negative cumulative")
  assert.ok(sum <= baseline, `summed avoided ${sum} must not exceed one whole-file read (${baseline})`)
})

test("findAndAnchor: a 0-match scan claims zero savings (was ~200K)", async () => {
  const fs = fakeFs({
    "a.js": "function alpha() {}\n",
    "b.js": "function beta() {}\n",
    "c.js": "const gamma = 1\n",
  })
  const result = await findAndAnchor({
    rootAbsolute: fs.rootAbsolute, rootRelative: ".",
    readFile: fs.readFile, statPath: fs.statPath, listDir: fs.listDir,
    store: new AnchorStore(), query: "no_such_symbol_xyz",
  })
  assert.equal(result.matchedFiles, 0)
  assert.equal(result.telemetry.estimatedTokensAvoided, 0, "scanning files with no hit avoids nothing — grep is the real alternative")
})

test("findAndAnchor: savings baseline is matched files, not the scanned corpus", async () => {
  const matchContent = Array.from({ length: 200 }, (_, i) => (i === 100 ? "function authenticate() { return 1 }" : `const x${i} = ${i}`)).join("\n") + "\n"
  const bigContent = Array.from({ length: 200 }, (_, i) => `const y${i} = ${i} // no hits here at all whatsoever`).join("\n") + "\n"
  const fs = fakeFs({ "match.js": matchContent, "big1.js": bigContent, "big2.js": bigContent })

  const result = await findAndAnchor({
    rootAbsolute: fs.rootAbsolute, rootRelative: ".",
    readFile: fs.readFile, statPath: fs.statPath, listDir: fs.listDir,
    store: new AnchorStore(), query: "authenticate",
  })

  const matchedTokens = estimateTokens(matchContent)
  assert.equal(result.matchedFiles, 1)
  assert.ok(result.telemetry.estimatedTokensAvoided > 0, "a real hit in a sizable file does save")
  assert.ok(result.telemetry.estimatedTokensAvoided <= matchedTokens, "savings bounded by the matched file, not the corpus it walked")
})
