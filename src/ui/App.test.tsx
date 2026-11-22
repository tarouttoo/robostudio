import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { App } from "./App";

describe("app shell", () => {
  it("renders the app shell: name and the drawing editor panels", () => {
    // renderToString interleaves comment markers between text nodes;
    // strip them so multi-node strings match.
    const html = renderToString(<App />).replace(/<!-- -->/g, "");
    expect(html).toContain("robostudio");
    // Working Plane picker with its fixed-coordinate field.
    expect(html).toContain("Рабочая плоскость");
    expect(html).toContain("фикс. Z");
    // Tools per GLOSSARY.md: Отрезок (Line) and Исходная точка (Home Point).
    expect(html).toContain("Отрезок");
    expect(html).toContain("Исходная точка");
    // Undo and clear actions.
    expect(html).toContain("Отменить");
    expect(html).toContain("Очистить");
    // The Trajectory list with its empty-canvas state.
    expect(html).toContain("Траектория");
    expect(html).toContain("Участков: 0");
    // The cursor readout starts empty (canvas is a client-side view).
    expect(html).toContain("Курсор: —");
    // A canvas is present for the client-side renderer to paint into.
    expect(html).toContain("<canvas");
  });

  it("starts on the XY plane with the Line tool selected", () => {
    const html = renderToString(<App />);
    expect(html).toMatch(/<input type="radio" name="plane"[^>]*checked[^>]*value="XY"/);
    expect(html).toMatch(/<input type="radio" name="tool"[^>]*checked[^>]*value="line"/);
  });
});
