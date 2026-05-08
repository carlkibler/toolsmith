export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4)
}

export function makeTelemetry({ operation, workspaceKey, fullContent = "", requestPayload = {}, responseText = "", beforeContent, afterContent, anchors = [] }) {
  const fullBytes = Buffer.byteLength(String(fullContent || ""), "utf8")
  const requestBytes = Buffer.byteLength(JSON.stringify(requestPayload || {}), "utf8")
  const responseBytes = Buffer.byteLength(String(responseText || ""), "utf8")
  const beforeBytes = beforeContent === undefined ? undefined : Buffer.byteLength(String(beforeContent), "utf8")
  const afterBytes = afterContent === undefined ? undefined : Buffer.byteLength(String(afterContent), "utf8")
  const avoidedBytes = Math.max(0, fullBytes - responseBytes)

  return {
    operation,
    ...(workspaceKey ? { workspaceKey } : {}),
    fullBytes,
    requestBytes,
    responseBytes,
    avoidedBytes,
    estimatedFullTokens: estimateTokens(fullContent),
    estimatedResponseTokens: estimateTokens(responseText),
    estimatedTokensAvoided: Math.max(0, estimateTokens(fullContent) - estimateTokens(responseText)),
    beforeBytes,
    afterBytes,
    editDeltaBytes: beforeBytes === undefined || afterBytes === undefined ? undefined : afterBytes - beforeBytes,
    anchorCount: anchors.length,
  }
}

export function attachTelemetry(result, telemetry) {
  return { ...result, telemetry }
}
