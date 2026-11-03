/**
 * The spoken calibration session: the gadget says each step, takes one sample in each,
 * and ends with the report — without an LLM or an operator.
 *
 * It is a state machine in the bridge rather than a runtime persona: the bridge already
 * owns the windows, the capture, the phase markers, the model and the report. The only
 * things it borrows are speech (the runtime's speech route, in the gadget's own voice)
 * and a transcript for each sample (the turn route with `speak=0`, recorded nowhere).
 */

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fold } from "../commands.js";
import { info } from "../log.js";
import type { TurnLanguage } from "../turn.js";
import { scoreCapture } from "./analyse.js";
import type { Capture, CapturedWindow } from "./capture.js";
import { endPhase, startPhase, type PhaseExpectation } from "./phases.js";
import { buildReport, type CalibrationReport } from "./report.js";

export type PhaseName = "quiet" | "normal" | "loud" | "soft" | "one-word";

const PHASES: ReadonlyArray<{ name: PhaseName; label: string; expect: PhaseExpectation }> = [
  { name: "quiet", label: "quiet", expect: "silence" },
  { name: "normal", label: "normal", expect: "speech" },
  { name: "loud", label: "loud", expect: "speech" },
  { name: "soft", label: "soft", expect: "speech" },
  { name: "one-word", label: "one-word", expect: "speech" },
];

/**
 * The quiet phase's fixed wait, and how long a speech phase collects windows before
 * choosing one. The room closes windows of its own; taking the first would make the
 * sample the room's, so the phase keeps the one its own gate likes best.
 */
const QUIET_MS = 30_000;
const SAMPLE_WINDOW_MS = 6_000;

/** A window below this probability is room, not a sample, even if it is the best heard. */
const SCORE_FLOOR = 0.2;

interface Texts {
  open: string;
  phase: Record<PhaseName, string>;
  summary: (report: CalibrationReport) => string;
  applied: (threshold: number, minFrames: number) => string;
  kept: string;
  noSeparate: string;
}

const TEXTS: Record<TurnLanguage, Texts> = {
  vietnamese: {
    open: "Đây là buổi hiệu chuẩn. Thiết bị có thể im lặng — đó chính là điều đang đo. Bạn cứ từ từ.",
    phase: {
      quiet: "Hãy giữ yên lặng khoảng ba mươi giây.",
      normal: "Bây giờ nói một câu bình thường.",
      loud: "Nói câu đó to hơn một chút.",
      soft: "Nói câu đó thật nhỏ, như từ cuối phòng.",
      "one-word": "Chỉ nói một từ, ví dụ ừ.",
    },
    summary: (report) => {
      const recommendation = report.recommendation;
      if (recommendation === null) return TEXTS.vietnamese.noSeparate;
      return `Hiệu chuẩn tách được từ ${recommendation.range.low} đến ${recommendation.range.high}. Đề xuất ${recommendation.threshold}. Áp dụng không?`;
    },
    applied: (threshold, minFrames) => `Đã áp dụng ngưỡng ${threshold} với ${minFrames} khung hình.`,
    kept: "Giữ nguyên thiết lập hiện tại.",
    noSeparate: "Buổi đo không tách được giọng nói khỏi phòng. Giữ nguyên thiết lập hiện tại.",
  },
  english: {
    open: "This is a calibration. The gadget may stay silent — that's what we're measuring. Take your time.",
    phase: {
      quiet: "Stay silent for about thirty seconds.",
      normal: "Say a normal sentence.",
      loud: "Say it a little louder.",
      soft: "Say it softly, as if from across the room.",
      "one-word": "Say just one word, like 'ừ'.",
    },
    summary: (report) => {
      const recommendation = report.recommendation;
      if (recommendation === null) return TEXTS.english.noSeparate;
      return `The capture separates from ${recommendation.range.low} to ${recommendation.range.high}. I recommend ${recommendation.threshold}. Apply it?`;
    },
    applied: (threshold, minFrames) => `Applied ${threshold} with ${minFrames} frames.`,
    kept: "Keeping the current setting.",
    noSeparate: "The capture does not separate speech from the room. Keeping the current setting.",
  },
};

const YES = new Set(["u", "ung", "co", "ok", "oke", "yes", "yeah", "dong y", "dung roi", "da vang"]);
const NO = new Set(["khong", "thoi", "no", "nope", "khong dong y"]);

export interface SessionDeps {
  language: TurnLanguage;
  dir: string;
  capture: Capture;
  /** Speak one instruction in the gadget's voice, and show it on the display. */
  speak(text: string): Promise<void>;
  /** The platform's transcript of one sample, recorded nowhere. */
  transcribe(wav: Buffer): Promise<string | null>;
  /** Record and use a measured pair. */
  apply(threshold: number, minFrames: number): void;
  notice(text: string): void;
  minFrames: number;
  wait?: (ms: number) => Promise<void>;
  quietMs?: number;
  /** How long a speech phase collects windows before taking the best one. */
  sampleWindowMs?: number;
  /** The probability below which the best window is still a miss. */
  scoreFloor?: number;
  /** The report, for a test that does not want to run the model; production uses the capture. */
  report?: (dir: string, minFrames: number) => Promise<CalibrationReport>;
}

