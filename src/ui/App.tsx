import { useMemo, useReducer, useState, type JSX } from "react";

import { line, planePoint, segmentEnds, type Segment, type Vec2, type Vec3 } from "../core";
import { serializeProject } from "../project";
import { APP_NAME, APP_VERSION } from "../core/version";
import { bridge } from "./bridge";
import {
  checkPointReachability,
  checkPointViolation,
  checkSegmentReachability,
  type PointReachability,
  type ReachabilityViolation,
} from "../kinematics/reachability";
import { Canvas } from "./Canvas";
import { VIOLATION_COLOR } from "./canvas/draw";
import {
  REACHABILITY_COLORS,
  createReachabilitySampler,
  type ReachabilitySampler,
} from "./canvas/reachability";
import {
  createGenerationSession,
  exportEligibility,
  generationLogLines,
  viewAfterGeneration,
  type GenerationOutcome,
  type MainView,
} from "./generation";
import { ChartsView } from "./ChartsView";
import { MotionPreviewDialog } from "./MotionPreviewDialog";
import { MIKO_MINI } from "./robot";
import {
  draftPreviewOf,
  editorReducer,
  initialEditorState,
  mmMinToMmS,
  mmSToMmMin,
  planeAxisLetters,
  projectContentOf,
  type ArcMode,
  type ArcDirection,
  type EditorState,
  type EditorTool,
  type MotionType,
} from "./editor";

/**
 * The Generation session: the Robot Model bound exactly once (ADR 0008)
 * — the app passes MiKo-mini here and every «Сгенерировать» run goes
 * through this one stable reference; a second robot is one
 * configuration change at this factory, not edits across the shell.
 */
const generationSession = createGenerationSession(MIKO_MINI);

/**
 * The trajectory editor: the operator picks the Working Plane with its
 * fixed coordinate, places a chain of Point Segments — one click per
 * Move, chaining from the previous Segment's end (the first from
 * the Home Point) — chooses the Motion Type the next Move travels by
 * (LIN по прямой, the default, or PTP в точку), edits each committed
 * Move's Motion Type and Feed in the segment list, draws chained Arcs
 * (always starting where the chain stands — R or center, CW/CCW, one
 * or two clicks), sets the Home Point, and can undo or clear.
 * Impossible Arcs are rejected at draw time with a readable message;
 * Reachability of a pending Move is checked by its Motion Type — LIN
 * along the drawn line, PTP at its target only. Drawn geometry is
 * held as canonical Segments in the editor state (see `editor.ts`); the
 * canvas is a pure view over that state (ADR 0005, ADR 0007). On
 * «Сгенерировать» the drawn Trajectory runs through the
 * headless pipeline (the Generation session's `run`) and the validation stage log is
 * shown; a successful generation unlocks «Экспорт…», which writes the
 * Robot CSV, the RViz CSV, and the Motion Preview GIF
 * (`robot_motion.gif`) into an operator-picked folder through the
 * main process, and switches the main area to «Графики» — every chart
 * the outcome carries, rendered at Generation time by the headless
 * renderer (ADR 0013, `ChartsView.tsx`). «Предпросмотр движения…»
 * opens the playback dialog (`MotionPreviewDialog.tsx`) over the same
 * outcome's Preview Scene (ADR 0018) — the scene document the exported
 * GIF also renders; the dialog explores it through its own Orbit
 * Camera. Regeneration replaces those charts and scene with the new
 * outcome's documents; a failed or blocked run carries neither and
 * returns to «Чертёж». UI text is Russian per GLOSSARY.md.
 */
