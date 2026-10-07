/** Bound external JSON before parsing it; schemas alone cannot bound allocation by response.json(). */
export async function readBoundedJSON(response: Response, limit = 1000000): Promise<unknown> {
  if (!response.body) throw new Error('Provider returned no response body')
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let bytes = 0,
    text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) throw new Error('Provider JSON exceeded its byte limit')
      text += decoder.decode(chunk.value, { stream: true })
    }
    try {
      return JSON.parse(text + decoder.decode()) as unknown
    } catch {
      throw new Error('Provider response is not valid JSON')
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