export interface Session {
  start(): void;
  stop(reason: string): void;
  /** A window the endpointer closed while a sample is being collected, with the gate's score. */
  offer(wav: Buffer, captured: CapturedWindow | null, score?: number): void;
  active(): boolean;
}

interface Sample {
  wav: Buffer;
  captured: CapturedWindow | null;
  score: number;
}

export function createSession(deps: SessionDeps): Session {
  const wait =
    deps.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  const quietMs = deps.quietMs ?? QUIET_MS;
  const sampleWindowMs = deps.sampleWindowMs ?? SAMPLE_WINDOW_MS;
  const scoreFloor = deps.scoreFloor ?? SCORE_FLOOR;
  const texts = TEXTS[deps.language];

  let running = false;
  let stopped = false;
  let collecting = false;
  let best: Sample | null = null;

  function offer(wav: Buffer, captured: CapturedWindow | null, score = 0): void {
    // Only while this phase is collecting: a window the room closed between phases is
    // not this phase's sample, and a queued one would hand the next phase the room.
    if (!running || !collecting) return;
    const sample = { wav, captured, score };
    if (best === null || sample.score > best.score) best = sample;
  }

  /** Collect for a bounded stretch and take the window the gate liked best. */
  async function collect(ms: number): Promise<Sample | null> {
    collecting = true;
    best = null;
    try {
      await wait(ms);
    } finally {
      collecting = false;
    }
    const sample = best;
    best = null;
    return sample;
  }

  function stop(reason: string): void {
    if (!running) return;
    stopped = true;
    info(`calibration session stopping: ${reason}`);
    deps.notice(`calibration stopped: ${reason}`);
    collecting = false;
    best = null;
  }

  async function report(): Promise<CalibrationReport> {
    if (deps.report !== undefined) return await deps.report(deps.dir, deps.minFrames);
    const scored = await scoreCapture(deps.dir);
    const result = buildReport(scored, deps.minFrames);
    const path = join(deps.dir, "report.json");
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
    renameSync(temporary, path);
    info(`calibration report written to ${path}`);
    return result;
  }

  async function run(): Promise<void> {
    running = true;
    deps.capture.arm();
    try {
      await deps.speak(texts.open);
      for (const phase of PHASES) {
        if (stopped) break;
        startPhase(deps.dir, phase.label, phase.expect);
        try {
          await deps.speak(texts.phase[phase.name]);
          if (stopped) break;
          if (phase.name === "quiet") {
            await wait(quietMs);
          } else {
            const sample = await collect(sampleWindowMs);
            if (sample === null || sample.score < scoreFloor) {
              info(
                `calibration phase ${phase.label}: no sample above ${scoreFloor} within ${sampleWindowMs}ms`
              );
            } else {
              const said = await deps.transcribe(sample.wav);
              sample.captured?.setTranscript(said ?? "");
              info(`calibration sample ${phase.label}: ${JSON.stringify(said ?? "")}`);
            }
          }
        } finally {
          endPhase(deps.dir);
        }
      }

      if (stopped) return;

      const result = await report();
      deps.notice(texts.summary(result));
      await deps.speak(texts.summary(result));

      const recommendation = result.recommendation;
      if (recommendation !== null && !stopped) {
        const answer = await collect(sampleWindowMs);
        let accepted = false;
        if (answer !== null) {
          const said = await deps.transcribe(answer.wav);
          answer.captured?.setTranscript(said ?? "");
          accepted = isYes(said ?? "");
        }
        if (accepted) {
          deps.apply(recommendation.threshold, deps.minFrames);
          await deps.speak(texts.applied(recommendation.threshold, deps.minFrames));
        } else {
          deps.notice(texts.kept);
          await deps.speak(texts.kept);
        }
      }
    } catch (error) {
      deps.notice(
        `calibration ended: ${error instanceof Error ? error.message : String(error)}`
      );
      info(`calibration session failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      deps.capture.disarm("the calibration session ended");
      running = false;
      stopped = false;
    }
  }

  return {
    start() {
      if (running) return;
      void run();
    },
    stop,
    offer,
    active: () => running,
  };
}

/** A small yes/no vocabulary, folded the same way the command grammar folds. */
export function isYes(utterance: string): boolean {
  const folded = fold(utterance);
  if (folded === "") return false;
  if (YES.has(folded)) return true;
  // A short answer may arrive with a polite word or two around it.
  const words = folded.split(" ");
  return words.some((word) => YES.has(word)) && !words.some((word) => NO.has(word));
}
