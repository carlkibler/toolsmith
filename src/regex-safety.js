import vm from "node:vm"

const TIMEOUT_MS = 100

// Adversarial inputs that trigger catastrophic backtracking in common ReDoS patterns.
const ADVERSARIAL_INPUTS = [
  "a".repeat(50) + "\0",
  "1".repeat(50) + "\0",
  "<a>".repeat(16) + "\0",
]

const testScript = ADVERSARIAL_INPUTS.map((s) => `re.test(${JSON.stringify(s)})`).join("; ")

export function checkRegexSafety(source, flags) {
  try {
    vm.runInNewContext(
      `var re = new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)}); ${testScript}`,
      Object.create(null),
      { timeout: TIMEOUT_MS },
    )
  } catch (e) {
    if (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new Error("regex may cause catastrophic backtracking; simplify or use literal search")
    }
    throw e
  }
}
