/**
 * The calibration tools, as an MCP server an LLM can drive.
 *
 * Started by `npm run mcp:calibrate`, over stdio. It reads a capture directory and says
 * what the windows in it separate on — it never writes the bridge's configuration,
 * applies a threshold, or restarts anything. Capture itself is the bridge's own switch
 * (`BRIDGE_CALIBRATION_DIR`); these tools are read-only over what it wrote, apart from
 * the phase markers the session records in the same directory.
 */

// Stdout is this process's protocol channel. The bridge's log module writes with
// `console.log`, and the speech gate warns through it when its model cannot load;
// both must land on stderr here or they corrupt the JSON-RPC stream.
console.log = console.error;

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { parseWavAudio } from "../protocol/wav.js";
import { loadSpeechGate, samplesOf } from "../speech-gate.js";
import { measureWindow } from "./measure.js";
import { endPhase, phaseFor, readPhases, startPhase } from "./phases.js";
import { buildReport } from "./report.js";
import type { ScoredWindow, ThresholdScore } from "./report.js";
import { readWindows } from "./windows.js";

/** A sweep broad enough to find a gap and fine enough to read it. */
const DEFAULT_THRESHOLDS = [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/** The deployment's shipped frame minimum, used when the caller does not say. */
const DEFAULT_MIN_FRAMES = 3;

const server = new McpServer({ name: "bridge-calibration", version: "0.1.0" });

server.registerTool(
  "calibration_phase_start",
  {
    title: "Start a calibration phase",
    description:
      "Open a labelled phase around what the person is about to do, and say whether speech " +
      "is expected in it. Windows captured in the phase belong to it by their timestamps. " +
      "One phase at a time.",
    inputSchema: {
      dir: z.string().describe("The capture directory named by BRIDGE_CALIBRATION_DIR"),
      label: z.string().describe('What the phase asks for, e.g. "quiet", "normal", "soft"'),
      expect: z
        .enum(["speech", "silence"])
        .describe("Whether the person is expected to speak during this phase"),
    },
  },
  async ({ dir, label, expect }) =>
    answer(() => {
      const phase = startPhase(dir, label, expect);
      return {
        started: new Date(phase.startedAt).toISOString(),
        label: phase.label,
        expect: phase.expect,
        next: "Ask the person to do the thing, wait for them to confirm, then end the phase.",
      };
    })
);

server.registerTool(
  "calibration_phase_end",
  {
    title: "End the open calibration phase",
    description: "Close the phase opened last, so later windows are not counted in it.",
    inputSchema: {
      dir: z.string().describe("The capture directory named by BRIDGE_CALIBRATION_DIR"),
    },
  },
  async ({ dir }) =>
    answer(() => {
      const phase = endPhase(dir);
      return {
        label: phase.label,
        expect: phase.expect,
        started: new Date(phase.startedAt).toISOString(),
        ended: phase.endedAt === null ? null : new Date(phase.endedAt).toISOString(),
      };
    })
);

server.registerTool(
  "calibration_list",
  {
    title: "List the windows in a capture",
    description:
      "Every window the bridge captured, with its sidecar's evidence, decision and transcript, " +
      "and the phase its capture time falls in. Unpaired files are named rather than skipped.",
    inputSchema: {
      dir: z.string().describe("The capture directory named by BRIDGE_CALIBRATION_DIR"),
    },
  },
  async ({ dir }) => answer(() => list(dir))
);

server.registerTool(
  "calibration_score",
  {
    title: "Score the windows at a threshold sweep",
    description:
      "Re-run the bridge's own speech model over each captured window at each threshold, and " +
      "report qualifying frames, peak probability, zero-crossing rate and band energies. " +
      "No verdict is applied — this is the evidence the report is built from.",
    inputSchema: {
      dir: z.string().describe("The capture directory named by BRIDGE_CALIBRATION_DIR"),
      thresholds: z
        .array(z.number().gt(0).lt(1))
        .optional()
        .describe(`Thresholds to score at; defaults to ${DEFAULT_THRESHOLDS.join(", ")}`),
    },
  },
  async ({ dir, thresholds }) =>
    answer(async () => {
      const scored = await score(dir, thresholds ?? DEFAULT_THRESHOLDS);
      return scored.map((entry) => ({
        stem: entry.window.stem,
        phase: entry.phase?.label ?? null,
        decision: entry.window.sidecar?.decision ?? null,
        transcript: entry.window.sidecar?.transcript ?? null,
        problem: entry.window.problem,
        audio:
          entry.window.wav === null
            ? null
            : (() => {
                const parsed = parseWavAudio(readFileSync(entry.window.wav));
                return measureWindow(samplesOf(parsed.pcm), parsed.sampleRate);
              })(),
        scores: entry.scores,
      }));
    })
);

server.registerTool(
  "calibration_report",
  {
    title: "Report what the capture separates",
    description:
      "Compare the speech phases against the silence phase at every threshold and recommend " +
      "one with its margin, or say the capture does not separate and name the overlap. The " +
      "recommendation is advice: nothing is applied.",
    inputSchema: {
      dir: z.string().describe("The capture directory named by BRIDGE_CALIBRATION_DIR"),
      thresholds: z
        .array(z.number().gt(0).lt(1))
        .optional()
        .describe(`Thresholds to score at; defaults to ${DEFAULT_THRESHOLDS.join(", ")}`),
      minFrames: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`The deployment's BRIDGE_SPEECH_MIN_FRAMES; defaults to ${DEFAULT_MIN_FRAMES}`),
    },
  },
  async ({ dir, thresholds, minFrames }) =>
    answer(async () => {
      const scored = await score(dir, thresholds ?? DEFAULT_THRESHOLDS);
      return buildReport(scored, minFrames ?? DEFAULT_MIN_FRAMES);
    })
);

