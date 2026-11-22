import { APP_NAME, APP_VERSION } from "../core/version";

/**
 * The renderer stub: the app shell the first real UI slices will replace
 * content in. Renders the product name and a Trajectory placeholder;
 * UI text is Russian per GLOSSARY.md.
 */
export function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "2rem" }}>
      <h1>{APP_NAME}</h1>
      <p>v{APP_VERSION}</p>
      <p>Здесь появится редактор траекторий: Траектория из Участков на рабочей плоскости.</p>
    </main>
  );
}
