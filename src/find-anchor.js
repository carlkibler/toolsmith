import path from "node:path"
import { contentHash } from "./hash.js"
import { searchAnchored } from "./search.js"
import { estimateTokens } from "./telemetry.js"
import { tokenize, scoreDocuments } from "./bm25.js"
import { compileIgnore } from "./ignore.js"

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".beads", ".dolt", "coverage"])
const BINARY_EXT_RE = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|bz2|xz|7z|dmg|sqlite|db|mp4|mov|mp3|wav|woff2?|ttf|otf)$/i
const IGNORE_FILE = ".toolsmithignore"

export async function findAndAnchor({
  rootAbsolute,
  rootRelative,
  readFile,
  statPath,
  listDir,
  store,
  sessionId = "default",
  workspaceKey,
  query,
  regex = false,
  caseSensitive = false,
  contextLines = 2,
  maxMatches = 20,
  maxFiles = 80,
  maxMatchesPerFile = 5,
  glob,
}) {
  if (!query || typeof query !== "string") throw new Error("query is required")
  const stats = await statPath(rootAbsolute)
  const isDirectory = stats.isDirectory()
  const parsedPerFileLimit = Number(maxMatchesPerFile)
  const perFileLimit = Number.isFinite(parsedPerFileLimit) && parsedPerFileLimit > 0 ? parsedPerFileLimit : Math.max(1, Number(maxMatches) || 20)
  const collection = isDirectory
    ? await collectFiles({ rootAbsolute, rootRelative, readFile, listDir, statPath, glob, maxFiles })
    : { files: [{ absolute: rootAbsolute, relative: rootRelative }], truncatedCandidates: false }
  const files = isDirectory ? await rankFiles({ files: collection.files, readFile, query, regex }) : collection.files

  const matches = []
  const sections = []
  let scannedFiles = 0
  let scannedBytes = 0
  let matchedBytes = 0
  let truncated = collection.truncatedCandidates
  let searchError = null

  for (const file of files) {
    if (matches.length >= maxMatches) { truncated = true; break }
    let content = file.content
    try {
      if (content === undefined) content = await readFile(file.absolute)
    } catch (error) {
      if (!isDirectory) {
        searchError = `${file.relative}: ${error instanceof Error ? error.message : String(error)}`
        truncated = true
        break
      }
      continue
    }
    scannedFiles += 1
    scannedBytes += Buffer.byteLength(content, "utf8")
    const result = searchAnchored({
      path: file.relative,
      content,
      store,
      sessionId,
      workspaceKey,
      query,
      regex,
      caseSensitive,
      contextLines,
      maxMatches: isDirectory ? Math.min(maxMatches - matches.length, perFileLimit) : maxMatches - matches.length,
      credit: false,
    })
    if (result.error) {
      searchError = `${file.relative}: ${result.error}`
      truncated = true
      break
    }
    if (result.truncated) truncated = true
    if (result.matches.length === 0) continue
    matchedBytes += Buffer.byteLength(content, "utf8")
    sections.push(result.text)
    for (const match of result.matches) matches.push({ ...match, path: file.relative, fileHash: contentHash(content) })
  }

  const responseBody = sections.length ? sections.join("\n\n") : "(no matches)"
  const workspaceTag = workspaceKey ? `[Workspace: ${workspaceKey}] ` : ""
  const errorNote = searchError ? ` [Error: ${searchError}]` : ""
  const candidateNote = collection.truncatedCandidates ? ` [Candidate files: ${files.length}+ truncated at maxFiles=${maxFiles}]` : ` [Candidate files: ${files.length}]`
  const text = `${workspaceTag}[Find: ${query}] [Files scanned: ${scannedFiles}]${candidateNote} [Files matched: ${sections.length}] [Matches: ${matches.length}${truncated ? "+" : ""}]${errorNote}\n${searchError ? `(error: ${searchError})` : responseBody}`
  return {
    path: rootRelative,
    query,
    regex,
    caseSensitive,
    contextLines,
    maxMatches,
    maxFiles,
    maxMatchesPerFile: perFileLimit,
    glob,
    scannedFiles,
    candidateFiles: files.length,
    candidateCollectionTruncated: collection.truncatedCandidates,
    matchedFiles: sections.length,
    matches,
    truncated,
    error: searchError,
    text,
    telemetry: telemetry({ operation: "find_and_anchor", scannedBytes, matchedBytes, requestPayload: { path: rootRelative, query, regex, caseSensitive, contextLines, maxMatches, maxFiles, maxMatchesPerFile: perFileLimit, glob, sessionId }, responseText: text, anchorCount: matches.length }),
  }
}

