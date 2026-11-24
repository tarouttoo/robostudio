/**
 * A pure-JS GIF 89a encoder (the Motion Preview's "pure-JS encoder"):
 * indexed-color frames in, a valid animated GIF out — no canvas, no
 * DOM, no native dependency, deterministic bytes for identical input.
 *
 * The output is the classic single-global-color-table animation: one
 * 256-entry global color table, a NETSCAPE2.0 application extension
 * for infinite looping, one Graphic Control Extension per frame
 * carrying its delay, and LZW-compressed image data (minimum code size
 * 8, the 256-color maximum, with the GIF variable-width code packing —
 * codes packed LSB-first, grown 9→12 bits, dictionary cleared at 4096
 * entries). Structure per the GIF 89a specification; the tests decode
 * the produced bytes back (header, frames, delays, pixel content), so
 * the contract is pinned end to end.
 */

/** One RGB palette entry. */
export type GifColor = readonly [number, number, number];

/** One indexed-color frame: its GIF delay and its pixels. */
export interface GifFrame {
  /** Frame delay in hundredths of a second (GIF's unit). */
  readonly delayCs: number;
  /**
   * Palette indices, row-major, `width * height` entries — one byte
   * per pixel, values inside the palette.
   */
  readonly indexed: Uint8Array;
}

/** GIF encoder input: canvas size, the global palette, and the frames. */
export interface GifInput {
  /** Logical screen width, in pixels (GIF 16-bit field). */
  readonly width: number;
  /** Logical screen height, in pixels (GIF 16-bit field). */
  readonly height: number;
  /** The global color table: at most 256 entries. */
  readonly palette: readonly GifColor[];
  /** The frames, in playback order. */
  readonly frames: readonly GifFrame[];
}

/** GIF marker bytes: header magic, image separator, extensions, trailer. */
const GIF_HEADER = "GIF89a";
const IMAGE_SEPARATOR = 0x2c;
const EXTENSION_INTRODUCER = 0x21;
const GRAPHIC_CONTROL_LABEL = 0xf9;
const APPLICATION_EXTENSION_LABEL = 0xff;
const TRAILER = 0x3b;

/** Maximum LZW code width; the dictionary clears when it fills. */
const MAX_CODE_BITS = 12;

/** Hash-table size for the LZW dictionary (power of two, ≥ 4096 entries). */
const HASH_SIZE = 1 << 15;

