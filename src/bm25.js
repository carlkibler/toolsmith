// Zero-dependency BM25 lexical scoring, used to rank multi-file search
// candidates by query relevance before spending the match budget on them.
// Borrowed in spirit from Semble's hybrid retrieval (the BM25 component);
// the semantic-embedding half is intentionally left out to keep the core
// dependency-free.

const SPLIT_RE = /[^A-Za-z0-9]+/u
const CAMEL_RE = /([a-z0-9])([A-Z])/gu
const ACRONYM_RE = /([A-Z]+)([A-Z][a-z])/gu

// Split text into lowercase identifier subtokens. "getUserName" and
// "get_user_name" both yield ["get","user","name"] so queries match across
// naming conventions. Single-character tokens are dropped as noise.
export function tokenize(text) {
  const normalized = String(text).replace(ACRONYM_RE, "$1 $2").replace(CAMEL_RE, "$1 $2")
  const tokens = []
  for (const part of normalized.split(SPLIT_RE)) {
    if (part.length < 2) continue
    tokens.push(part.toLowerCase())
  }
  return tokens
}

// Score each document against the query terms using Okapi BM25.
// `documents` is an array of raw strings; returns a same-length array of
// scores (higher = more relevant). Standard k1/b defaults.
export function scoreDocuments(queryTerms, documents, { k1 = 1.5, b = 0.75 } = {}) {
  const n = documents.length
  if (n === 0) return []
  const terms = [...new Set(queryTerms)].filter((t) => t.length >= 2)
  if (terms.length === 0) return new Array(n).fill(0)

  const docTokens = documents.map((doc) => tokenize(doc))
  const docLengths = docTokens.map((tokens) => tokens.length)
  const avgdl = docLengths.reduce((sum, len) => sum + len, 0) / n || 1

  const freqs = docTokens.map((tokens) => {
    const map = new Map()
    for (const token of tokens) map.set(token, (map.get(token) || 0) + 1)
    return map
  })

  const idf = new Map()
  for (const term of terms) {
    let df = 0
    for (const map of freqs) if (map.has(term)) df += 1
    idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)))
  }

  return documents.map((_, i) => {
    const map = freqs[i]
    const dl = docLengths[i]
    let score = 0
    for (const term of terms) {
      const f = map.get(term)
      if (!f) continue
      const denom = f + k1 * (1 - b + (b * dl) / avgdl)
      score += idf.get(term) * ((f * (k1 + 1)) / denom)
    }
    return score
  })
}
