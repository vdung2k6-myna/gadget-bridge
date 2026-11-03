/**
 * Scoring a capture with the deployment's own model, for the report.
 *
 * Shared by the MCP server and the spoken session so both describe the same capture
 * the same way. The model is asked once per threshold rather than once per window:
 * the strong-frame count is what a threshold decides, and per-frame probabilities are
 * not part of the model's contract.
 */

import { readFileSync } from "node:fs";

import { parseWavAudio } from "../protocol/wav.js";
import { loadSpeechGate, samplesOf } from "../speech-gate.js";
import { phaseFor, readPhases } from "./phases.js";
import type { ScoredWindow, ThresholdScore } from "./report.js";
import { readWindows } from "./windows.js";

/** A sweep broad enough to find a gap and fine enough to read it. */
export const DEFAULT_THRESHOLDS = [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

export async function scoreCapture(
  dir: string,
  thresholds: readonly number[] = DEFAULT_THRESHOLDS
): Promise<ScoredWindow[]> {
  if (thresholds.length === 0) throw new Error("at least one threshold is required");
  const windows = readWindows(dir);
  const phases = readPhases(dir);
  const gate = await loadSpeechGate();
  if (gate === null) {
    throw new Error("the speech model is unavailable; the capture cannot be scored");
  }

  const scored: ScoredWindow[] = [];
  for (const window of windows) {
    const phase = phaseFor(window.at, phases);
    if (window.wav === null) {
      scored.push({ window, phase, scores: [] });
      continue;
    }
    const samples = samplesOf(parseWavAudio(readFileSync(window.wav)).pcm);
    const scores: ThresholdScore[] = [];
    for (const threshold of thresholds) {
      const result = await gate.score(samples, threshold);
      scores.push({ threshold, strong: result.strong, frames: result.frames, max: result.max });
    }
    scored.push({ window, phase, scores });
  }
  return scored;
}
