import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { measureWindow } from "../src/calibration/measure.js";
import { endPhase, phaseFor, readPhases, startPhase } from "../src/calibration/phases.js";
import { buildReport } from "../src/calibration/report.js";
import type { ScoredWindow } from "../src/calibration/report.js";
import { readWindows } from "../src/calibration/windows.js";
import { loadSpeechGate, samplesOf } from "../src/speech-gate.js";
import { buildWav, parseWavAudio } from "../src/protocol/wav.js";

const SPEECH = fileURLToPath(new URL("./fixtures/speech-16k.wav", import.meta.url));
const MCP = fileURLToPath(new URL("../src/calibration/mcp.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "calibration-"));
}

/** One second of low-frequency tone — the room's rumble, as the pilot's captures had it. */
function rumble(): Buffer {
  const samples = new Int16Array(16_000);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = Math.round(6000 * Math.sin((2 * Math.PI * 100 * index) / 16_000));
  }
  return buildWav(samples, 16_000);
}

function sidecar(transcript: string | null, decision: "sent" | "dropped"): string {
  return JSON.stringify({
    capturedAt: "2026-11-03T00:00:00.000Z",
    decision,
    window: { peak: 5000, gate: 4100, speechMs: 700, seconds: 1 },
    gate: { threshold: 0.5, strong: 0, frames: 40, max: 0.1 },
    transcript,
  });
}

