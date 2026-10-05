import type { Socket } from 'node:net'

/**
 * Splits a byte stream into newline-delimited frames. A line longer than `limit()` is not buffered: the reader
 * reports it once and the caller closes the connection. The limit is a function because it grows once the
 * handshake is complete.
 */
export class FrameReader {
  private chunks: Buffer[] = []
  private size = 0
  private failed = false

  constructor(
    private readonly limit: () => number,
    private readonly onFrame: (text: string) => void,
    private readonly onTooLong: () => void,
  ) {}

  push(data: Buffer): void {
    if (this.failed) return
    let start = 0
    for (;;) {
      const end = data.indexOf(0x0a, start)
      if (end < 0) break
      const part = data.subarray(start, end)
      if (this.size + part.length > this.limit()) return this.fail()
      const line = this.size === 0 ? part : Buffer.concat([...this.chunks, part])
      this.chunks = []
      this.size = 0
      start = end + 1
      if (line.length > 0) this.onFrame(line.toString('utf8'))
      if (this.failed) return
    }
    const rest = data.subarray(start)
    if (rest.length === 0) return
    if (this.size + rest.length > this.limit()) return this.fail()
    this.chunks.push(rest)
    this.size += rest.length
  }

  private fail(): void {
    this.failed = true
    this.chunks = []
    this.size = 0
    this.onTooLong()
  }
}

/** Writes one frame. Returns the number of bytes the socket has not sent yet, for the caller's slow-reader rule. */
export function writeFrame(socket: Socket, frame: unknown): number {
  if (socket.destroyed || !socket.writable) return 0
  socket.write(`${JSON.stringify(frame)}\n`)
  return socket.writableLength
}
