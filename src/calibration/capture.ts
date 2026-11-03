/**
 * Calibration capture: the windows the bridge judges, with the evidence that decided them.
 *
 * Off unless `BRIDGE_CALIBRATION_DIR` names a directory. When it does, every window the
 * speech gate is asked about is written twice — the trimmed WAV the platform would have
 * been sent, and a sidecar holding what the endpointer and the gate saw, whether the
 * window was sent, and (once the platform answers) what it was transcribed as. That is
 * the whole measurement a threshold is chosen from, and it is why this is not a debug
 * flag: the sidecar is the part a later analysis cannot reconstruct.
 *
 * The directory holds the person's speech. It is for a calibration session and is
 * deleted afterwards; nothing here retains it beyond the files the operator removes.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { info, warn } from "../log.js";

/** What the endpointer and the speech gate decided about one window. */
export interface WindowEvidence {
  sessionId: string;
  wav: Buffer;
  seconds: number;
  window: { peak: number; gate: number; speechMs: number };
  /** The gate's score, or null when the model was unavailable and the turn passed ungated. */
  gate: { threshold: number; strong: number; frames: number; max: number } | null;
  decision: "sent" | "dropped";
}

/** A written window, whose transcript can be filled in once the platform has spoken. */
export interface CapturedWindow {
  setTranscript(text: string): void;
}

export interface Capture {
  readonly dir: string;
  record(evidence: WindowEvidence): CapturedWindow | null;
}

/**
 * The capture for this process, or null when the deployment names no directory.
 *
 * A directory that cannot be created disables capture with one warning rather than
 * refusing to start: losing the measurement is a smaller failure than a bridge that
 * answers nobody.
 */
export function createCapture(dir: string, clock: () => number = Date.now): Capture | null {
  if (dir === "") return null;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    warn(
      `calibration capture disabled: could not create ${dir} (${error instanceof Error ? error.message : String(error)})`
    );
    return null;
  }
  info(`calibration capture: ${dir}`);

  let failureReported = false;
  const failed = (doing: string, error: unknown): void => {
    if (failureReported) return;
    failureReported = true;
    warn(
      `calibration capture: ${doing} failed (${error instanceof Error ? error.message : String(error)}); ` +
        `turns are unaffected and this is reported once`
    );
  };

  return {
    dir,
    record(evidence) {
      const stem = `${clock()}-${sessionSlug(evidence.sessionId)}-${evidence.decision}`;
      const wavPath = join(dir, `${stem}.wav`);
      const jsonPath = join(dir, `${stem}.json`);
      const sidecar = {
        capturedAt: new Date(clock()).toISOString(),
        decision: evidence.decision,
        window: {
          peak: Math.round(evidence.window.peak),
          gate: Math.round(evidence.window.gate),
          speechMs: evidence.window.speechMs,
          seconds: evidence.seconds,
        },
        gate: evidence.gate,
        transcript: null as string | null,
      };

      try {
        writeFileSync(wavPath, evidence.wav);
        writeSidecar(jsonPath, sidecar);
      } catch (error) {
        failed(`writing ${jsonPath}`, error);
        return null;
      }

      return {
        setTranscript(text: string) {
          sidecar.transcript = text;
          try {
            writeSidecar(jsonPath, sidecar);
          } catch (error) {
            failed(`updating ${jsonPath}`, error);
          }
        },
      };
    },
  };
}

/** Written to a temporary file and renamed, so a reader never sees half a sidecar. */
function writeSidecar(path: string, sidecar: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(sidecar, null, 2)}\n`);
  renameSync(temporary, path);
}

/** A session id is a log token, not a file name: keep it to letters, digits and dashes. */
function sessionSlug(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}
