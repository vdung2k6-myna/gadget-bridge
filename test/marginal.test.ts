import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { windowVerdict } from "../src/marginal.js";

/**
 * Whether a closed window's transcript is a person or noise the transcriber named.
 *
 * The numbers are the pilot board's own, from 2026-11-03: the noise windows that came
 * back as `đi` / `điều kiện` and the speech windows that were answered.
 */

const RULE = { marginalPeakRatio: 1.3, marginalMaxWords: 2 };
const window = (peak: number, gate: number) => ({ peak, gate, speechMs: 900 });

describe("a window's transcript", () => {
  it("drops a word from a window that barely cleared its gate", () => {
    const verdict = windowVerdict(window(5953, 5257), "đi", RULE);
    assert.equal(verdict.marginal, true);
    assert.equal(verdict.words, 1);
    assert.ok(Math.abs(verdict.ratio - 5953 / 5257) < 1e-9);
  });

  it("keeps a short answer that cleared the gate", () => {
    assert.equal(windowVerdict(window(10465, 6000), "đi", RULE).marginal, false);
  });

  it("keeps a sentence from a marginal window", () => {
    const verdict = windowVerdict(window(5500, 5000), "phá cho tụi nghe không.", RULE);
    assert.equal(verdict.words, 5);
    assert.equal(verdict.marginal, false);
  });

  it("drops a two-word command from a marginal window, before it could be matched", () => {
    assert.equal(windowVerdict(window(5200, 5000), "dừng lại", RULE).marginal, true);
  });

  it("treats an empty transcript as marginal", () => {
    assert.equal(windowVerdict(window(5100, 5000), "   ", RULE).marginal, true);
  });

  it("does not divide by a gate of zero", () => {
    const verdict = windowVerdict(window(1, 0), "đi", RULE);
    assert.equal(Number.isFinite(verdict.ratio), false);
    assert.equal(verdict.marginal, false, "an unjudged window is not dropped by arithmetic");
  });
});