describe("calibration phases", () => {
  it("brackets windows by the time they were captured", () => {
    const dir = temporary();
    let now = 1_000;
    try {
      const quiet = startPhase(dir, "quiet", "silence", () => now);
      now = 2_000;
      endPhase(dir, () => now);
      now = 3_000;
      const normal = startPhase(dir, "normal", "speech", () => now);

      const phases = readPhases(dir);
      assert.deepEqual(
        phases.map((phase) => [phase.label, phase.expect, phase.startedAt, phase.endedAt]),
        [
          ["quiet", "silence", 1_000, 2_000],
          ["normal", "speech", 3_000, null],
        ]
      );
      assert.equal(phaseFor(1_500, phases)?.label, "quiet");
      assert.equal(phaseFor(2_500, phases), null);
      assert.equal(phaseFor(4_000, phases)?.label, "normal");
      assert.equal(quiet.endedAt, null, "the returned phase is the one that was opened");
      assert.equal(normal.label, "normal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a second open phase and an end with nothing open", () => {
    const dir = temporary();
    try {
      startPhase(dir, "quiet", "silence");
      assert.throws(() => startPhase(dir, "normal", "speech"), /still open/);
      endPhase(dir);
      assert.throws(() => endPhase(dir), /no phase is open/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reading a capture directory", () => {
  it("pairs the two halves and reports what it cannot pair", () => {
    const dir = temporary();
    try {
      writeFileSync(join(dir, "1000-s1-sent.wav"), rumble());
      writeFileSync(join(dir, "1000-s1-sent.json"), sidecar("xin chao", "sent"));
      writeFileSync(join(dir, "2000-s1-dropped.wav"), rumble());
      writeFileSync(join(dir, "3000-s1-orphan.json"), sidecar(null, "dropped"));

      const windows = readWindows(dir);
      assert.equal(windows.length, 3);
      assert.equal(windows[0]!.sidecar?.transcript, "xin chao");
      assert.equal(windows[0]!.problem, null);
      assert.equal(windows[1]!.problem, "audio with no sidecar");
      assert.equal(windows[2]!.problem, "a sidecar with no audio");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws for a directory that is not there", () => {
    assert.throws(() => readWindows(join(tmpdir(), "no-such-capture-xyz")));
  });
});

describe("measuring a window", () => {
  it("separates speech from rumble on band energy and zero crossings", () => {
    const speech = measureWindow(samplesOf(parseWavAudio(readFileSync(SPEECH)).pcm), 16_000);
    const room = measureWindow(samplesOf(parseWavAudio(rumble()).pcm), 16_000);

    const mid = (measure: ReturnType<typeof measureWindow>): number =>
      measure.bands.find((band) => band.frequency === 1200)?.db ?? -99;

    assert.ok(mid(speech) > mid(room), `speech ${mid(speech)} dB vs rumble ${mid(room)} dB`);
    assert.ok(
      speech.zeroCrossingRate > room.zeroCrossingRate,
      `speech zcr ${speech.zeroCrossingRate} vs rumble ${room.zeroCrossingRate}`
    );
  });
});

describe("scoring with the deployment's model", () => {
  it("clears many frames on speech and none on rumble at the shipped threshold", async () => {
    const gate = await loadSpeechGate();
    assert.ok(gate !== null, "the vendored model loads");
    const speech = await gate.score(samplesOf(parseWavAudio(readFileSync(SPEECH)).pcm), 0.5);
    const room = await gate.score(samplesOf(parseWavAudio(rumble()).pcm), 0.5);
    assert.ok(speech.strong >= 3, `speech cleared ${speech.strong}/${speech.frames} frames`);
    assert.equal(room.strong, 0, `rumble cleared ${room.strong}/${room.frames} frames`);
  });
});

describe("the calibration report", () => {
  function entry(
    stem: string,
    phase: string | null,
    expect: "speech" | "silence" | null,
    transcript: string | null,
    scores: Array<{ threshold: number; strong: number; max: number }>
  ): ScoredWindow {
    return {
      window: {
        stem,
        at: 0,
        wav: stem,
        problem: null,
        sidecar: {
          capturedAt: "2026-11-03T00:00:00.000Z",
          decision: transcript === null ? "dropped" : "sent",
          window: { peak: 0, gate: 0, speechMs: 0, seconds: 0 },
          gate: null,
          transcript,
        },
      },
      phase: phase === null || expect === null ? null : { label: phase, expect, startedAt: 0, endedAt: null },
      scores: scores.map((score) => ({ ...score, frames: 40 })),
    };
  }

  it("recommends the lowest threshold that separates speech from silence", () => {
    const report = buildReport(
      [
        entry("a", "normal", "speech", "xin chao", [
          { threshold: 0.3, strong: 9, max: 0.9 },
          { threshold: 0.5, strong: 8, max: 0.9 },
        ]),
        entry("b", "loud", "speech", "chao ban", [
          { threshold: 0.3, strong: 7, max: 0.95 },
          { threshold: 0.5, strong: 6, max: 0.95 },
        ]),
        entry("c", "quiet", "silence", null, [
          { threshold: 0.3, strong: 0, max: 0.2 },
          { threshold: 0.5, strong: 0, max: 0.2 },
        ]),
      ],
      3
    );

    assert.equal(report.recommendation?.threshold, 0.3);
    assert.equal(report.recommendation?.margin, 0.7);
    assert.deepEqual(report.misses, []);
    assert.equal(report.overlap, null);
  });

  it("says the capture does not separate when a silence window clears the threshold", () => {
    const report = buildReport(
      [
        entry("a", "normal", "speech", "xin chao", [
          { threshold: 0.5, strong: 8, max: 0.9 },
        ]),
        entry("c", "quiet", "silence", "đi", [
          { threshold: 0.5, strong: 4, max: 0.6 },
        ]),
      ],
      3
    );

    assert.equal(report.recommendation, null);
    assert.ok(report.overlap !== null);
    assert.equal(report.overlap.speechLowest[0]?.stem, "a");
    assert.equal(report.overlap.silenceHighest[0]?.stem, "c");
    assert.equal(report.noise[0]?.transcript, "đi");
  });

  it("names a speech phase window the platform did not transcribe", () => {
    const report = buildReport(
      [
        entry("a", "normal", "speech", "", [
          { threshold: 0.5, strong: 8, max: 0.9 },
        ]),
      ],
      3
    );
    assert.equal(report.misses[0]?.stem, "a");
    assert.equal(report.unlabelled, 0);
  });

  it("counts a window outside every phase as unlabelled", () => {
    const report = buildReport(
      [entry("a", null, null, null, [{ threshold: 0.5, strong: 0, max: 0.1 }])],
      3
    );
    assert.equal(report.unlabelled, 1);
    assert.equal(report.recommendation, null);
  });
});

describe("the calibration MCP server", () => {
  it("offers its tools and the guided session, and records a phase", async () => {
    const dir = temporary();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", MCP],
      cwd: ROOT,
      stderr: "pipe",
    });
    const client = new Client({ name: "calibration-test", version: "0.0.0" });
    try {
      await client.connect(transport);

      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        [
          "calibration_list",
          "calibration_phase_end",
          "calibration_phase_start",
          "calibration_report",
          "calibration_score",
        ]
      );

      const prompts = await client.listPrompts();
      assert.equal(prompts.prompts[0]?.name, "calibration_session");
      const prompt = await client.getPrompt({ name: "calibration_session" });
      const text = prompt.messages[0]?.content;
      assert.equal(text?.type, "text");
      const promptText = text?.type === "text" ? text.text : "";
      assert.match(promptText, /may not\s+reply/);
      assert.match(promptText, /keep the operator calm/);
      assert.match(promptText, /calibration_report/);

      const started = await client.callTool({
        name: "calibration_phase_start",
        arguments: { dir, label: "quiet", expect: "silence" },
      });
      assert.notEqual(started.isError, true);
      assert.equal(readPhases(dir)[0]?.label, "quiet");

      const listed = await client.callTool({ name: "calibration_list", arguments: { dir } });
      assert.notEqual(listed.isError, true);
      const content = listed.content as Array<{ type: string; text?: string }>;
      assert.equal(content[0]?.type, "text");
      assert.match(content[0]?.text ?? "", /"quiet"/);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
