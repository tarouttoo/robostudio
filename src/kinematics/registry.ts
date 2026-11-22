import {
  createMiKoMiniModel,
  type MiKoMiniRobotConfig,
} from "./miko-mini";
import type { RobotModel } from "./robot-model";

/**
 * Configuration for any registered Robot Model. Adding robot #2 means a
 * new config kind plus, at most, a solver — no registry changes for
 * callers (ADR 0008).
 */
export type RobotModelConfig = MiKoMiniRobotConfig;

/** The result of {@link createRobotRegistry}. */
export type RegistryResult =
  | { readonly status: "ok"; readonly registry: RobotRegistry }
  | { readonly status: "invalid-config"; readonly problems: readonly string[] };

/** Resolves Robot Models by id from validated configuration. */
export interface RobotRegistry {
  /**
   * Resolves a Robot Model by its configuration id.
   * @returns the model, or `undefined` when the id is not registered.
   */
  resolve(id: string): RobotModel | undefined;
}

/**
 * Validates the given Robot Model configurations and builds a registry
 * that resolves models by id. Configuration problems are reported as
 * named problems up front (fail fast on load), never at resolve time.
 */
export function createRobotRegistry(configs: readonly RobotModelConfig[]): RegistryResult {
  const problems: string[] = [];
  const models = new Map<string, RobotModel>();
  // Track every id seen, not only successfully built models, so a
  // duplicate is reported no matter how the earlier config failed.
  const seen = new Set<string>();

  for (const config of configs) {
    if (seen.has(config.id)) {
      problems.push(`duplicate model id "${config.id}"`);
      continue;
    }
    seen.add(config.id);
    if (config.kind !== "miko-mini") {
      problems.push(`unsupported model kind "${String(config.kind)}" for id "${config.id}"`);
      continue;
    }
    const built = createMiKoMiniModel(config);
    if (built.status === "invalid-config") {
      for (const problem of built.problems) {
        problems.push(`${config.id}: ${problem}`);
      }
      continue;
    }
    models.set(config.id, built.model);
  }

  if (problems.length > 0) return { status: "invalid-config", problems };
  return { status: "ok", registry: { resolve: (id) => models.get(id) } };
}
