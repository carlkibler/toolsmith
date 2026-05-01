import { splitLines } from "./anchors.js"
import { contentHash } from "./hash.js"
import { findSymbolRange } from "./structure.js"
import { checkRegexSafety } from "./regex-safety.js"

export function symbolReplace({ path, content, store, sessionId, name, search, replacement = "", regex = false, replaceAll = false, caseSensitive = true }) {
  if (!store) throw new Error("symbolReplace requires an AnchorStore")
  if (!name || typeof name !== "string") throw new Error("name is required")
  if (!search || typeof search !== "string") throw new Error("search is required")

  const lines = splitLines(content)
  const range = findSymbolRange(lines, name)
  if (!range) {
    return { ok: false, path, content, errors: [`symbol not found: ${name}`], matches: 0, changed: false, beforeHash: contentHash(content), afterHash: contentHash(content) }
  }

  const beforeSymbol = lines.slice(range.startIndex, range.endIndex + 1).join("\n")
  const { text: afterSymbol, matches, regexError } = replaceInText(beforeSymbol, { search, replacement, regex, replaceAll, caseSensitive })
  if (regexError) {
    return { ok: false, path, content, errors: [regexError], symbolStartLine: range.startIndex + 1, symbolEndLine: range.endIndex + 1, matches: 0, changed: false, beforeHash: contentHash(content), afterHash: contentHash(content) }
  }
  if (matches === 0) {
    return { ok: false, path, content, errors: [`search not found in symbol ${name}: ${search}`], symbolStartLine: range.startIndex + 1, symbolEndLine: range.endIndex + 1, matches: 0, changed: false, beforeHash: contentHash(content), afterHash: contentHash(content) }
  }

  const nextLines = [...lines]
  nextLines.splice(range.startIndex, range.endIndex - range.startIndex + 1, ...afterSymbol.split("\n"))
  const nextContent = nextLines.join("\n")
  const anchors = store.reconcile(path, nextContent, { sessionId })

  return {
    ok: true,
    path,
    content: nextContent,
    errors: [],
    name,
    search,
    replacement,
    regex,
    replaceAll,
    caseSensitive,
    matches,
    changed: nextContent !== content,
    symbolStartLine: range.startIndex + 1,
    symbolEndLine: range.endIndex + 1,
    beforeHash: contentHash(content),
    afterHash: contentHash(nextContent),
    anchors,
  }
}

function replaceInText(text, { search, replacement, regex, replaceAll, caseSensitive }) {
  if (regex) {
    if (search.length > 1024) return { text, matches: 0, regexError: "regex pattern too long (max 1024 chars)" }
    const flags = `${replaceAll ? "g" : ""}${caseSensitive ? "" : "i"}`
    let pattern
    try {
      pattern = new RegExp(search, flags)
    } catch (e) {
      return { text, matches: 0, regexError: `invalid regex: ${e.message}` }
    }
    try {
      checkRegexSafety(search, flags)
    } catch (e) {
      return { text, matches: 0, regexError: e.message }
    }
    let matches = 0
    const replaced = text.replace(pattern, (...args) => {
      matches += 1
      return typeof replacement === "function" ? replacement(...args) : replacement
    })
    return { text: replaced, matches }
  }

  if (caseSensitive) {
    if (replaceAll) {
      const parts = text.split(search)
      return { text: parts.join(replacement), matches: parts.length - 1 }
    }
    const index = text.indexOf(search)
    if (index === -1) return { text, matches: 0 }
    return { text: `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`, matches: 1 }
  }

  const haystack = text.toLowerCase()
  const needle = search.toLowerCase()
  let index = haystack.indexOf(needle)
  if (index === -1) return { text, matches: 0 }
  let cursor = 0
  let matches = 0
  let output = ""
  while (index !== -1) {
    output += text.slice(cursor, index) + replacement
    cursor = index + search.length
    matches += 1
    if (!replaceAll) break
    index = haystack.indexOf(needle, cursor)
  }
  output += text.slice(cursor)
  return { text: output, matches }
}