export function App(props: { readonly initialState?: EditorState } = {}): JSX.Element {
  const [state, dispatch] = useReducer(editorReducer, props.initialState ?? initialEditorState);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  /** Status of the last Project File operation; the flag, not the text, decides the colour. */
  const [projectMessage, setProjectMessage] = useState<{ readonly text: string; readonly isError: boolean } | null>(null);
  /** The last generation attempt, shown as the generation log. */
  const [generation, setGeneration] = useState<GenerationOutcome | null>(null);
  /** Status of the last CSV export; the flag, not the text, decides the colour. */
  const [exportMessage, setExportMessage] = useState<{ readonly text: string; readonly isError: boolean } | null>(null);
  /** Which main-area view is shown: the drawing canvas or the charts. */
  const [view, setView] = useState<MainView>("drawing");
  /** Whether the Motion Preview playback dialog is open. */
  const [previewOpen, setPreviewOpen] = useState(false);
  /** The charts of the last successful generation, carried on its outcome (ADR 0013). */
  const charts = generation !== null && generation.kind === "ok" ? generation.charts : null;
  /** The Preview Scene of the last successful generation, carried on its outcome (ADR 0018). */
  const previewScene = generation !== null && generation.kind === "ok" ? generation.previewScene : null;
  /** The Generation module's one export-policy answer: the export button's
   * disabled state, its stale notice, and the export guard all consume it. */
  const eligibility = exportEligibility(generation, state);
  const letters = planeAxisLetters(state.plane);

  /** Runs generation on the drawn Trajectory and shows the log; success opens the refreshed charts, a failure returns to the drawing. */
  const handleGenerate = (): void => {
    const outcome = generationSession.run(state);
    setGeneration(outcome);
    setExportMessage(null);
    setView(viewAfterGeneration(outcome));
  };

  /** Writes the generated files (both CSVs and the Motion Preview GIF) into a
   * picked folder; the eligibility predicate is the gate — only an eligible
   * generation exports. */
  const handleExport = async (): Promise<void> => {
    if (eligibility.kind !== "eligible") return;
    const api = bridge();
    if (api === null) {
      setExportMessage({ text: "Экспорт недоступен: нет моста к основному процессу.", isError: true });
      return;
    }
    const result = await api.exportCsvs(eligibility.robotCsv, eligibility.rvizCsv, eligibility.motionGif);
    if (result.kind === "exported") setExportMessage({ text: `Экспортировано: ${result.files.join(", ")}`, isError: false });
    else if (result.kind === "canceled") setExportMessage(null);
    else setExportMessage({ text: `Экспорт не выполнен: ${result.error.message}`, isError: true });
  };

  /** Saves the drawing as a Project File through the main process. */
  const handleSave = async (): Promise<void> => {
    const api = bridge();
    if (api === null) {
      setProjectMessage({ text: "Сохранение недоступно: нет моста к основному процессу.", isError: true });
      return;
    }
    const json = serializeProject(projectContentOf(state));
    const result = await api.saveProject(json);
    if (result.kind === "saved") setProjectMessage({ text: `Сохранено: ${result.path}`, isError: false });
    else if (result.kind === "canceled") setProjectMessage(null);
    else setProjectMessage({ text: `Не сохранено: ${result.error.message}`, isError: true });
  };

  /** Opens a Project File through the main process and restores the drawing. */
  const handleOpen = async (): Promise<void> => {
    const api = bridge();
    if (api === null) {
      setProjectMessage({ text: "Открытие недоступно: нет моста к основному процессу.", isError: true });
      return;
    }
    const result = await api.openProject();
    if (result.kind === "loaded") {
      dispatch({ type: "loadProject", content: result.content });
      setProjectMessage({ text: `Открыт: ${result.path}`, isError: false });
    } else if (result.kind === "canceled") setProjectMessage(null);
    else setProjectMessage({ text: result.error.message, isError: true });
  };

  // Live Reachability: a fresh map per (robot, plane, fixed coordinate)
  // is the recolouring trigger; inside one map every answered cell is
  // cached, so redrawing stays responsive.
  const reachability = useMemo<ReachabilitySampler>(
    () => createReachabilitySampler(MIKO_MINI, state.plane, state.fixedMm),
    [state.plane, state.fixedMm],
  );
  // One check per committed Segment, aligned with the draw order. A
  // Point Move is checked by its Motion Type: PTP at its target only,
  // LIN along the drawn straight line from where the chain stands — the
  // previous Segment's end, the Home Point first.
  const violations = useMemo<readonly (ReachabilityViolation | null)[]>(
    () =>
      state.segments.map((segment, i) => {
        const previous = state.segments[i - 1];
        const moveStart = i === 0 ? state.home : previous !== undefined ? segmentEnds(previous).end : null;
        return checkSegmentReachability(MIKO_MINI, segment, moveStart ?? undefined);
      }),
    [state.segments, state.home],
  );
  const homeStatus = useMemo<PointReachability | null>(
    () => (state.home === null ? null : checkPointReachability(MIKO_MINI, [state.home.x, state.home.y, state.home.z])),
    [state.home],
  );
  // The pending draft is checked before the operator commits: an Arc
  // draft along its approximate path; the Point tool's pending Move by
  // its Motion Type — a PTP Move at its target only (arrival is all it
  // guarantees), a LIN Move along the drawn straight line it would
  // follow.
  const draftViolation = useMemo<ReachabilityViolation | null>(() => {
    if (cursor === null) return null;
    const end = planePoint(state.plane, cursor.x, cursor.y, state.fixedMm);
    if (state.tool === "point" && state.motionType === "PTP") {
      return checkPointViolation(MIKO_MINI, [end.x, end.y, end.z]);
    }
    // The pending draft is checked along the straight line from the
    // chain end (the pending Move's line, or the chord approximating
    // the pending Arc) to the cursor.
    const draft = draftPreviewOf(state);
    if (draft === null) return null;
    const start = planePoint(state.plane, draft.start.x, draft.start.y, state.fixedMm);
    return checkSegmentReachability(MIKO_MINI, line({ start, end, feed: mmMinToMmS(state.feedMmMin) }));
  }, [state, cursor]);

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
                { tool: "point" as EditorTool, label: "Точка", hint: "клик — точка в цепочке" },
                { tool: "arc" as EditorTool, label: "Дуга", hint: "1–2 клика, продолжается с конца цепочки" },
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
            {state.tool === "point" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", paddingLeft: "1.5rem" }}>
                <span style={{ fontSize: "0.8rem", color: "#555" }}>Тип перемещения</span>
                {(["LIN", "PTP"] as const).map((motionType) => (
                  <label key={motionType} style={rowStyle}>
                    <input
                      type="radio"
                      name="motionType"
                      value={motionType}
                      checked={state.motionType === motionType}
                      onChange={() => dispatch({ type: "setMotionType", motionType })}
                    />
                    {motionTypeLabel(motionType)}
                  </label>
                ))}
              </div>
            )}
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
                  Радиус R <span style={{ color: "#888" }}>(1 клик — конец дуги)</span>
                </label>
                <label style={rowStyle}>
                  <input
                    type="radio"
                    name="arcMode"
                    value="center"
                    checked={state.arcMode === "center"}
                    onChange={() => dispatch({ type: "setArcMode", mode: "center" as ArcMode })}
                  />
                  Центр <span style={{ color: "#888" }}>(2 клика: центр, потом конец)</span>
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
            <label
              style={rowStyle}
              title="Поле задаёт подачу участков, нарисованных после его изменения. Чтобы переназначить подачу уже нарисованной траектории, нажмите «Применить ко всем участкам»."
            >
              Подача новых участков, мм/мин{" "}
              <NumberField
                value={state.feedMmMin}
                onCommit={(raw) => dispatch({ type: "setFeedMmMin", raw })}
                step={60}
                min={1}
              />
            </label>
            <button
              type="button"
              onClick={() => dispatch({ type: "applyFeedToAllSegments" })}
              disabled={state.segments.length === 0}
              title="Переписывает подачу всех нарисованных участков значением поля — в том числе тех, у которых подачу правили по отдельности."
            >
              Применить ко всем участкам
            </button>
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
          <section style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <h2 style={{ fontSize: "1rem", margin: 0 }}>Файл проекта</h2>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" onClick={() => void handleSave()}>
                Сохранить
              </button>
              <button type="button" onClick={() => void handleOpen()}>
                Открыть
              </button>
            </div>
            {projectMessage !== null && (
              <p
                style={{
                  margin: 0,
                  fontSize: "0.85rem",
                  color: projectMessage.isError ? "#b00" : "#555",
                  wordBreak: "break-all",
                }}
              >
                {projectMessage.text}
              </p>
            )}
          </section>
          <section style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <h2 style={{ fontSize: "1rem", margin: 0 }}>Генерация</h2>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button type="button" onClick={handleGenerate}>Сгенерировать</button>
              <button
                type="button"
                onClick={() => void handleExport()}
                disabled={eligibility.kind !== "eligible"}
              >
                Экспорт…
              </button>
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                disabled={previewScene === null}
                title={previewScene === null ? "Предпросмотр появится после успешной генерации" : undefined}
              >
                Предпросмотр движения…
              </button>
            </div>
            {generation !== null && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.1rem",
                  fontFamily: "monospace",
                  fontSize: "0.8rem",
                }}
              >
                {generationLogLines(generation).map((logLine, i) => (
                  <div
                    key={i}
                    style={{
                      color:
                      logLine.kind === "failed" || logLine.kind === "blocked"
                        ? "#b42318"
                        : "#555",
                      wordBreak: "break-word",
                    }}
                  >
                    {logLine.kind === "ok" ? "✓ " : logLine.kind === "failed" ? "✗ " : ""}
                    {logLine.text}
                  </div>
                ))}
              </div>
            )}
            {eligibility.kind === "stale" && (
              <p style={{ margin: 0, color: "#888", fontSize: "0.85rem" }}>
                {eligibility.notice}
              </p>
            )}
            {exportMessage !== null && (
              <p
                style={{
                  margin: 0,
                  fontSize: "0.85rem",
                  color: exportMessage.isError ? "#b00" : "#555",
                  wordBreak: "break-all",
                }}
              >
                {exportMessage.text}
              </p>
            )}
          </section>
          <p style={{ margin: 0, color: "#888", fontSize: "0.85rem" }}>
            Колесо мыши масштабирует вид (якорь — курсор), средняя кнопка перемещает, «Вписать зону» показывает всю зону достижимости, правая кнопка мыши отменяет незавершённый элемент.
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
                    {segment.kind === "point" && (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "0.5rem",
                          fontFamily: "system-ui, sans-serif",
                          marginTop: "0.15rem",
                        }}
                      >
                        Тип перемещения:{" "}
                        {(["LIN", "PTP"] as const).map((motionType) => (
                          <label key={motionType} style={rowStyle}>
                            <input
                              type="radio"
                              name={`motionType-${i}`}
                              value={motionType}
                              checked={segment.motionType === motionType}
                              onChange={() =>
                                dispatch({ type: "setSegmentMotionType", index: i, motionType })
                              }
                            />
                            {motionTypeLabel(motionType)}
                          </label>
                        ))}
                      </div>
                    )}
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
                );
              })}
            </ol>
          </section>
        </aside>

        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <div
            style={{ display: "flex", gap: "0.25rem", padding: "0.3rem 1rem", borderBottom: "1px solid #ddd", alignItems: "center" }}
          >
            <button
              type="button"
              onClick={() => setView("drawing")}
              aria-pressed={view === "drawing"}
              style={view === "drawing" ? activeTabStyle : tabStyle}
            >
              Чертёж
            </button>
            <button
              type="button"
              onClick={() => setView("charts")}
              disabled={charts === null}
              aria-pressed={view === "charts"}
              title={charts === null ? "Графики появятся после успешной генерации" : undefined}
              style={view === "charts" ? activeTabStyle : tabStyle}
            >
              Графики
            </button>
          </div>
          {/* The editor's latest rejection (e.g. an impossible Arc),
              visible in both views: drawing interactions through the
              sidebar stay available while «Графики» is open. */}
          {state.error !== null && (
            <div style={{ padding: "0.3rem 1rem", fontFamily: "monospace", fontSize: "0.9rem", color: "#b42318" }}>
              {state.error}
            </div>
          )}
          {view === "charts" && charts !== null ? (
            <ChartsView charts={charts} />
          ) : (
            <>
              <Canvas
                plane={state.plane}
                segments={state.segments}
                home={state.home}
                draft={draftPreviewOf(state)}
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
            </>
          )}
        </div>
      </div>
      {previewOpen && previewScene !== null && generation !== null && generation.kind === "ok" && (
        <MotionPreviewDialog
          scene={previewScene}
          durationMs={generation.result.plan.durationMs}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </main>
  );
}

/** Fieldset look for the tool panels. */
const fieldsetStyle = { border: "1px solid #ddd", borderRadius: 4, margin: 0, padding: "0.5rem", display: "flex", flexDirection: "column", gap: "0.25rem" } as const;

/** Look of an inactive main-area view tab. */
const tabStyle = { padding: "0.2rem 0.75rem", border: "1px solid #ddd", borderRadius: 4, background: "#fff", color: "#444" } as const;

/** Look of the active main-area view tab. */
const activeTabStyle = { ...tabStyle, background: "#eef3fb", borderColor: "#7a9cc4", color: "#1a1a1a" } as const;

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
      return `Точка (${formatVec3(segment.target)}), ${motionTypeLabel(segment.motionType)}, ${mmSToMmMin(segment.feed).toFixed(0)} мм/мин`;
  }
}

/** The Russian UI label of a Motion Type (GLOSSARY.md): LIN по прямой, PTP в точку. */
function motionTypeLabel(motionType: MotionType): string {
  return motionType === "LIN" ? "LIN — по прямой" : "PTP — в точку";
}
