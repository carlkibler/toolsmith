import vm from "node:vm"

const TIMEOUT_MS = 100
const MAX_DYNAMIC_SAMPLES = 100
const MAX_SAMPLE_BYTES = 256

// Adversarial inputs that trigger catastrophic backtracking in common ReDoS patterns.
const ADVERSARIAL_INPUTS = [
  "a".repeat(50) + "\0",
  "1".repeat(50) + "\0",
  "<a>".repeat(16) + "\0",
]

// Patterns with no quantifiers cannot catastrophically backtrack.
const HAS_QUANTIFIER = /[+*?{]/
const NESTED_QUANTIFIER = /\((?:\\.|[^()\\])*[+*{](?:\\.|[^()\\])*\)\s*[+*{]/

export function checkRegexSafety(source, flags, samples = []) {
  if (!HAS_QUANTIFIER.test(source)) return
  if (NESTED_QUANTIFIER.test(source)) throwUnsafe()

  const dynamicInputs = samples
    .filter((sample) => typeof sample === "string" && sample.length > 0)
    .slice(0, MAX_DYNAMIC_SAMPLES)
    .map((sample) => `${sample.slice(0, MAX_SAMPLE_BYTES)}\0`)
  const inputs = [...ADVERSARIAL_INPUTS, ...dynamicInputs]
  const testScript = inputs.map((sample) => `re.test(${JSON.stringify(sample)})`).join("; ")

  try {
    vm.runInNewContext(
      `var re = new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)}); ${testScript}`,
      Object.create(null),
      { timeout: TIMEOUT_MS },
    )
  } catch (e) {
    if (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throwUnsafe()
    throw e
  }
}

function throwUnsafe() {
  throw new Error("regex may cause catastrophic backtracking; simplify or use literal search")
}
