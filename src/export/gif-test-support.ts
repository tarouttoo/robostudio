/**
 * Test support for the GIF encoder: a minimal GIF 89a decoder used by
 * the encoder tests and the Motion Preview GIF tests to verify the
 * produced bytes end to end — structure (frames, delays, canvas) and
 * pixel content (decoded palette indices). Test-side only; never
 * imported by shipped code (the encoder's contract is checked against
 * this independent inverse, not against itself).
 */

/** One decoded animation: canvas size, per-frame delays (seconds), per-frame pixels. */
export interface DecodedGif {
  readonly width: number;
  readonly height: number;
  readonly delays: readonly number[];
  readonly frames: readonly number[][];
}

/** Throws unless the condition holds (the vitest-independent assertion). */
function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * Decodes a GIF 89a animation: walks the block structure, reads each
 * frame's Graphic Control Extension delay, and LZW-decodes the image
 * data back into palette indices.
 */
export function decodeGifFrames(bytes: Uint8Array): DecodedGif {
  const ascii = (from: number, count: number): string =>
    String.fromCharCode(...bytes.slice(from, from + count));
  assert(ascii(0, 6) === "GIF89a", "not a GIF89a file");
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  const packed = bytes[10]!;
  assert((packed & 0x80) !== 0, "global color table missing");
  const tableBits = (packed & 0x07) + 1;
  const tableSize = 2 ** tableBits;
  const delays: number[] = [];
  const frames: number[][] = [];

  let i = 13 + tableSize * 3;
  while (i < bytes.length && bytes[i] !== 0x3b) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) {
      // Graphic control extension: delay in 1/100 s, little-endian.
      delays.push((bytes[i + 4]! | (bytes[i + 5]! << 8)) / 100);
      i += 8; // introducer, label, size, packed, delay, transparent, terminator
      continue;
    }
    if (bytes[i] === 0x21) {
      // Any other extension: walk its sub-blocks.
      i += 2;
      while (bytes[i] !== 0x00) i += 1 + bytes[i]!;
      i += 1;
      continue;
    }
    if (bytes[i] === 0x2c) {
      // Image descriptor: separator + 4 × u16 + packed = 10 bytes, then
      // the LZW minimum code size byte, then the data sub-blocks.
      const minCodeSize = bytes[i + 10]!;
      i += 11;
      const data: number[] = [];
      while (bytes[i] !== 0x00) {
        const size = bytes[i] as number;
        for (let k = 1; k <= size; k++) data.push(bytes[i + k] as number);
        i += 1 + size;
      }
      i += 1;
      frames.push(lzwDecode(data, minCodeSize, width * height));
      continue;
    }
    throw new Error(`unknown block marker 0x${bytes[i]?.toString(16)} at ${i}`);
  }
  return { width, height, delays, frames };
}

/** The test-side LZW inverse of the encoder's compress. */
function lzwDecode(data: number[], minCodeSize: number, pixelCount: number): number[] {
  const clear = 2 ** minCodeSize;
  const end = clear + 1;
  let codeBits = minCodeSize + 1;
  let bitPos = 0;
  const readCode = (): number => {
    let code = 0;
    for (let b = 0; b < codeBits; b++) {
      const byte = data[(bitPos + b) >> 3] as number;
      if ((byte >> ((bitPos + b) & 7)) & 1) code |= 1 << b;
    }
    bitPos += codeBits;
    return code;
  };

  const dict: number[][] = [];
  const resetDict = (): void => {
    dict.length = 0;
    for (let c = 0; c < clear; c++) dict.push([c]);
    dict.push([]); // clear
    dict.push([]); // end
    codeBits = minCodeSize + 1;
  };
  resetDict();

  const pixels: number[] = [];
  let prev: number[] | null = null;
  for (;;) {
    const code = readCode();
    if (code === clear) {
      resetDict();
      prev = null;
      continue;
    }
    if (code === end) break;
    let entry: number[];
    if (code < dict.length && dict[code]!.length > 0) {
      entry = dict[code] as number[];
    } else if (prev !== null) {
      entry = [...prev, prev[0] as number];
    } else {
      throw new Error(`invalid first code ${code}`);
    }
    pixels.push(...entry);
    if (prev !== null) {
      dict.push([...prev, entry[0] as number]);
      if (dict.length === 1 << codeBits && codeBits < 12) codeBits++;
    }
    prev = entry;
    if (pixels.length > pixelCount * 2) throw new Error("decoder runaway");
  }
  return pixels;
}
