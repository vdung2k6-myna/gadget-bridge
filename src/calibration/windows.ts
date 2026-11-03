/**
 * The capture directory as a list of windows.
 *
 * A capture is a pair of files per window — the WAV and the sidecar the bridge wrote
 * beside it — and this module is the only place that decides what a pair looks like.
 * It reports what it cannot pair rather than skipping it: a WAV without its evidence or
 * a sidecar without its audio is a capture an operator has to see, not an empty result.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** What the bridge wrote beside a window's WAV. */
export interface WindowSidecar {
  capturedAt: string;
  decision: "sent" | "dropped";
  window: { peak: number; gate: number; speechMs: number; seconds: number };
  gate: { threshold: number; strong: number; frames: number; max: number } | null;
  transcript: string | null;
}

/** One window in a capture directory, whether or not both its halves are there. */
export interface CapturedWindow {
  /** The file stem both halves share, which is also the window's identity in a report. */
  stem: string;
  /** Epoch milliseconds, from the start of the stem; null when it cannot be read. */
  at: number | null;
  wav: string | null;
  sidecar: WindowSidecar | null;
  /** What is wrong with this window, or null when it is a complete pair. */
  problem: string | null;
}

/**
 * Every window in `dir`, sorted by the time it was captured.
 *
 * An unreadable directory throws: "the directory is not there" and "the capture is
 * empty" are different answers and the caller has to be able to say which.
 */
export function readWindows(dir: string): CapturedWindow[] {
  const halves = new Map<string, { wav?: string; json?: string }>();
  for (const entry of readdirSync(dir)) {
    const match = /^(.*)\.(wav|json)$/.exec(entry);
    if (match === null) continue;
    const stem = match[1]!;
    const half = halves.get(stem) ?? {};
    if (match[2] === "wav") half.wav = join(dir, entry);
    else half.json = join(dir, entry);
    halves.set(stem, half);
  }

  const windows: CapturedWindow[] = [];
  for (const [stem, half] of halves) {
    const parsedAt = Number(stem.split("-")[0]);
    const at = Number.isFinite(parsedAt) ? parsedAt : null;
    if (half.wav === undefined) {
      windows.push({
        stem,
        at,
        wav: null,
        sidecar: readSidecar(half.json!),
        problem: "a sidecar with no audio",
      });
      continue;
    }
    const sidecar = half.json === undefined ? null : readSidecar(half.json);
    windows.push({
      stem,
      at,
      wav: half.wav,
      sidecar,
      problem:
        half.json === undefined
          ? "audio with no sidecar"
          : sidecar === null
            ? "the sidecar could not be read"
            : null,
    });
  }
  return windows.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
}

function readSidecar(path: string): WindowSidecar | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowSidecar>;
    if (
      typeof value.decision !== "string" ||
      typeof value.window !== "object" ||
      value.window === null
    ) {
      return null;
    }
    return value as WindowSidecar;
  } catch {
    return null;
  }
}
