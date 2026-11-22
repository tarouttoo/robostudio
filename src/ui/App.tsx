import { useReducer, useState, type JSX } from "react";

import { type Segment, type Vec2, type Vec3 } from "../core";
import { APP_NAME, APP_VERSION } from "../core/version";
import { Canvas } from "./Canvas";
import {
  draftPreviewOf,
  editorReducer,
  initialEditorState,
  mmSToMmMin,
  planeAxisLetters,
  type ArcMode,
  type ArcDirection,
  type EditorState,
  type EditorTool,
} from "./editor";

/**
 * The trajectory editor: the operator picks the Working Plane with its
 * fixed coordinate, draws Line, Arc (R or center, CW/CCW), and Point
 * Segments on a millimetre grid — clicking or typing exact coordinates —
 * sets the Home Point, edits per-Segment Feeds, and can undo or clear.
 * Impossible Arcs are rejected at draw time with a readable message.
 * Drawn geometry is held as canonical Segments in the editor state (see
 * `editor.ts`); the canvas is a pure view over that state (ADR 0005,
 * ADR 0007). UI text is Russian per GLOSSARY.md.
 */
export function App(props: { readonly initialState?: EditorState } = {}): JSX.Element {
  const [state, dispatch] = useReducer(editorReducer, props.initialState ?? initialEditorState);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const letters = planeAxisLetters(state.plane);

  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <header style={{ padding: "0.5rem 1rem", borderBottom: "1px solid #ddd", display: "flex", gap: "1rem", alignItems: "baseline" }}>
        <h1 style={{ fontSize: "1.1rem", margin: 0 }}>{APP_NAME}</h1>
        <span style={{ color: "#777" }}>v{APP_VERSION}</span>
      </header>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <aside
          style={{
            width: 300,
            flexShrink: 0,
            borderRight: "1px solid #ddd",
            padding: "1rem",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
          }}
        >
          <fieldset style={fieldsetStyle}>
            <legend>Рабочая плоскость</legend>
            {(["XY", "XZ", "YZ"] as const).map((plane) => (
              <label key={plane} style={rowStyle}>
                <input
                  type="radio"
                  name="plane"
                  value={plane}
                  checked={state.plane === plane}
                  onChange={() => dispatch({ type: "setPlane", plane })}
                />
                {plane}
              </label>
            ))}
            <label style={rowStyle}>
              фикс. {letters.w}, мм{" "}
              <NumberField
                value={state.fixedMm}
                onCommit={(raw) => dispatch({ type: "setFixedMm", raw })}
                step={1}
              />
            </label>
          </fieldset>

          <fieldset style={fieldsetStyle}>
            <legend>Инструмент</legend>
            {(
              [
                { tool: "line" as EditorTool, label: "Отрезок", hint: "два клика" },
                { tool: "arc" as EditorTool, label: "Дуга", hint: "2–3 клика" },
                { tool: "point" as EditorTool, label: "Точка", hint: "один клик" },
                { tool: "home" as EditorTool, label: "Исходная точка", hint: "один клик" },
              ]
            ).map(({ tool, label, hint }) => (
              <label key={tool} style={rowStyle}>
                <input
                  type="radio"
                  name="tool"
                  value={tool}
                  checked={state.tool === tool}
                  onChange={() => dispatch({ type: "setTool", tool })}
                />
                {label}{" "}
                <span style={{ color: "#888" }}>({hint})</span>
              </label>
            ))}
            {state.tool === "arc" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", paddingLeft: "1.5rem" }}>
                <label style={rowStyle}>
                  <input
                    type="radio"
                    name="arcMode"
                    value="radius"
                    checked={state.arcMode === "radius"}
                    onChange={() => dispatch({ type: "setArcMode", mode: "radius" as ArcMode })}
                  />
                  Радиус R <span style={{ color: "#888" }}>(2 клика)</span>
                </label>
                <label style={rowStyle}>
                  <input
                    type="radio"
                    name="arcMode"
                    value="center"
                    checked={state.arcMode === "center"}
                    onChange={() => dispatch({ type: "setArcMode", mode: "center" as ArcMode })}
                  />
                  Центр <span style={{ color: "#888" }}>(3 клика)</span>
                </label>
                <label style={rowStyle}>
                  <input
                    type="radio"
                    name="arcDirection"
                    value="CW"
                    checked={state.arcDirection === "CW"}
                    onChange={() => dispatch({ type: "setArcDirection", direction: "CW" as ArcDirection })}
                  />
                  по часовой (CW)
                </label>
                <label style={rowStyle}>
                  <input
                    type="radio"
                    name="arcDirection"
                    value="CCW"
                    checked={state.arcDirection === "CCW"}
                    onChange={() => dispatch({ type: "setArcDirection", direction: "CCW" as ArcDirection })}
                  />
                  против часовой (CCW)
                </label>
                {state.arcMode === "radius" && (
                  <label style={rowStyle}>
                    Радиус R, мм{" "}
                    <NumberField
                      value={state.arcRadiusMm}
                      onCommit={(raw) => dispatch({ type: "setArcRadiusMm", raw })}
                      step={1}
                      min={0.001}
                    />
                  </label>
                )}
              </div>
            )}
            <label style={rowStyle}>
              Подача, мм/мин{" "}
              <NumberField
                value={state.feedMmMin}
                onCommit={(raw) => dispatch({ type: "setFeedMmMin", raw })}
                step={60}
                min={1}
              />
            </label>
          </fieldset>

          <NumericEntryFieldset
            letters={letters}
            onEntry={(u, v) => dispatch({ type: "numericEntry", u, v })}
          />

          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" onClick={() => dispatch({ type: "undo" })} disabled={state.segments.length === 0}>
              Отменить
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "clear" })}
              disabled={state.segments.length === 0 && state.home === null}
            >
              Очистить
            </button>
          </div>
          <p style={{ margin: 0, color: "#888", fontSize: "0.85rem" }}>
            Правая кнопка мыши отменяет незавершённый элемент.
          </p>

          <section style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <h2 style={{ fontSize: "1rem", margin: 0 }}>Траектория</h2>
            <div style={{ color: "#555", fontSize: "0.9rem" }}>
              Исходная точка:{" "}
              {state.home === null ? (
                "не задана"
              ) : (
                <span style={{ fontFamily: "monospace" }}>{formatVec3(state.home)}</span>
              )}
            </div>
            <div style={{ color: "#555", fontSize: "0.9rem" }}>Участков: {state.segments.length}</div>
            <ol style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.85rem", overflowY: "auto" }}>
              {state.segments.map((segment, i) => (
                <li key={i} style={{ fontFamily: "monospace", marginBottom: "0.25rem" }}>
                  {segmentLabel(segment)}
                  <label style={{ ...rowStyle, fontFamily: "system-ui, sans-serif", marginTop: "0.15rem" }}>
                    Подача, мм/мин{" "}
                    <NumberField
                      key={`${i}:${segment.feed}`}
                      value={mmSToMmMin(segment.feed)}
                      onCommit={(raw) => dispatch({ type: "setSegmentFeedMmMin", index: i, raw })}
                      step={60}
                      min={1}
                    />
                  </label>
                </li>
              ))}
            </ol>
          </section>
        </aside>

        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <Canvas
            plane={state.plane}
            segments={state.segments}
            home={state.home}
            draft={draftPreviewOf(state)}
            cursor={cursor}
            onPlaneClick={(uv) => dispatch({ type: "canvasClick", u: uv.x, v: uv.y })}
            onCursorMove={setCursor}
            onDraftCancel={() => dispatch({ type: "cancelDraft" })}
          />
          <div
            style={{
              borderTop: "1px solid #ddd",
              padding: "0.4rem 1rem",
              fontFamily: "monospace",
              fontSize: "0.9rem",
              color: "#444",
            }}
          >
            {state.error !== null && (
              <div style={{ color: "#b42318", marginBottom: "0.2rem" }}>{state.error}</div>
            )}
            {cursor === null
              ? "Курсор: —"
              : `Курсор: ${letters.u} ${formatMm(cursor.x)} · ${letters.v} ${formatMm(cursor.y)} · фикс. ${letters.w} ${formatMm(state.fixedMm)} мм`}
          </div>
        </div>
      </div>
    </main>
  );
}

