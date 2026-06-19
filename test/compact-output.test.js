import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import test from "node:test"
import path from "node:path"
import { promisify } from "node:util"
import { compactToolOutput } from "../src/compact-output.js"

const execFileAsync = promisify(execFile)

test("compactToolOutput strips terminal noise and collapses repeated lines", () => {
  const noisy = "\u001b[31mFAIL\u001b[0m\n" + "long repeated failure line with enough payload to save tokens\n".repeat(20) + "--More--\n"
  const result = compactToolOutput(noisy, { maxRepeated: 2 })

  assert.equal(result.text, "FAIL\nlong repeated failure line with enough payload to save tokens\nlong repeated failure line with enough payload to save tokens\n[toolsmith compact-output: previous line repeated 18 more time(s)]")
  assert.equal(result.receipt.strategy, "lossless_tool_result_trim")
  assert(result.receipt.savedTokens > 0)
})

test("CLI compact-output reads stdin", async () => {
  const input = "long repeated test output line with enough payload\n".repeat(3)
  const stdout = await runWithStdin(process.execPath, [path.resolve("bin/toolsmith.js"), "compact-output", "--max-repeated", "1"], input)

  assert.equal(stdout.trim(), "long repeated test output line with enough payload\n[toolsmith compact-output: previous line repeated 2 more time(s)]")
})

function runWithStdin(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr || `process exited ${code}`))
    })
    child.stdin.end(input)
  })
}
