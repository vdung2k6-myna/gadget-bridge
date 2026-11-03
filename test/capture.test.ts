import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCapture } from "../src/calibration/capture.js";
import { buildWav } from "../src/protocol/wav.js";

/** One second of a tone, as a window the bridge would have decoded. */
function wav(seconds = 1): Buffer {
  const samples = new Int16Array(Math.round(16000 * seconds));
  for (let index = 0; index < samples.length; index++) {
    samples[index] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * index) / 16000));
  }
  return buildWav(samples, 16000);
}

const evidence = {
  sessionId: "s1",
  wav: wav(0.5),
  seconds: 0.5,
  window: { peak: 5300.4, gate: 4100.2, speechMs: 720 },
  gate: { threshold: 0.5, strong: 4, frames: 40, max: 0.62 },
  decision: "dropped" as const,
};

describe("calibration capture", () => {
  it("writes nothing when no directory is named", () => {
    assert.equal(createCapture(""), null);
  });

  it("writes the window and its evidence, then the transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-capture-"));
    try {
      const capture = createCapture(dir, () => 1_700_000_000_000);
      assert.ok(capture !== null);
      const written = capture.record(evidence);
      assert.ok(written !== null);

      const files = readdirSync(dir).sort();
      assert.deepEqual(files, [
        "1700000000000-s1-dropped.json",
        "1700000000000-s1-dropped.wav",
      ]);

      const sidecar = JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as Record<string, unknown>;
      assert.deepEqual(sidecar["window"], { peak: 5300, gate: 4100, speechMs: 720, seconds: 0.5 });
      assert.deepEqual(sidecar["gate"], { threshold: 0.5, strong: 4, frames: 40, max: 0.62 });
      assert.equal(sidecar["decision"], "dropped");
      assert.equal(sidecar["transcript"], null);

      written.setTranscript("xin chao");
      const updated = JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as Record<string, unknown>;
      assert.equal(updated["transcript"], "xin chao");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a session id that is a log token out of the file name", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-capture-"));
    try {
      const capture = createCapture(dir, () => 1);
      assert.ok(capture !== null);
      capture.record({ ...evidence, sessionId: "smw0/1 2" });
      assert.deepEqual(readdirSync(dir).sort(), [
        "1-smw0-1-2-dropped.json",
        "1-smw0-1-2-dropped.wav",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a null gate when the model was unavailable", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-capture-"));
    try {
      const capture = createCapture(dir, () => 2);
      assert.ok(capture !== null);
      capture.record({ ...evidence, gate: null, decision: "sent" });
      const sidecar = JSON.parse(
        readFileSync(join(dir, "2-s1-sent.json"), "utf8")
      ) as Record<string, unknown>;
      assert.equal(sidecar["gate"], null);
      assert.equal(sidecar["decision"], "sent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a write failure without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-capture-"));
    try {
      const capture = createCapture(dir, () => 3);
      assert.ok(capture !== null);
      chmodSync(dir, 0o500);
      assert.equal(capture.record(evidence), null);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
