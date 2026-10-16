/**
 * 0.9.1, local speech: sound handling, pure functions. Signed 16-bit little-endian PCM to floats and back, a
 * band-limited resampler (a windowed-sinc low-pass, not dropped samples), the silence at the start of a
 * synthesized sentence trimmed, and PCM cut into pieces of at most 100 ms.
 */

export function pcm16ToFloat(pcm: Buffer): Float32Array {
  const n = pcm.length >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += 1) out[i] = pcm.readInt16LE(i * 2) / 32768
  return out
}

export function floatToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i] as number))
    out.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2)
  }
  return out
}

function bessel0(x: number): number {
  let sum = 1
  let term = 1
  for (let k = 1; k < 40; k += 1) {
    term *= (x / (2 * k)) ** 2
    sum += term
    if (term < 1e-12 * sum) break
  }
  return sum
}

const KERNEL_STEPS = 256

/**
 * Converts between sample rates with a Kaiser-windowed sinc low-pass (about 80 dB of stop-band), cut a little
 * below the lower of the two Nyquist frequencies, so that nothing above the new Nyquist folds back into the band.
 * Streaming: `process` may be called with consecutive pieces and `flush` once at the end.
 */
export class Resampler {
  private readonly step: number
  private readonly half: number
  private readonly kernel: Float32Array
  private readonly cut: number
  private buffer = new Float32Array(0)
  /** Position of the next output sample, in input samples, relative to the start of `buffer`. */
  private pos = 0

  constructor(
    readonly inRate: number,
    readonly outRate: number,
  ) {
    this.step = inRate / outRate
    this.cut = Math.min(1, outRate / inRate) * 0.94
    this.half = Math.ceil(20 / this.cut)
    const taps = this.half * KERNEL_STEPS
    this.kernel = new Float32Array(taps * 2 + 1)
    const beta = 8
    const norm = bessel0(beta)
    for (let i = -taps; i <= taps; i += 1) {
      const d = i / KERNEL_STEPS
      const x = Math.PI * this.cut * d
      const sinc = d === 0 ? 1 : Math.sin(x) / x
      const r = d / this.half
      const win = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / norm
      this.kernel[i + taps] = this.cut * sinc * win
    }
  }

  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return input
    const joined = new Float32Array(this.buffer.length + input.length)
    joined.set(this.buffer)
    joined.set(input, this.buffer.length)
    this.buffer = joined
    return this.run(false)
  }

  /** The tail, as if the input went on with silence. */
  flush(): Float32Array {
    if (this.inRate === this.outRate) return new Float32Array(0)
    const out = this.run(true)
    this.buffer = new Float32Array(0)
    this.pos = 0
    return out
  }

  private run(final: boolean): Float32Array {
    const buf = this.buffer
    const out = new Float32Array(Math.max(0, Math.ceil((Math.max(0, (final ? buf.length : buf.length - this.half) - this.pos)) / this.step) + 2))
    let n = 0
    const taps = this.half * KERNEL_STEPS
    // A sample is produced when every input it needs has arrived (or, at the end, up to the last real input).
    const limit = final ? buf.length : buf.length - this.half
    while (this.pos < limit) {
      const centre = Math.floor(this.pos)
      let acc = 0
      for (let k = centre - this.half + 1; k <= centre + this.half; k += 1) {
        if (k < 0 || k >= buf.length) continue
        const d = (this.pos - k) * KERNEL_STEPS
        const i0 = Math.floor(d)
        const frac = d - i0
        const a = this.kernel[i0 + taps] as number
        const b = this.kernel[Math.min(i0 + 1 + taps, this.kernel.length - 1)] as number
        acc += (buf[k] as number) * (a + (b - a) * frac)
      }
      out[n++] = acc
      this.pos += this.step
    }
    if (!final) {
      const drop = Math.max(0, Math.floor(this.pos) - this.half)
      this.buffer = buf.slice(drop)
      this.pos -= drop
    }
    return out.slice(0, n)
  }
}

export function resampleWhole(samples: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return samples
  const r = new Resampler(inRate, outRate)
  const a = r.process(samples)
  const b = r.flush()
  const out = new Float32Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/**
 * Drops the silence at the start of a synthesized sentence so that speech begins at once, keeping a few
 * milliseconds before the first sample above the threshold so that its onset is not clipped.
 */
export function trimLeadingSilence(samples: Float32Array, sampleRate: number, options: { threshold?: number; keepMs?: number } = {}): Float32Array {
  const threshold = options.threshold ?? 0.012
  const keep = Math.round(((options.keepMs ?? 12) * sampleRate) / 1000)
  let first = -1
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i] as number) > threshold) {
      first = i
      break
    }
  }
  if (first < 0) return new Float32Array(0)
  return samples.subarray(Math.max(0, first - keep))
}

/** Cuts PCM into pieces of at most `maxMs`, each a whole number of samples. */
export function chunkPcm(pcm: Buffer, sampleRate: number, maxMs = 100): Buffer[] {
  const bytes = Math.max(2, Math.floor((sampleRate * maxMs) / 1000) * 2)
  const out: Buffer[] = []
  for (let at = 0; at < pcm.length; at += bytes) out.push(pcm.subarray(at, Math.min(pcm.length, at + bytes)))
  return out
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += (samples[i] as number) ** 2
  return Math.sqrt(sum / samples.length)
}
