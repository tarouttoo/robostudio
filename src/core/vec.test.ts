import { describe, expect, it } from "vitest";

import { add, distance, lerp, length, scale, sub, vec2, vec3 } from "./vec";

describe("vec3", () => {
  it("computes length", () => {
    expect(length(vec3(3, 4, 0))).toBe(5);
  });

  it("computes distance between two points", () => {
    expect(distance(vec3(1, 2, 3), vec3(4, 6, 3))).toBe(5);
  });

  it("adds, subtracts, scales, and interpolates", () => {
    expect(add(vec3(1, 2, 3), vec3(10, 20, 30))).toEqual(vec3(11, 22, 33));
    expect(sub(vec3(10, 20, 30), vec3(1, 2, 3))).toEqual(vec3(9, 18, 27));
    expect(scale(vec3(1, -2, 3), 2)).toEqual(vec3(2, -4, 6));
    expect(lerp(vec3(0, 0, 0), vec3(10, 20, 30), 0.5)).toEqual(vec3(5, 10, 15));
    expect(lerp(vec3(0, 0, 0), vec3(10, 20, 30), 0)).toEqual(vec3(0, 0, 0));
    expect(lerp(vec3(0, 0, 0), vec3(10, 20, 30), 1)).toEqual(vec3(10, 20, 30));
  });
});

describe("vec2", () => {
  it("computes distance in the working plane", () => {
    expect(distance(vec2(0, 0), vec2(3, 4))).toBe(5);
  });
});
