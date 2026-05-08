import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const CLI = path.resolve("bin/toolsmith.js")

test("toolsmith pi defaults to strict Toolsmith-only mode", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-picli-"))
  const fakeBin = path.join(home, "bin")
  const callLog = path.join(home, "pi-args.txt")
  await fs.mkdir(fakeBin, { recursive: true })
  await fs.writeFile(path.join(fakeBin, "pi"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.71.1"; exit 0; fi
printf '%s\\n' "$*" > ${JSON.stringify(callLog)}
`, "utf8")
  await fs.chmod(path.join(fakeBin, "pi"), 0o755)

  try {
    await execFileAsync(process.execPath, [CLI, "pi", "--print", "hi"], {
      env: { ...process.env, HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` },
    })
    const args = await fs.readFile(callLog, "utf8")
    assert.match(args, /--no-builtin-tools/)
    assert.match(args, /--tools .*pi_file_skeleton/)
    assert.match(args, /--append-system-prompt/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("toolsmith pi --with-builtins does not force a Toolsmith-only allowlist", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "toolsmith-picli-"))
  const fakeBin = path.join(home, "bin")
  const callLog = path.join(home, "pi-args.txt")
  await fs.mkdir(fakeBin, { recursive: true })
  await fs.writeFile(path.join(fakeBin, "pi"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.71.1"; exit 0; fi
printf '%s\\n' "$*" > ${JSON.stringify(callLog)}
`, "utf8")
  await fs.chmod(path.join(fakeBin, "pi"), 0o755)

  try {
    await execFileAsync(process.execPath, [CLI, "pi", "--with-builtins", "--print", "hi"], {
      env: { ...process.env, HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` },
    })
    const args = await fs.readFile(callLog, "utf8")
    assert.doesNotMatch(args, /--no-builtin-tools/)
    assert.doesNotMatch(args, /--tools/)
    assert.match(args, /--append-system-prompt/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
