export function fnv1a32(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  }
  return hash >>> 0
}

export function contentHash(content) {
  return fnv1a32(content).toString(16).padStart(8, "0")
}
