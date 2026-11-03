/**
 * The speech gate's effective threshold, per device, over a deployment default.
 *
 * A measurement describes a room and a microphone; one bridge can serve several gadgets in
 * different places. The state file therefore holds a default (seeded with the configured
 * values at first registration) and a map of values applied from a particular device's own
 * session. A device with an entry uses it; every other device uses the default. Deleting an
 * entry returns that device to the default.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { BridgeConfig } from "../config.js";
import { info, warn } from "../log.js";

export interface GateSettings {
  probMin: number;
  minFrames: number;
}

/** The mutable pair one connection uses for its lifetime. */
export type DeviceGate = GateSettings;

export interface GateState {
  /** Where applied values live, or "" when no state file is configured. */
  path: string;
  /** The pair this device uses: its own entry, or the default. */
  forDevice(deviceId: string): DeviceGate;
  /** Record a measured pair for this device and return the pair to use now. */
  applyFor(deviceId: string, threshold: number, minFrames: number): DeviceGate;
}

export type GateStateConfig = Pick<
  BridgeConfig,
  "speechProbMin" | "speechMinFrames" | "calibrationStatePath" | "calibrationMode"
>;

interface StoredState {
  default: GateSettings;
  devices: Record<string, GateSettings & { appliedAt?: string }>;
}

export function loadGateState(config: GateStateConfig): GateState {
  const environment: GateSettings = {
    probMin: config.speechProbMin,
    minFrames: config.speechMinFrames,
  };
  const path = config.calibrationStatePath;
  if (path === "") {
    const fallback = { ...environment };
    return {
      path: "",
      forDevice: () => fallback,
      applyFor: () => fallback,
    };
  }

  const stored = readState(path);
  let state: StoredState;
  if (stored !== null) {
    state = stored;
    info(
      `calibration state: default ${state.default.probMin} with ${state.default.minFrames} frame(s), ` +
        `${Object.keys(state.devices).length} device(s), from ${path}`
    );
  } else {
    state = { default: { ...environment }, devices: {} };
    if (config.calibrationMode !== "off") {
      if (writeState(path, state)) {
        info(
          `calibration state seeded: default ${environment.probMin} with ${environment.minFrames} frame(s) in ${path}`
        );
      } else {
        warn(`calibration state could not be seeded in ${path}; the configured defaults are in use`);
      }
    }
  }

  const logged = new Set<string>();
  const pairFor = (deviceId: string): GateSettings => {
    const own = state.devices[deviceId];
    if (own === undefined) return { ...state.default };
    const key = `${deviceId}:${own.probMin}:${own.minFrames}`;
    if (!logged.has(key)) {
      logged.add(key);
      info(
        `calibration state: device ${deviceId} uses ${own.probMin} with ${own.minFrames} frame(s)`
      );
    }
    return { probMin: own.probMin, minFrames: own.minFrames };
  };

  return {
    path,
    forDevice: (deviceId) => pairFor(deviceId),
    applyFor(deviceId, threshold, minFrames) {
      state.devices[deviceId] = { probMin: threshold, minFrames, appliedAt: new Date().toISOString() };
      writeState(path, state);
      info(
        `calibration applied for ${deviceId}: ${threshold} with ${minFrames} frame(s), written to ${path}`
      );
      return { probMin: threshold, minFrames };
    },
  };
}

function readState(path: string): StoredState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;

  const usable = (pair: unknown): GateSettings | null => {
    if (pair === null || typeof pair !== "object") return null;
    const candidate = pair as { threshold?: unknown; minFrames?: unknown };
    const threshold = Number(candidate.threshold);
    const minFrames = Number(candidate.minFrames);
    if (
      Number.isFinite(threshold) &&
      threshold > 0 &&
      threshold < 1 &&
      Number.isInteger(minFrames) &&
      minFrames >= 1
    ) {
      return { probMin: threshold, minFrames };
    }
    return null;
  };

  // The old single-pair file is the default; a device map added later still reads.
  const legacy = usable(value);
  if (legacy !== null && value["default"] === undefined) {
    return { default: legacy, devices: {} };
  }

  const fallback = usable(value["default"]);
  if (fallback === null) return null;

  const devices: StoredState["devices"] = {};
  const rawDevices = value["devices"];
  if (rawDevices !== null && typeof rawDevices === "object") {
    for (const [deviceId, entry] of Object.entries(rawDevices as Record<string, unknown>)) {
      const pair = usable(entry);
      if (pair === null) continue;
      const appliedAt =
        entry !== null && typeof entry === "object"
          ? (entry as { appliedAt?: unknown }).appliedAt
          : undefined;
      devices[deviceId] = {
        ...pair,
        ...(typeof appliedAt === "string" ? { appliedAt } : {}),
      };
    }
  }
  return { default: fallback, devices };
}

function writeState(path: string, state: StoredState): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(
        {
          default: { threshold: state.default.probMin, minFrames: state.default.minFrames },
          devices: Object.fromEntries(
            Object.entries(state.devices).map(([deviceId, pair]) => [
              deviceId,
              {
                threshold: pair.probMin,
                minFrames: pair.minFrames,
                ...(pair.appliedAt === undefined ? {} : { appliedAt: pair.appliedAt }),
              },
            ])
          ),
        },
        null,
        2
      )}\n`
    );
    renameSync(temporary, path);
    return true;
  } catch (error) {
    warn(
      `calibration state could not be written to ${path} (${error instanceof Error ? error.message : String(error)})`
    );
    return false;
  }
}
