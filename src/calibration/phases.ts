/**
 * The labels a calibration session puts on its windows.
 *
 * A phase brackets what the person was asked to do — the room quiet, a normal sentence,
 * a louder one, a soft one, a one-word answer — and says whether speech was expected in
 * it. The bridge knows nothing about any of this: a phase is a pair of timestamps in the
 * capture directory, and a window belongs to the phase its capture time falls inside.
 *
 * The file is append-only (`phases.jsonl`): a start line names the phase, a close line
 * with just an `endedAt` closes the most recent one. An operator can read it, and a
 * half-written line costs one phase rather than the file.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PhaseExpectation = "speech" | "silence";

export interface Phase {
  label: string;
  expect: PhaseExpectation;
  startedAt: number;
  /** Null while the phase is still open; a window after its start belongs to it. */
  endedAt: number | null;
}

export const PHASES_FILE = "phases.jsonl";

/** The phases written in `dir`, oldest first. A missing file is no phases, not an error. */
export function readPhases(dir: string): Phase[] {
  let text: string;
  try {
    text = readFileSync(join(dir, PHASES_FILE), "utf8");
  } catch {
    return [];
  }

  const phases: Phase[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof record["label"] === "string") {
      phases.push({
        label: record["label"],
        expect: record["expect"] === "speech" ? "speech" : "silence",
        startedAt: Number(record["startedAt"]),
        endedAt: null,
      });
    } else if (typeof record["endedAt"] === "number") {
      const open = [...phases].reverse().find((phase) => phase.endedAt === null);
      if (open !== undefined) open.endedAt = record["endedAt"];
    }
  }
  return phases;
}

/** Open a phase. Refused while another is open: two intervals that overlap label nothing. */
export function startPhase(
  dir: string,
  label: string,
  expect: PhaseExpectation,
  clock: () => number = Date.now
): Phase {
  const open = readPhases(dir).find((phase) => phase.endedAt === null);
  if (open !== undefined) {
    throw new Error(`the phase ${JSON.stringify(open.label)} is still open; end it first`);
  }
  const phase: Phase = { label, expect, startedAt: clock(), endedAt: null };
  appendFileSync(
    join(dir, PHASES_FILE),
    `${JSON.stringify({ label, expect, startedAt: phase.startedAt })}\n`
  );
  return phase;
}

/** Close the most recent open phase, or refuse when there is none. */
export function endPhase(dir: string, clock: () => number = Date.now): Phase {
  const open = [...readPhases(dir)].reverse().find((phase) => phase.endedAt === null);
  if (open === undefined) throw new Error("no phase is open");
  const endedAt = clock();
  appendFileSync(join(dir, PHASES_FILE), `${JSON.stringify({ endedAt })}\n`);
  open.endedAt = endedAt;
  return open;
}

/** The phase whose interval holds `at`, or null when it falls between phases. */
export function phaseFor(at: number | null, phases: readonly Phase[]): Phase | null {
  if (at === null) return null;
  for (const phase of phases) {
    if (at >= phase.startedAt && (phase.endedAt === null || at < phase.endedAt)) return phase;
  }
  return null;
}