/** Fieldset look for the tool panels. */
const fieldsetStyle = { border: "1px solid #ddd", borderRadius: 4, margin: 0, padding: "0.5rem", display: "flex", flexDirection: "column", gap: "0.25rem" } as const;

/** One labelled row inside a fieldset. */
const rowStyle = { display: "flex", alignItems: "center", gap: "0.5rem" } as const;

/**
 * A numeric field for millimetre and feed values: keeps the raw text
 * while it parses (so intermediate input like "5." is not clobbered)
 * and commits every parseable value. The state value only ever changes
 * through this field, so no resync from props is needed; invalid text
 * simply leaves the committed value untouched.
 */
function NumberField(props: { readonly value: number; readonly onCommit: (raw: string) => void; readonly step: number; readonly min?: number }) {
  const [text, setText] = useState(String(props.value));
  return (
    <input
      type="number"
      value={text}
      step={props.step}
      min={props.min}
      style={{ width: 90, fontFamily: "monospace" }}
      onChange={(e) => {
        setText(e.target.value);
        props.onCommit(e.target.value);
      }}
    />
  );
}

/** The fieldset look for the numeric coordinate entry. */
function NumericEntryFieldset(props: { readonly letters: { u: string; v: string; w: string }; readonly onEntry: (u: number, v: number) => void }): JSX.Element {
  const [uText, setUText] = useState("");
  const [vText, setVText] = useState("");
  const u = Number(uText);
  const v = Number(vText);
  const valid = uText.trim() !== "" && vText.trim() !== "" && Number.isFinite(u) && Number.isFinite(v);
  const inputStyle = { width: 90, fontFamily: "monospace" } as const;
  return (
    <fieldset style={fieldsetStyle}>
      <legend>Ввод координат</legend>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <label style={rowStyle}>
          {props.letters.u}, мм <input type="number" value={uText} style={inputStyle} onChange={(e) => setUText(e.target.value)} />
        </label>
        <label style={rowStyle}>
          {props.letters.v}, мм <input type="number" value={vText} style={inputStyle} onChange={(e) => setVText(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={!valid}
          onClick={() => {
            props.onEntry(u, v);
            setUText("");
            setVText("");
          }}
        >
          Ввести точку
        </button>
      </div>
      <p style={{ margin: 0, color: "#888", fontSize: "0.8rem" }}>
        Ввод действует как клик по активному инструменту, но точно по координатам.
      </p>
    </fieldset>
  );
}

/** Formats a millimetre coordinate for the cursor readout: one decimal. */
function formatMm(mm: number): string {
  return mm.toFixed(1);
}

/** Formats a 3D world point as "(x, y, z)" in millimetres. */
function formatVec3(p: Vec3): string {
  return `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
}

/** One Trajectory list entry: kind name, endpoints, and Feed in mm/min. */
function segmentLabel(segment: Segment): string {
  switch (segment.kind) {
    case "line":
      return `Отрезок (${formatVec3(segment.start)}) → (${formatVec3(segment.end)}), ${mmSToMmMin(segment.feed).toFixed(0)} мм/мин`;
    case "arc":
      return `Дуга (${formatVec3(segment.start)}) → (${formatVec3(segment.end)}), R ${segment.radiusMm.toFixed(1)}, ${mmSToMmMin(segment.feed).toFixed(0)} мм/мин`;
    case "point":
      return `Точка (${formatVec3(segment.target)}), ${mmSToMmMin(segment.feed).toFixed(0)} мм/мин`;
  }
}
