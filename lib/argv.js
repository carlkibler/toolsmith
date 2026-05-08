export const command = process.argv[2]
export const args = process.argv.slice(3)

export const VALUE_FLAGS = new Set(["--start", "--end", "--session", "--context", "--max", "--max-files", "--max-per-file", "--max-matches-per-file", "--glob", "--path", "--query", "--client", "--format", "--days", "--log", "--remote", "--max-examples", "--scope", "--search", "--replacement", "--edits", "--lines", "--tail", "--from"])

export function option(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

export function positionals() {
  const out = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.has(arg)) index += 1
      continue
    }
    out.push(arg)
  }
  return out
}
