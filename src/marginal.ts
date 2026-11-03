/**
 * Whether a closed window's transcript is a person, or noise the transcriber named.
 *
 * The measured shape on the pilot boards (2026-11-03): noise windows peaked 1.05–1.30×
 * their gate and came back as a word or two (`đi`, `điều kiện`); speech windows peaked
 * 1.8–4.0× and were answered. Both halves are required, because a loud room can produce
 * a long noise phrase and a quiet person can say one word.
 */

import type { WindowStats } from "./listening.js";

export interface MarginalRule {
  /** The peak-to-gate multiple a short transcript must clear to be a turn. */
  marginalPeakRatio: number;
  /** The longest transcript a marginal window may carry and still be answered. */
  marginalMaxWords: number;
}

export interface WindowVerdict {
  /** Whether this transcript is noise rather than a turn. */
  marginal: boolean;
  /** Words in the transcript, whitespace-separated. */
  words: number;
  /** The window's peak over its gate. */
  ratio: number;
}

/** The rule, as one decision a caller can log and act on. */
export function windowVerdict(
  window: WindowStats,
  transcript: string,
  rule: MarginalRule
): WindowVerdict {
  const trimmed = transcript.trim();
  // Vietnamese writes words separated by spaces, so `điều kiện` is two and `đi` is one.
  const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
  const ratio = window.gate > 0 ? window.peak / window.gate : Number.POSITIVE_INFINITY;
  return {
    marginal: ratio < rule.marginalPeakRatio && words <= rule.marginalMaxWords,
    words,
    ratio,
  };
}
