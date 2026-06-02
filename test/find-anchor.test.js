import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { findAndAnchor } from "../src/find-anchor.js"
import { AnchorStore } from "../src/anchors.js"

// In-memory filesystem keyed by POSIX-style relative path under "/root".
function fakeFs(files) {
  const ROOT = "/root"
  const rel = (abs) => (abs === ROOT ? "" : abs.slice(ROOT.length + 1))
  const dirEntry = (name, isDir) => ({ name, isDirectory: () => isDir, isFile: () => !isDir })
  return {
    rootAbsolute: ROOT,
    statPath: async (abs) => {
      const r = rel(abs)
      const isDir = r === "" || Object.keys(files).some((f) => f === r ? false : f.startsWith(`${r}/`)) && !(r in files)
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

test("findAndAnchor ranks higher-relevance files first via BM25", async () => {
  const fs = fakeFs({
    "a_first.js": "// authenticate mentioned once in a comment\nfunction noop() {}\n",
    "z_best.js": "function authenticate(u) {\n  return authenticate(u) || authenticate(null)\n}\n",
  })
  const result = await findAndAnchor({
    rootAbsolute: fs.rootAbsolute,
    rootRelative: ".",
    readFile: fs.readFile,
    statPath: fs.statPath,
    listDir: fs.listDir,
    store: new AnchorStore(),
    query: "authenticate",
  })
  assert.equal(result.matchedFiles, 2)
  assert.equal(result.matches[0].path, "z_best.js", "densest match should be ranked first")
})

test("findAndAnchor honors .toolsmithignore patterns", async () => {
  const fs = fakeFs({
    ".toolsmithignore": "vendor/\n",
    "src/auth.js": "function authenticate() {}\n",
    "vendor/lib.js": "function authenticate() {}\n",
  })
  const result = await findAndAnchor({
    rootAbsolute: fs.rootAbsolute,
    rootRelative: ".",
    readFile: fs.readFile,
    statPath: fs.statPath,
    listDir: fs.listDir,
    store: new AnchorStore(),
    query: "authenticate",
  })
  const matchedPaths = result.matches.map((m) => m.path)
  assert.ok(matchedPaths.includes("src/auth.js"))
  assert.ok(!matchedPaths.some((p) => p.startsWith("vendor")), "vendor/ must be excluded")
})
