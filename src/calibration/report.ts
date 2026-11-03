/**
 * The calibration report: what the capture says about the threshold it was taken for.
 *
 * The populations are the phases' own declarations — windows captured while speech was
 * expected against windows captured while silence was expected — and not the gate's
 * decisions. Labeling by what the gate did would let the measurement assume its
 * conclusion. Every threshold in the sweep is scored against those populations, and a
 * recommendation is made only where one actually separates them; otherwise the report
 * names the overlap, which is the finding.
 */

import type { Phase, PhaseExpectation } from "./phases.js";
import type { CapturedWindow } from "./windows.js";

/** One window's gate result at one threshold. */
export interface ThresholdScore {
  threshold: number;
  strong: number;
  frames: number;
  max: number;
}

export interface ScoredWindow {
  window: CapturedWindow;
  phase: Phase | null;
  scores: ThresholdScore[];
}

export interface NamedWindow {
  stem: string;
  transcript: string | null;
  max: number;
  phase: string | null;
  problem: string | null;
}

export interface ThresholdRow {
  threshold: number;
  speechPassing: number;
  silencePassing: number;
  speechTotal: number;
  silenceTotal: number;
  separates: boolean;
}

export interface CalibrationReport {
  windows: number;
  phases: Array<{ label: string; expect: PhaseExpectation; count: number }>;
  unlabelled: number;
  problems: NamedWindow[];
  populations: { speech: number; silence: number; unconfirmed: number; noise: number };
  /** Which population the capture does not have, when it has none of one. */
  empty: "speech" | "silence" | "both" | null;
  thresholds: ThresholdRow[];
  recommendation: { threshold: number; margin: number } | null;
  /** A speech-phase window the platform did not transcribe: room, or a missed utterance. */
  unconfirmed: NamedWindow[];
  /** A silence-phase window the platform transcribed: noise the gate would have spoken. */
  noise: NamedWindow[];
  overlap: { speechLowest: NamedWindow[]; silenceHighest: NamedWindow[] } | null;
}

/**
 * Build the report from scored windows.
 *
 * `minFrames` is the deployment's `BRIDGE_SPEECH_MIN_FRAMES`: a window "passes" a
 * threshold when at least that many of its frames reach it, exactly as the live gate
 * decides. The recommendation is the lowest threshold that admits every speech window
 * and refuses every silence window; when none does, there is no recommendation.
 *
 * The speech population is the windows the platform transcribed, not every window a
 * speech phase happened to contain: the endpointer also closes on the room between
 * sentences, and counting that as speech makes every threshold fail. Silence-phase
 * windows are the room by construction; one the platform transcribed is noise, and is
 * named rather than counted as silence.
 */
export function buildReport(scored: readonly ScoredWindow[], minFrames: number): CalibrationReport {
  const transcribed = (entry: ScoredWindow): boolean =>
    (entry.window.sidecar?.transcript ?? "").trim() !== "";
  const inSilence = (entry: ScoredWindow): boolean => entry.phase?.expect === "silence";

  const noiseEntries = scored.filter((entry) => inSilence(entry) && transcribed(entry));
  const silence = scored.filter((entry) => inSilence(entry) && !transcribed(entry));
  const speech = scored.filter((entry) => !inSilence(entry) && transcribed(entry));
  const unconfirmed = scored.filter(
    (entry) => entry.phase?.expect === "speech" && !transcribed(entry)
  );
  const unlabelled = scored.length - speech.length - silence.length - unconfirmed.length - noiseEntries.length;
  const empty =
    speech.length === 0 && silence.length === 0
      ? "both"
      : speech.length === 0
        ? "speech"
        : silence.length === 0
          ? "silence"
          : null;

  const thresholds = [
    ...new Set(scored.flatMap((entry) => entry.scores.map((score) => score.threshold))),
  ].sort((left, right) => left - right);

  const rows: ThresholdRow[] = thresholds.map((threshold) => {
    const speechPassing = speech.filter((entry) => strongAt(entry, threshold) >= minFrames).length;
    const silencePassing = silence.filter((entry) => strongAt(entry, threshold) >= minFrames).length;
    return {
      threshold,
      speechPassing,
      silencePassing,
      speechTotal: speech.length,
      silenceTotal: silence.length,
      separates:
        speech.length > 0 &&
        silence.length > 0 &&
        speechPassing === speech.length &&
        silencePassing === 0,
    };
  });

  const separating = rows.find((row) => row.separates);
  const recommendation =
    separating === undefined || empty !== null
      ? null
      : {
          threshold: separating.threshold,
          margin: round(Math.min(...speech.map(maxOf)) - Math.max(...silence.map(maxOf))),
        };

  const phases: CalibrationReport["phases"] = [];
  for (const entry of scored) {
    if (entry.phase === null) continue;
    const existing = phases.find((phase) => phase.label === entry.phase!.label);
    if (existing === undefined) {
      phases.push({ label: entry.phase.label, expect: entry.phase.expect, count: 1 });
    } else {
      existing.count += 1;
    }
  }

  return {
    windows: scored.length,
    phases,
    unlabelled,
    problems: scored
      .filter((entry) => entry.window.problem !== null)
      .map((entry) => named(entry)),
    populations: {
      speech: speech.length,
      silence: silence.length,
      unconfirmed: unconfirmed.length,
      noise: noiseEntries.length,
    },
    empty,
    thresholds: rows,
    recommendation,
    unconfirmed: unconfirmed.map((entry) => named(entry)),
    noise: noiseEntries.map((entry) => named(entry)),
    overlap:
      recommendation !== null || empty !== null
        ? null
        : {
            speechLowest: [...speech]
              .sort((left, right) => maxOf(left) - maxOf(right))
              .slice(0, 5)
              .map((entry) => named(entry)),
            silenceHighest: [...silence]
              .sort((left, right) => maxOf(right) - maxOf(left))
              .slice(0, 5)
              .map((entry) => named(entry)),
          },
  };
}

function strongAt(entry: ScoredWindow, threshold: number): number {
  return entry.scores.find((score) => score.threshold === threshold)?.strong ?? 0;
}

function maxOf(entry: ScoredWindow): number {
  return Math.max(...entry.scores.map((score) => score.max), 0);
}

function named(entry: ScoredWindow): NamedWindow {
  return {
    stem: entry.window.stem,
    transcript: entry.window.sidecar?.transcript ?? null,
    max: round(maxOf(entry)),
    phase: entry.phase?.label ?? null,
    problem: entry.window.problem,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
