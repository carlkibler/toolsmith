export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4)
}

export function makeCompressionReceipt({ strategy = "targeted_tool_result", originalTokens = 0, compressedTokens = 0, timeMs = 0 } = {}) {
  const savedTokens = Math.max(0, Math.round(originalTokens) - Math.round(compressedTokens))
  const reduction = originalTokens > 0 ? Number((savedTokens / originalTokens * 100).toFixed(1)) : 0
  return {
    strategy,
    layer: "input",
    originalTokens: Math.round(originalTokens),
    compressedTokens: Math.round(compressedTokens),
    savedTokens,
    reduction,
    timeMs,
  }
}

export function makeTelemetry({ operation, workspaceKey, fullContent = "", requestPayload = {}, responseText = "", beforeContent, afterContent, anchors = [] }) {
  const fullBytes = Buffer.byteLength(String(fullContent || ""), "utf8")
  const requestBytes = Buffer.byteLength(JSON.stringify(requestPayload || {}), "utf8")
  const responseBytes = Buffer.byteLength(String(responseText || ""), "utf8")
  const beforeBytes = beforeContent === undefined ? undefined : Buffer.byteLength(String(beforeContent), "utf8")
  const afterBytes = afterContent === undefined ? undefined : Buffer.byteLength(String(afterContent), "utf8")
  const avoidedBytes = Math.max(0, fullBytes - responseBytes)
  const estimatedFullTokens = estimateTokens(fullContent)
  const estimatedResponseTokens = estimateTokens(responseText)
  const estimatedTokensAvoided = Math.max(0, estimatedFullTokens - estimatedResponseTokens)

  return {
    operation,
    ...(workspaceKey ? { workspaceKey } : {}),
    fullBytes,
    requestBytes,
    responseBytes,
    avoidedBytes,
    estimatedFullTokens,
    estimatedResponseTokens,
    estimatedTokensAvoided,
    compression: makeCompressionReceipt({ originalTokens: estimatedFullTokens, compressedTokens: estimatedResponseTokens }),
    beforeBytes,
    afterBytes,
    editDeltaBytes: beforeBytes === undefined || afterBytes === undefined ? undefined : afterBytes - beforeBytes,
    anchorCount: anchors.length,
  }
}

export function attachTelemetry(result, telemetry) {
  return { ...result, telemetry }
}

// Replace a read-family telemetry's naive whole-file savings with the session-deduped
// increment from the store ledger, so reading one file in N chunks can't claim N x the
// file. estimatedTokensAvoided becomes the signed per-call increment (the rollup sums
// these to the honest cumulative); cumulativeTokensAvoided is kept for transparency.
export function applyReadCredit(telemetry, store, { path, sessionId, workspaceKey, hash } = {}) {
  if (!telemetry || !store || typeof store.creditRead !== "function") return telemetry
  const credit = store.creditRead(path, {
    sessionId,
    workspaceKey,
    hash,
    baselineTokens: telemetry.estimatedFullTokens || 0,
    responseTokens: telemetry.estimatedResponseTokens || 0,
  })
  telemetry.estimatedTokensAvoided = credit.incrementalAvoided
  telemetry.cumulativeTokensAvoided = credit.cumulativeAvoided
  telemetry.compression = makeCompressionReceipt({
    originalTokens: telemetry.estimatedFullTokens || 0,
    compressedTokens: Math.max(0, (telemetry.estimatedFullTokens || 0) - credit.incrementalAvoided),
  })
  return telemetry
}