/** Validates the encoder's structural preconditions, failing loudly. */
function validate(input: GifInput): void {
  const { width, height, palette, frames } = input;
  if (!(Number.isInteger(width) && width > 0 && width <= 0xffff)) {
    throw new RangeError(`GIF width must be an integer in [1, 65535], got ${width}`);
  }
  if (!(Number.isInteger(height) && height > 0 && height <= 0xffff)) {
    throw new RangeError(`GIF height must be an integer in [1, 65535], got ${height}`);
  }
  if (palette.length === 0 || palette.length > 256) {
    throw new RangeError(`GIF palette must hold 1..256 colors, got ${palette.length}`);
  }
  for (const [r, g, b] of palette) {
    for (const channel of [r, g, b]) {
      if (!(Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
        throw new RangeError(`GIF palette colors must be integers 0..255, got ${channel}`);
      }
    }
  }
  if (frames.length === 0) {
    throw new RangeError("a GIF needs at least one frame");
  }
  for (const frame of frames) {
    if (frame.indexed.length !== width * height) {
      throw new RangeError(
        `frame holds ${frame.indexed.length} pixels, expected ${width} × ${height} = ${width * height}`,
      );
    }
    for (const index of frame.indexed) {
      if (index >= palette.length) {
        throw new RangeError(`frame pixel index ${index} is outside the ${palette.length}-color palette`);
      }
    }
  }
}

/**
 * Encodes the frames as an animated GIF 89a. Deterministic: identical
 * input yields byte-identical output. Delay values are written as
 * given (hundredths of a second, clamped to the ≥ 1 the format can
 * express); pacing is the caller's contract.
 */
export function encodeGif(input: GifInput): Uint8Array {
  validate(input);
  const { width, height, palette, frames } = input;

  // The global color table is a power of two: 256 entries for up to
  // 256 colors (entries beyond the palette are black filler).
  const tableBits = Math.max(1, Math.ceil(Math.log2(palette.length)));
  const tableSize = 2 ** tableBits;

  const out: number[] = [];
  const bytes = (...values: number[]): void => {
    for (const value of values) out.push(value);
  };
  const u16le = (v: number): void => bytes(v & 0xff, (v >> 8) & 0xff);

  // Header and logical screen descriptor: global color table present,
  // 8-bit color resolution, table of `tableSize` entries.
  for (const ch of GIF_HEADER) bytes(ch.charCodeAt(0));
  u16le(width);
  u16le(height);
  bytes(0x80 | 0x70 | (tableBits - 1), 0, 0);
  for (let i = 0; i < tableSize; i++) {
    const color = palette[i] ?? [0, 0, 0];
    bytes(color[0] as number, color[1] as number, color[2] as number);
  }

  // NETSCAPE2.0: loop forever.
  bytes(EXTENSION_INTRODUCER, APPLICATION_EXTENSION_LABEL, 0x0b);
  for (const ch of "NETSCAPE2.0") bytes(ch.charCodeAt(0));
  bytes(0x03, 0x01);
  u16le(0); // loop count 0 = infinite
  bytes(0x00);

  for (const frame of frames) {
    // Graphic Control Extension: disposal "do not dispose" (each frame
    // paints the full canvas), the frame's delay, no transparency.
    bytes(EXTENSION_INTRODUCER, GRAPHIC_CONTROL_LABEL, 0x04, 0x04);
    u16le(Math.max(1, Math.round(frame.delayCs)));
    bytes(0x00, 0x00);

    // Image descriptor: full canvas, no local table, no interlace.
    bytes(IMAGE_SEPARATOR);
    u16le(0);
    u16le(0);
    u16le(width);
    u16le(height);
    bytes(0x00);

    // LZW-compressed image data in sub-blocks. The declared minimum
    // code size must match the compressor's clear/end codes: it is the
    // color table's bit depth, floored at the format minimum of 2 —
    // the same value `lzwCompress` bases its codes on.
    const minCodeSize = Math.max(2, tableBits);
    const lzw = lzwCompress(frame.indexed, minCodeSize);
    bytes(minCodeSize);
    for (let offset = 0; offset < lzw.length; offset += 255) {
      const chunk = lzw.slice(offset, offset + 255);
      bytes(chunk.length, ...chunk);
    }
    bytes(0x00); // block terminator
  }

  bytes(TRAILER);
  return Uint8Array.from(out);
}

/**
 * GIF-variant LZW compression of indexed pixels: emits an initial
 * clear code, grows the code width from `minBits + 1` bits as the
 * dictionary fills, clears at 4096 entries, and ends with the end-of-
 * information code. Codes are packed LSB-first into bytes, then cut
 * into ≤ 255-byte sub-block payload (the sub-block length prefixes
 * are added by the caller).
 */
function lzwCompress(indexed: Uint8Array, minCodeSize: number): number[] {
  const clearCode = 2 ** minCodeSize;
  const endCode = clearCode + 1;

  const codes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeBits = minCodeSize + 1;
  let maxCode = (1 << codeBits) - 1;
  let nextCode = endCode + 1;

  const emit = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeBits;
    while (bitCount >= 8) {
      codes.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
    // Width growth mirrors the GIF decoder: when the next code to be
    // assigned no longer fits, the stream widens (capped at 12 bits).
    if (nextCode > maxCode && codeBits < MAX_CODE_BITS) {
      codeBits++;
      maxCode = (1 << codeBits) - 1;
    }
  };

  // The dictionary: open-addressed (prefix code, next pixel) → code.
  // Keys pack both fields into one integer; slots store code + 1, so
  // 0 marks an empty slot.
  const keys = new Int32Array(HASH_SIZE);
  const values = new Int32Array(HASH_SIZE);
  const resetDictionary = (): void => {
    keys.fill(0);
    values.fill(0);
    codeBits = minCodeSize + 1;
    maxCode = (1 << codeBits) - 1;
    nextCode = endCode + 1;
  };

  emit(clearCode);
  resetDictionary();

  const prefixKey = (prefix: number, pixel: number): number => pixel * (1 << MAX_CODE_BITS) + prefix;
  const hashOf = (key: number): number =>
    (Math.imul(key, 2654435761) >>> 17) & (HASH_SIZE - 1);

  let prefix = indexed[0] as number;
  for (let i = 1; i < indexed.length; i++) {
    const pixel = indexed[i] as number;
    const key = prefixKey(prefix, pixel);
    let slot = hashOf(key);
    let found = false;
    while (values[slot] !== 0) {
      if (keys[slot] === key) {
        prefix = values[slot]! - 1;
        found = true;
        break;
      }
      slot = (slot + 1) & (HASH_SIZE - 1);
    }
    if (found) continue;
    emit(prefix);
    if (nextCode < 1 << MAX_CODE_BITS) {
      keys[slot] = key;
      values[slot] = nextCode + 1;
      nextCode++;
    } else {
      emit(clearCode);
      resetDictionary();
    }
    prefix = pixel;
  }
  emit(prefix);
  emit(endCode);
  if (bitCount > 0) codes.push(bitBuffer & 0xff);
  return codes;
}
