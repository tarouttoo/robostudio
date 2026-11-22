import { useMemo, useReducer, useState } from "react";

import { line, planePoint, type Segment, type Vec2, type Vec3 } from "../core";
import { APP_NAME, APP_VERSION } from "../core/version";
import {
  DEFAULT_MIKO_MINI_CONFIG,
  createMiKoMiniModel,
} from "../kinematics/miko-mini";
import {
  checkPointReachability,
  checkSegmentReachability,
  type PointReachability,
  type ReachabilityViolation,
} from "../kinematics/reachability";
import type { RobotModel } from "../kinematics/robot-model";
import { Canvas } from "./Canvas";
import { VIOLATION_COLOR } from "./canvas/draw";
import {
  REACHABILITY_COLORS,
  createReachabilitySampler,
  type ReachabilitySampler,
} from "./canvas/reachability";
import {
  editorReducer,
  initialEditorState,
  mmMinToMmS,
  mmSToMmMin,
  planeAxisLetters,
  type EditorTool,
} from "./editor";

/**
 * The v1 Robot Model every drawing view is checked against: the
 * default MiKo-mini configuration (ADR 0008). Built once at module
 * load; the shipped configuration is validated by the kinematics tests,
 * so a failure here is a programming error, not a runtime condition.
 */
const ROBOT: RobotModel = (() => {
  const built = createMiKoMiniModel(DEFAULT_MIKO_MINI_CONFIG);
  if (built.status !== "ok") {
    throw new Error(`invalid default MiKo-mini config: ${built.problems.join("; ")}`);
  }
  return built.model;
})();

/**
 * The trajectory editor: the operator picks the Working Plane with its
 * fixed coordinate, draws Line Segments with two clicks on a millimetre
 * grid, sets the Home Point, and can undo or clear. Drawn geometry is
 * held as canonical Segments in the editor state (see `editor.ts`); the
 * canvas is a pure view over that state (ADR 0007). UI text is Russian
 * per GLOSSARY.md.
 */
export function App() {
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const letters = planeAxisLetters(state.plane);

  // Live Reachability: a fresh map per (robot, plane, fixed coordinate)
  // is the recolouring trigger; inside one map every answered cell is
  // cached, so redrawing stays responsive.
  const reachability = useMemo<ReachabilitySampler>(
    () => createReachabilitySampler(ROBOT, state.plane, state.fixedMm),
    [state.plane, state.fixedMm],
  );
  // One check per committed Segment, aligned with the draw order.
  const violations = useMemo<readonly (ReachabilityViolation | null)[]>(
    () => state.segments.map((segment) => checkSegmentReachability(ROBOT, segment)),
    [state.segments],
  );
  const homeStatus = useMemo<PointReachability | null>(
    () => (state.home === null ? null : checkPointReachability(ROBOT, [state.home.x, state.home.y, state.home.z])),
    [state.home],
  );
  // The pending draft is checked against the hovered endpoint, so the
  // preview turns red before the operator commits an unreachable Line.
  const draftViolation = useMemo<ReachabilityViolation | null>(() => {
    if (state.draftStart === null || cursor === null) return null;
    const start = planePoint(state.plane, state.draftStart.x, state.draftStart.y, state.fixedMm);
    const end = planePoint(state.plane, cursor.x, cursor.y, state.fixedMm);
    return checkSegmentReachability(ROBOT, line({ start, end, feed: mmMinToMmS(state.feedMmMin) }));
  }, [state.draftStart, cursor, state.plane, state.fixedMm, state.feedMmMin]);

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
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", color: "#555" }}>
              Достижимость:
              <LegendSwatch color={REACHABILITY_COLORS.ok} label="достижимо" />
              <LegendSwatch color={REACHABILITY_COLORS.unreachable} label="недостижимо" />
              <LegendSwatch color={REACHABILITY_COLORS["angle-limit"]} label="предел шарнира" />
            </div>
          </fieldset>

          <fieldset style={fieldsetStyle}>
            <legend>Инструмент</legend>
            {(
              [
                { tool: "line" as EditorTool, label: "Отрезок", hint: "два клика" },
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
            Правая кнопка мыши отменяет незавершённый Отрезок.
          </p>

          <section style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <h2 style={{ fontSize: "1rem", margin: 0 }}>Траектория</h2>
            <div style={{ color: "#555", fontSize: "0.9rem" }}>
              Исходная точка:{" "}
              {state.home === null ? (
                "не задана"
              ) : (
                <span
                  style={{
                    fontFamily: "monospace",
                    color: homeStatus === "ok" ? undefined : VIOLATION_COLOR,
                  }}
                >
                  {formatVec3(state.home)}
                  {homeStatus !== null && homeStatus !== "ok" ? ` — ${statusWord(homeStatus)}` : ""}
                </span>
              )}
            </div>
            <div style={{ color: "#555", fontSize: "0.9rem" }}>Участков: {state.segments.length}</div>
            <ol style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.85rem", overflowY: "auto" }}>
              {state.segments.map((segment, i) => {
                const violation = violations[i] ?? null;
                return (
                  <li key={i} style={{ fontFamily: "monospace", marginBottom: "0.25rem" }}>
                    {segmentLabel(segment)}
                    {violation !== null && (
                      <div style={{ color: VIOLATION_COLOR }}>{violationLabel(violation)}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        </aside>

        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <Canvas
            plane={state.plane}
            segments={state.segments}
            home={state.home}
            draftStart={state.draftStart}
            cursor={cursor}
            reachability={reachability}
            violations={violations}
            draftViolation={draftViolation}
            homeStatus={homeStatus}
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

/** One Reachability legend entry: a colour swatch followed by its Russian label. */
function LegendSwatch(props: { readonly color: string; readonly label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
      <span
        style={{
          width: 10,
          height: 10,
          background: props.color,
          border: "1px solid #bbb",
          display: "inline-block",
        }}
      />
      {props.label}
    </span>
  );
}

/** The Russian UI word for one Reachability status, as in the legend. */
function statusWord(status: PointReachability): string {
  switch (status) {
    case "ok":
      return "достижимо";
    case "unreachable":
      return "недостижимо";
    case "angle-limit":
      return "предел шарнира";
  }
}

/** The Russian UI note for one Reachability violation, naming the place and cause. */
function violationLabel(violation: ReachabilityViolation): string {
  switch (violation.status) {
    case "unreachable":
      return `${statusWord(violation.status)} (${formatVec3(violation.atMm)})`;
    case "angle-limit":
      return `${statusWord(violation.status)} ${violation.joint} (${violation.bound === "min" ? "мин" : "макс"})`;
  }
}

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
