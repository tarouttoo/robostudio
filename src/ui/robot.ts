/**
 * The v1 Robot Model every drawing view and every generation is
 * checked against: the default MiKo-mini configuration (ADR 0008).
 * Built once at module load; the shipped configuration is validated by
 * the kinematics tests, so a failure here is a programming error, not
 * a runtime condition.
 */

import { DEFAULT_MIKO_MINI_CONFIG, createMiKoMiniModel } from "../kinematics/miko-mini";
import type { RobotModel } from "../kinematics/robot-model";

export const MIKO_MINI: RobotModel = (() => {
  const built = createMiKoMiniModel(DEFAULT_MIKO_MINI_CONFIG);
  if (built.status !== "ok") {
    throw new Error(`invalid default MiKo-mini config: ${built.problems.join("; ")}`);
  }
  return built.model;
})();
