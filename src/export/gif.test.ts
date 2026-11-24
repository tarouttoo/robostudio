import { describe, expect, it } from "vitest";

import { encodeGif, type GifFrame, type GifInput } from "./gif";
import { decodeGifFrames } from "./gif-test-support";

/** A 4×2 palette and a two-frame animation, all indices exact. */
const PALETTE: readonly (readonly [number, number, number])[] = [
  [255, 255, 255],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];

function frame(indices: number[]): GifFrame {
  return { delayCs: 5, indexed: Uint8Array.from(indices) };
}

function twoFrameInput(): GifInput {
  return {
    width: 4,
    height: 2,
    palette: PALETTE,
    frames: [
      frame([0, 1, 1, 0, 0, 2, 2, 0]),
      frame([0, 3, 3, 0, 0, 2, 2, 0]),
    ],
  };
}

/** Finds every occurrence of a byte sequence in a byte array. */
function findAll(bytes: Uint8Array, needle: readonly number[]): readonly number[] {
  const at: number[] = [];
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    at.push(i);
  }
  return at;
}

/** Byte text helper: ASCII string of the byte range. */
function ascii(bytes: Uint8Array, from: number, count: number): string {
  return String.fromCharCode(...bytes.slice(from, from + count));
}

describe("GIF encoder structure", () => {
  it("produces a well-formed animated GIF: header, loop extension, frames, trailer", () => {
    const bytes = encodeGif(twoFrameInput());
    expect(ascii(bytes, 0, 6)).toBe("GIF89a");
    expect(bytes[bytes.length - 1]).toBe(0x3b);
    // NETSCAPE2.0 looping application extension is present.
    const netscape = "NETSCAPE2.0".split("").map((ch) => ch.charCodeAt(0));
    expect(findAll(bytes, [0x21, 0xff, 0x0b, ...netscape]).length).toBe(1);
    // One image descriptor (0x2C) per frame.
    expect(findAll(bytes, [0x2c]).length).toBe(2);
    // One graphic control extension per frame.
    expect(findAll(bytes, [0x21, 0xf9]).length).toBe(2);
  });

  it("carries each frame's delay in the graphic control extension", () => {
    const input = twoFrameInput();
    const bytes = encodeGif(input);
    const { delays } = decodeGifFrames(bytes);
    expect(delays).toEqual([0.05, 0.05]);
    void input;
  });

  it("round-trips the pixel indices: decoding restores every frame exactly", () => {
    const input = twoFrameInput();
    const bytes = encodeGif(input);
    const { frames } = decodeGifFrames(bytes);
    expect(frames.length).toBe(2);
    expect(frames[0]).toEqual(Array.from(input.frames[0]!.indexed));
    expect(frames[1]).toEqual(Array.from(input.frames[1]!.indexed));
  });

  it("survives dictionary pressure: more pixels than the 4096-entry dictionary", () => {
    // 64×64 gradient — forces dictionary growth to 12 bits and clears.
    const size = 64;
    const indexed = Uint8Array.from({ length: size * size }, (_, i) => (i * 7) % PALETTE.length);
    const bytes = encodeGif({ width: size, height: size, palette: PALETTE, frames: [frame(Array.from(indexed))] });
    const { frames } = decodeGifFrames(bytes);
    expect(frames[0]).toEqual(Array.from(indexed));
  });

  it("encodes a single pixel frame", () => {
    const bytes = encodeGif({ width: 1, height: 1, palette: PALETTE, frames: [frame([2])] });
    const { frames } = decodeGifFrames(bytes);
    expect(frames[0]).toEqual([2]);
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    expect(encodeGif(twoFrameInput())).toEqual(encodeGif(twoFrameInput()));
  });
});

describe("GIF encoder validation", () => {
  it("rejects dimensions outside the 16-bit fields", () => {
    expect(() => encodeGif({ ...twoFrameInput(), width: 0 })).toThrow(/width/);
    expect(() => encodeGif({ ...twoFrameInput(), height: 70_000 })).toThrow(/height/);
  });

  it("rejects frames whose pixel count or palette indices are wrong", () => {
    const input = twoFrameInput();
    expect(() =>
      encodeGif({ ...input, frames: [frame([0, 1])] }),
    ).toThrow(/pixels/);
    expect(() =>
      encodeGif({ ...input, frames: [frame(Array.from({ length: 8 }, () => 9))] }),
    ).toThrow(/palette/);
  });

  it("rejects an empty frame list and an oversized palette", () => {
    expect(() => encodeGif({ ...twoFrameInput(), frames: [] })).toThrow(/frame/);
    expect(() =>
      encodeGif({
        ...twoFrameInput(),
        palette: Array.from({ length: 257 }, () => [0, 0, 0] as const),
      }),
    ).toThrow(/palette/);
  });
});
