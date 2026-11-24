import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { point, vec3 } from "../core";
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
    // Tools per the spec: Точка (chained Points), Дуга, Исходная точка.
    // The Line and old jump-Point tools have retired: a PTP Move chain
    // already covers them.
    expect(html).toContain("Точка");
    expect(html).toContain("Дуга");
    expect(html).toContain("Исходная точка");
    expect(html).not.toContain("Отрезок");
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

  it("starts on the XY plane with the chained Point tool selected", () => {
    const html = renderToString(<App />);
    expect(html).toMatch(/<input type="radio" name="plane"[^>]*checked[^>]*value="XY"/);
    expect(html).toMatch(/<input type="radio" name="tool"[^>]*checked[^>]*value="point"/);
  });

  it("shows the Motion Type toggle next to the drawing tool, defaulting to LIN", () => {
    const html = renderToString(<App />).replace(/<!-- -->/g, "");
    // The toggle lives with the tools (ADR 0017): LIN (по прямой) and
    // PTP (в точку), LIN checked by default.
    expect(html).toContain("Тип перемещения");
    expect(html).toContain("по прямой");
    expect(html).toContain("в точку");
    expect(html).toMatch(/<input type="radio" name="motionType"[^>]*checked[^>]*value="LIN"/);
    expect(html).toMatch(/<input type="radio" name="motionType"[^>]*value="PTP"/);
  });

  it("hides the Motion Type toggle while the Arc tool is active", () => {
    // Like the Arc definition options, the toggle belongs to the tool
    // it configures: with the Arc tool active it is not shown.
    const html = renderToString(<App initialState={{ ...initialEditorState, tool: "arc" }} />);
    expect(html).not.toMatch(/name="motionType"/);
  });

  it("edits each Move's Motion Type in the segment list, like its Feed", () => {
    const state = {
      ...initialEditorState,
      segments: [
        point({ target: vec3(10, 0, 0), feed: 20, motionType: "LIN" }),
        point({ target: vec3(20, 0, 0), feed: 20, motionType: "PTP" }),
      ],
    };
    const html = renderToString(<App initialState={state} />).replace(/<!-- -->/g, "");
    // Per-Move radios, aligned by index: LIN for Move 0, PTP for Move 1.
    expect(html).toMatch(/name="motionType-0"[^>]*checked[^>]*value="LIN"/);
    expect(html).toMatch(/name="motionType-1"[^>]*checked[^>]*value="PTP"/);
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

  it("shows the editor's rejection message in the app shell", () => {
    // A rejected interaction (e.g. an impossible Arc) names the cause;
    // the shell renders it whatever main-area view is active.
    const message = "Дуга невозможна: концы совпадают — по радиусу центр не определить.";
    const html = renderToString(<App initialState={{ ...initialEditorState, error: message }} />);
    expect(html).toContain(message);
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
