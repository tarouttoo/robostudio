import { describe, expect, it } from "vitest";

import { APP_NAME, APP_VERSION } from "./version";

describe("app identity", () => {
  it("exposes the app name and a semver version", () => {
    expect(APP_NAME).toBe("robostudio");
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
