import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { App } from "./App";
import { initialEditorState } from "./editor";

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

  it("offers Project File save and open in the Файл проекта section", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Файл проекта");
    expect(html).toContain("Сохранить");
    expect(html).toContain("Открыть");
  });

  it("renders the Reachability map legend", () => {
    const html = renderToString(<App />).replace(/<!-- -->/g, "");
    expect(html).toContain("Достижимость");
    expect(html).toContain("достижимо");
    expect(html).toContain("недостижимо");
    expect(html).toContain("предел шарнира");
  });

  it("renders the Arc and Point tools with the Arc definition options", () => {
    // The Arc definition options show while the Arc tool is active.
    const html = renderToString(<App initialState={{ ...initialEditorState, tool: "arc" }} />).replace(/<!-- -->/g, "");
    // Tools per GLOSSARY.md: Дуга (Arc), Точка (Point Segment).
    expect(html).toContain("Дуга");
    expect(html).toContain("Точка");
    // Arc definition modes per ADR 0005: radius R or explicit center.
    expect(html).toContain("Радиус R");
    expect(html).toContain("Центр");
    // Direction per GLOSSARY.md: CW (по часовой), CCW (против часовой).
    expect(html).toMatch(/name="arcDirection"[^>]*value="CW"/);
    expect(html).toMatch(/name="arcDirection"[^>]*value="CCW"/);
    expect(html).toContain("по часовой");
    expect(html).toContain("против часовой");
    // The Arc tool is preselected in this render.
    expect(html).toMatch(/<input type="radio" name="tool"[^>]*checked[^>]*value="arc"/);
    expect(html).toMatch(/<input type="radio" name="arcMode"[^>]*checked[^>]*value="radius"/);
  });

  it("renders the numeric coordinate entry for the active tool", () => {
    const html = renderToString(<App />).replace(/<!-- -->/g, "");
    expect(html).toContain("Ввод координат");
    expect(html).toContain("Ввести точку");
  });

  it("renders the generation section with generate and export actions", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Генерация");
    expect(html).toContain("Сгенерировать");
    expect(html).toContain("Экспорт CSV");
    // Export is locked until a successful generation exists.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Экспорт CSV/);
    // Generate starts unlocked.
    expect(html).toMatch(/<button[^>]*>[^<]*Сгенерировать/);
  });

  it("offers the charts view behind the Графики tab, locked until a generation", () => {
    const html = renderToString(<App />);
    // The main area starts on the drawing view.
    expect(html).toContain("Чертёж");
    expect(html).toContain("Графики");
    // The charts tab is locked until a successful generation exists.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Графики/);
    // The drawing tab starts unlocked and active.
    expect(html).toMatch(/<button[^>]*>[^<]*Чертёж/);
    expect(html).toContain("<canvas");
  });
});