// Rank candidate files by BM25 relevance to the query so the match budget is
// spent on the most relevant files first. Preloads content (bounded by maxFiles
// and the 512KB per-file cap in collectFiles) and attaches it so the main loop
// does not re-read. Falls back to walk order when no query terms survive or
// reads fail.
async function rankFiles({ files, readFile, query, regex }) {
  if (files.length < 2) return files
  const terms = tokenize(regex ? String(query).replace(/\\[a-zA-Z]/gu, " ") : query)
  if (terms.length === 0) return files
  const docs = await Promise.all(files.map(async (file) => {
    try {
      const content = await readFile(file.absolute)
      file.content = content
      return content
    } catch {
      return ""
    }
  }))
  const scores = scoreDocuments(terms, docs)
  return files
    .map((file, index) => ({ file, index, score: scores[index] }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.file)
}

async function collectFiles({ rootAbsolute, rootRelative, readFile, listDir, statPath, glob, maxFiles }) {
  const files = []
  const matcher = glob ? globMatcher(glob) : null
  const ignore = await loadIgnore(rootAbsolute, readFile)
  let truncatedCandidates = false

  async function walk(abs, rel) {
    if (files.length >= maxFiles) { truncatedCandidates = true; return }
    const entries = await listDir(abs)
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncatedCandidates = true; return }
      const childRel = rel ? path.join(rel, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (ignore && ignore.ignores(childRel, true)) continue
        await walk(path.join(abs, entry.name), childRel)
      } else if (entry.isFile()) {
        const displayRel = rootRelative === "." ? childRel : path.join(rootRelative, childRel)
        if (BINARY_EXT_RE.test(entry.name)) continue
        if (ignore && ignore.ignores(childRel, false)) continue
        if (matcher && !matcher(displayRel) && !matcher(childRel) && !matcher(entry.name)) continue
        const absolute = path.join(abs, entry.name)
        const st = await statPath(absolute)
        if (st.size > 512 * 1024) continue
        files.push({ absolute, relative: displayRel })
      }
    }
  }

  await walk(rootAbsolute, rootRelative === "." ? "" : "")
  return { files, truncatedCandidates }
}

async function loadIgnore(rootAbsolute, readFile) {
  try {
    return compileIgnore(await readFile(path.join(rootAbsolute, IGNORE_FILE)))
  } catch {
    return null
  }
}

function globMatcher(glob) {
  const pattern = String(glob).split(/[,\s]+/u).filter(Boolean).map((item) => globToRegExp(item))
  return (value) => pattern.some((regex) => regex.test(value))
}

function globToRegExp(glob) {
  let out = ""
  for (let i = 0; i < glob.length; i += 1) {
    if (glob.slice(i, i + 3) === "**/") {
      out += "(?:.*/)?"
      i += 2
      continue
    }
    const char = glob[i]
    if (char === "*") {
      if (glob[i + 1] === "*") { out += ".*"; i += 1 } else out += "[^/]*"
    } else if (char === "?") {
      out += "[^/]"
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${out}$`)
}

// Savings baseline is matchedBytes (the files that actually contained a hit), NOT
// scannedBytes (the whole walked corpus). The realistic alternative to find_and_anchor
// is grep — you would never read all 80 scanned files. Crediting the corpus produced
// absurd "saved ~200K tokens" on 0-match scans. matchedBytes credits only "you would
// have opened the files that matched", and a 0-match search avoids nothing.
function telemetry({ operation, scannedBytes, matchedBytes = 0, requestPayload, responseText, anchorCount }) {
  const requestBytes = Buffer.byteLength(JSON.stringify(requestPayload || {}), "utf8")
  const responseBytes = Buffer.byteLength(String(responseText || ""), "utf8")
  const baselineTokens = Math.ceil(matchedBytes / 4)
  const responseTokens = estimateTokens(responseText)
  return {
    operation,
    fullBytes: matchedBytes,
    scannedBytes,
    requestBytes,
    responseBytes,
    avoidedBytes: Math.max(0, matchedBytes - responseBytes),
    estimatedFullTokens: baselineTokens,
    estimatedResponseTokens: responseTokens,
    estimatedTokensAvoided: Math.max(0, baselineTokens - responseTokens),
    anchorCount,
  }
}