server.registerPrompt(
  "calibration_session",
  {
    title: "Calibrate the speech gate",
    description: "Walk an operator through the labelled phases and report the threshold they separate on.",
  },
  async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "You are running a voice-calibration session for a gadget bridge. The gadget may not",
            "reply during this session: the silence is the measurement, not a fault. Say so at the",
            "start, and keep the operator calm — take your time, go one step at a time, and never",
            "rush them to the next step. If they say the gadget cannot hear them or ask whether it",
            "is working, explain that no reply is expected in a calibration and continue at their pace.",
            "",
            "First ask for the capture directory (the one BRIDGE_CALIBRATION_DIR names) and confirm",
            "the bridge is running with it. Then run these phases in order, one at a time: open the",
            "phase, ask for the thing, wait for the operator to confirm, close the phase. Before",
            "each phase, wait until any reply the gadget is speaking has finished — the bridge does",
            "not capture what it hears while it is playing.",
            "",
            '1. phase "quiet", expect silence — "Leave the room at its normal working noise, and stay',
            '   completely silent yourself — type your confirmation rather than speaking." Wait about',
            "   thirty seconds before closing it.",
            '2. phase "normal", expect speech — "Say a normal sentence at your usual distance."',
            '3. phase "loud", expect speech — "Say the same sentence a little louder."',
            '4. phase "soft", expect speech — "Say the same sentence softly, as if from across the room."',
            '5. phase "one-word", expect speech — "Say just one word, like \'ừ\'."',
            "",
            "When the last phase is closed, call calibration_report for the directory with the",
            "deployment's minimum frame count (default 3). Present which threshold separates the",
            "phases, the margin, and any misses or noise words. Say plainly that the recommendation",
            "is advice: changing BRIDGE_SPEECH_PROB_MIN and BRIDGE_SPEECH_MIN_FRAMES is the",
            "operator's step. Do not change any configuration.",
          ].join("\n"),
        },
      },
    ],
  })
);

/** Every handler's answer, with a failure turned into a result rather than a crash. */
async function answer(
  work: () => unknown | Promise<unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const value = await work();
    return {
      content: [
        {
          type: "text",
          text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
  }
}

function list(dir: string): unknown {
  const phases = readPhases(dir);
  return {
    phases,
    windows: readWindows(dir).map((window) => ({
      stem: window.stem,
      capturedAt: window.at === null ? null : new Date(window.at).toISOString(),
      phase: phaseFor(window.at, phases)?.label ?? null,
      decision: window.sidecar?.decision ?? null,
      transcript: window.sidecar?.transcript ?? null,
      gate: window.sidecar?.gate ?? null,
      window: window.sidecar?.window ?? null,
      problem: window.problem,
    })),
  };
}

/**
 * Score every window at every threshold.
 *
 * The model is asked once per threshold rather than once per window: the strong-frame
 * count is what a threshold decides, and the model's per-frame probabilities are not
 * exposed by its contract. A capture is tens of windows, so the repeats are cheap.
 */
async function score(dir: string, thresholds: number[]): Promise<ScoredWindow[]> {
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
      scores.push({
        threshold,
        strong: result.strong,
        frames: result.frames,
        max: result.max,
      });
    }
    scored.push({ window, phase, scores });
  }
  return scored;
}

/** The transport is stdio; a client starts this process and speaks JSON-RPC to it. */
async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
