import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { App } from "./App";

describe("renderer stub", () => {
  it("renders the app shell: name heading and trajectory placeholder", () => {
    const html = renderToString(<App />);
    expect(html).toContain("robostudio");
    expect(html).toContain("Траектория");
  });
});
