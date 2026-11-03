import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCapture } from "../src/calibration/capture.js";
import type { CalibrationReport } from "../src/calibration/report.js";
import { createSession, isYes } from "../src/calibration/session.js";
import { loadGateState } from "../src/calibration/settings.js";

const report = (threshold: number | null): CalibrationReport => ({
  windows: 3,
  phases: [],
  unlabelled: 0,
  problems: [],
  populations: { speech: 1, silence: 1, unconfirmed: 0, noise: 0 },
  empty: null,
  thresholds: [],
  recommendation:
    threshold === null
      ? null
      : { threshold, range: { low: 0.2, high: 0.9 }, margin: 0.5 },
  unconfirmed: [],
  noise: [],
  overlap: null,
});

async function waitFor(predicate: () => boolean, what: string, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("the gate state file", () => {
  it("seeds the defaults, records an applied pair, and reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-state-"));
    const path = join(dir, "applied.json");
    try {
      const config = {
        speechProbMin: 0.5,
        speechMinFrames: 3,
        calibrationStatePath: path,
        calibrationMode: "arm" as const,
      };
      const state = loadGateState(config);
      assert.equal(state.settings.probMin, 0.5);
      assert.equal(state.settings.minFrames, 3);
      assert.ok(existsSync(path), "the defaults are recorded at first registration");

      state.apply(0.7, 4);
      assert.equal(state.settings.probMin, 0.7);
      assert.equal(state.settings.minFrames, 4);

      const again = loadGateState(config);
      assert.equal(again.settings.probMin, 0.7);
      assert.equal(again.settings.minFrames, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores an unusable file and falls back to the configured pair", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-state-"));
    const path = join(dir, "applied.json");
    try {
      const config = {
        speechProbMin: 0.5,
        speechMinFrames: 3,
        calibrationStatePath: path,
        calibrationMode: "arm" as const,
      };
      writeFileSync(path, "{\"threshold\": 2, \"minFrames\": 0}\n");
      const state = loadGateState(config);
      assert.equal(state.settings.probMin, 0.5);
      assert.equal(state.settings.minFrames, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the spoken session", () => {
  it("runs the phases, asks, and applies on a yes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-session-"));
    const capture = createCapture(dir, { armedAtStart: false });
    assert.ok(capture !== null);
    const spoken: string[] = [];
    const applied: Array<[number, number]> = [];
    const session = createSession({
      language: "english",
      dir,
      capture,
      minFrames: 3,
      quietMs: 5,
      phaseMs: 50,
      answerMs: 50,
      speak: async (text) => {
        spoken.push(text);
      },
      transcribe: async () => "yes",
      apply: (threshold, minFrames) => {
        applied.push([threshold, minFrames]);
      },
      notice: () => {},
      report: async () => report(0.5),
    });

    session.start();
    const offers = setInterval(() => {
      if (session.active()) session.offer(Buffer.alloc(2), null, 0.9);
    }, 5);
    try {
      await waitFor(() => !session.active() && applied.length > 0, "the session to apply");
    } finally {
      clearInterval(offers);
      rmSync(dir, { recursive: true, force: true });
    }

    assert.deepEqual(applied[0], [0.5, 3]);
    assert.ok(spoken.some((text) => text.includes("Stay silent")));
    assert.ok(spoken.some((text) => text.includes("Apply it?")));
    assert.ok(spoken.some((text) => text.includes("Applied 0.5")));
    assert.equal(capture.armed(), false, "the session disarms capture before it returns");
  });

  it("keeps the setting when the answer is not a yes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-session-"));
    const capture = createCapture(dir, { armedAtStart: false });
    assert.ok(capture !== null);
    const applied: Array<[number, number]> = [];
    const spoken: string[] = [];
    const session = createSession({
      language: "english",
      dir,
      capture,
      minFrames: 3,
      quietMs: 5,
      phaseMs: 50,
      answerMs: 50,
      speak: async (text) => {
        spoken.push(text);
      },
      transcribe: async () => "no",
      apply: (threshold, minFrames) => {
        applied.push([threshold, minFrames]);
      },
      notice: () => {},
      report: async () => report(0.5),
    });

    session.start();
    const offers = setInterval(() => {
      if (session.active()) session.offer(Buffer.alloc(2), null, 0.9);
    }, 5);
    try {
      await waitFor(() => !session.active(), "the session to end");
    } finally {
      clearInterval(offers);
      rmSync(dir, { recursive: true, force: true });
    }

    assert.deepEqual(applied, []);
    assert.ok(spoken.some((text) => text.includes("Keeping the current setting")));
  });

  it("does not ask when there is nothing to apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-session-"));
    const capture = createCapture(dir, { armedAtStart: false });
    assert.ok(capture !== null);
    const spoken: string[] = [];
    const session = createSession({
      language: "english",
      dir,
      capture,
      minFrames: 3,
      quietMs: 5,
      phaseMs: 20,
      answerMs: 20,
      speak: async (text) => {
        spoken.push(text);
      },
      transcribe: async () => "",
      apply: () => assert.fail("nothing should be applied"),
      notice: () => {},
      report: async () => report(null),
    });

    session.start();
    const offers = setInterval(() => {
      if (session.active()) session.offer(Buffer.alloc(2), null, 0.9);
    }, 5);
    try {
      await waitFor(() => !session.active(), "the session to end");
    } finally {
      clearInterval(offers);
      rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(spoken.some((text) => text.includes("does not separate")));
    assert.ok(!spoken.some((text) => text.includes("Apply it?")));
  });

  it("ends early on a stop and leaves capture off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-session-"));
    const capture = createCapture(dir, { armedAtStart: false });
    assert.ok(capture !== null);
    const session = createSession({
      language: "english",
      dir,
      capture,
      minFrames: 3,
      quietMs: 5,
      phaseMs: 20,
      answerMs: 20,
      speak: async () => {},
      transcribe: async () => null,
      apply: () => assert.fail("nothing should be applied"),
      notice: () => {},
      report: async () => report(0.5),
    });
    session.start();
    session.stop("stopped by the person");
    try {
      await waitFor(() => !session.active(), "the session to stop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(capture.armed(), false);
  });
});

describe("the yes/no answer", () => {
  it("reads a small yes and a small no, and nothing else", () => {
    for (const yes of ["ừ", "có", "đồng ý", "yes", "ok", "dạ vâng"]) {
      assert.equal(isYes(yes), true, yes);
    }
    for (const no of ["không", "thôi", "no", "", "giữ nguyên nhé"]) {
      assert.equal(isYes(no), false, no);
    }
  });
});
