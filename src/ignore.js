// Zero-dependency .toolsmithignore matcher (gitignore-style syntax), borrowed
// from Semble's .sembleignore. Lets a project tune what find_and_anchor walks
// beyond the hardcoded skip list. Supports comments, blank lines, `*`/`**`/`?`
// globs, leading-slash anchoring, trailing-slash dir-only patterns, and `!`
// negation (force-include) with last-match-wins precedence.
//
// Known limitation (shared with git): a `!` re-include cannot resurface a file
// inside a directory that was pruned by an earlier directory rule.

function globToRegExp(glob) {
  let out = ""
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    if (char === "*") {
      if (glob[i + 1] === "*") { out += ".*"; i += 1 } else out += "[^/]*"
    } else if (char === "?") {
      out += "[^/]"
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    }
  }
  return out
}

export function compileIgnore(text) {
  const rules = []
  for (const raw of String(text).split(/\r?\n/u)) {
    let line = raw.trim()
    if (!line || line.startsWith("#")) continue
    let negated = false
    if (line.startsWith("!")) { negated = true; line = line.slice(1) }
    let dirOnly = false
    if (line.endsWith("/")) { dirOnly = true; line = line.slice(0, -1) }
    let anchored = false
    if (line.startsWith("/")) { anchored = true; line = line.slice(1) }
    if (line.includes("/")) anchored = true
    if (!line) continue
    const body = globToRegExp(line)
    const re = anchored ? new RegExp(`^${body}(?:/.*)?$`, "u") : new RegExp(`^${body}$`, "u")
    rules.push({ negated, dirOnly, anchored, re })
  }
  if (rules.length === 0) return null

  return {
    ignores(relPath, isDir = false) {
      const p = String(relPath).replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "")
      const base = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p
      let matched = false
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue
        const target = rule.anchored ? p : base
        if (rule.re.test(target)) matched = !rule.negated
      }
      return matched
    },
  }
}
