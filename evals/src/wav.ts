// 16-bit PCM WAV helpers for the speech eval. Only mono 16 kHz is read: that is what Whisper takes
// and what stt-audio.ts writes, so nothing here resamples.

export const RATE = 16000;

/** A WAV file around raw little-endian PCM16 mono samples. */
export function pcm16ToWav(pcm: Uint8Array, rate = RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Samples in [-1, 1] from a mono 16 kHz PCM16 WAV file. */
export function readWav(buf: Buffer): Float32Array {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) {
        throw new Error(`need mono ${RATE} Hz PCM16, got ${JSON.stringify(fmt)}`);
      }
      const end = Math.min(buf.length, body + size);
      const out = new Float32Array((end - body) >> 1);
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(body + i * 2) / 32768;
      return out;
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV file has no data chunk');
}
