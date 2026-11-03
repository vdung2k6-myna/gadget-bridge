/**
 * The speech gate's effective threshold, and the file an applied calibration lives in.
 *
 * The value in use is always recorded: when calibration is enabled and the state file
 * is absent, it is seeded with the configured defaults (the deployment's first
 * registration), so an operator reading the file sees what the gate is doing rather
 * than inferring it from the environment. Applying a measurement rewrites the file and
 * the live value together; deleting it restores the environment's values at the next
 * start.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { BridgeConfig } from "../config.js";
import { info, warn } from "../log.js";

export interface GateSettings {
  probMin: number;
  minFrames: number;
}

export interface GateState {
  /** The mutable pair the live gate reads. */
  settings: GateSettings;
  /** Where applied values live, or "" when calibration is off. */
  path: string;
  /** Record and use a measured pair. */
  apply(threshold: number, minFrames: number): void;
}

export type GateStateConfig = Pick<
  BridgeConfig,
  "speechProbMin" | "speechMinFrames" | "calibrationStatePath" | "calibrationMode"
>;

export function loadGateState(config: GateStateConfig): GateState {
  const fallback: GateSettings = {
    probMin: config.speechProbMin,
    minFrames: config.speechMinFrames,
  };
  const path = config.calibrationStatePath;
  if (path === "" || config.calibrationMode === "off") {
    return { settings: { ...fallback }, path: "", apply: () => {} };
  }

  const stored = readState(path);
  const settings = stored ?? { ...fallback };
  if (stored === null) {
    writeState(path, fallback);
    info(
      `calibration state seeded: ${fallback.probMin} with ${fallback.minFrames} frame(s) in ${path}`
    );
  } else {
    info(
      `calibration state: using ${stored.probMin} with ${stored.minFrames} frame(s) from ${path}`
    );
  }

  return {
    settings,
    path,
    apply(threshold: number, minFrames: number) {
      writeState(path, { probMin: threshold, minFrames });
      settings.probMin = threshold;
      settings.minFrames = minFrames;
      info(
        `calibration applied: ${threshold} with ${minFrames} frame(s), written to ${path}`
      );
    },
  };
}

function readState(path: string): GateSettings | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const value = parsed as { threshold?: unknown; minFrames?: unknown };
  const threshold = Number(value.threshold);
  const minFrames = Number(value.minFrames);
  if (
    Number.isFinite(threshold) &&
    threshold > 0 &&
    threshold < 1 &&
    Number.isInteger(minFrames) &&
    minFrames >= 1
  ) {
    return { probMin: threshold, minFrames };
  }
  warn(`calibration state in ${path} is not a usable pair; the configured defaults are used`);
  return null;
}

function writeState(path: string, settings: GateSettings): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(
        { threshold: settings.probMin, minFrames: settings.minFrames, appliedAt: new Date().toISOString() },
        null,
        2
      )}\n`
    );
    renameSync(temporary, path);
  } catch (error) {
    warn(
      `calibration state could not be written to ${path} (${error instanceof Error ? error.message : String(error)})`
    );
  }
}
