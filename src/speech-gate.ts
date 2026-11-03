/**
 * Whether a closed window holds a person's speech, before it costs a platform turn.
 *
 * The endpointer decides on level, and level cannot tell a voice from loud broadband
 * non-speech: on the pilot, noise windows peaked 1.7–4.8× their gate and the transcriber
 * named them `đi`, `ủa`, `điều đó`. The engine returns no confidence to threshold, so
 * the bridge asks the model the browser client already vendors — Silero VAD v5.1.2 — and
 * drops a window whose loudest frame is not speech.
 *
 * A missing or unreadable model is not fatal: it warns and leaves turns ungated, because
 * losing noise suppression is a smaller failure than a bridge that answers nobody.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";

import { warn } from "./log.js";

/** The pinned model, relative to this module: `src/` → repository root. */
const MODEL_URL = new URL("../models/vad/silero_vad.onnx", import.meta.url);
const CHECKSUM_URL = new URL("../models/vad/silero_vad.onnx.sha256", import.meta.url);

/** The contract the pinned file declares. */
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 512;
const STATE_LENGTH = 2 * 1 * 128;

export interface SpeechScore {
  /** The loudest frame's probability. A transient can peak here, so it is not the test. */
  max: number;
  mean: number;
  frames: number;
  /** Frames whose probability reached the caller's threshold — the frames that count. */
  strong: number;
}

export interface SpeechGate {
  score(samples: Int16Array, threshold?: number): Promise<SpeechScore>;
}

/** The SHA-256 the checksum file records, or null when it records none. */
function recordedSha256(text: string): string | null {
  for (const line of text.split("\n")) {
    const token = line.trim().split(/\s+/)[0] ?? "";
    if (/^[0-9a-f]{64}$/i.test(token)) return token.toLowerCase();
  }
  return null;
}

/** A WAV's 16-bit little-endian samples, without the container. */
export function samplesOf(pcm: Buffer): Int16Array {
  const samples = new Int16Array(Math.floor(pcm.length / 2));
  for (let index = 0; index < samples.length; index++) {
    samples[index] = pcm.readInt16LE(index * 2);
  }
  return samples;
}

/**
 * Load the pinned model, verify it, and return the scorer — or null, with one warning,
 * when it cannot be used.
 */
export async function loadSpeechGate(
  modelUrl: URL = MODEL_URL,
  checksumUrl: URL = CHECKSUM_URL
): Promise<SpeechGate | null> {
  try {
    const model = readFileSync(modelUrl);
    const expected = recordedSha256(readFileSync(checksumUrl, "utf8"));
    const actual = createHash("sha256").update(model).digest("hex");
    if (expected !== null && actual !== expected) {
      warn(
        `speech gate: ${modelUrl.pathname} does not match its recorded SHA-256 ` +
          `(${actual}); turns will not be gated`
      );
      return null;
    }

    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });

    return {
      async score(samples: Int16Array, threshold = 0.5): Promise<SpeechScore> {
        let state = new Float32Array(STATE_LENGTH);
        const frame = new Float32Array(FRAME_SAMPLES);
        let max = 0;
        let sum = 0;
        let frames = 0;
        let strong = 0;

        for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
          frame.fill(0);
          const count = Math.min(FRAME_SAMPLES, samples.length - offset);
          for (let index = 0; index < count; index++) {
            frame[index] = (samples[offset + index] ?? 0) / 32768;
          }

          const output = await session.run({
            input: new ort.Tensor("float32", frame, [1, FRAME_SAMPLES]),
            state: new ort.Tensor("float32", state, [2, 1, 128]),
            sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
          });

          const probability = Number(output.output!.data[0]);
          // Copied: the runtime's buffer belongs to it, and the next run may reuse it.
          state = new Float32Array(output.stateN!.data as Float32Array);
          max = Math.max(max, probability);
          sum += probability;
          frames += 1;
          if (probability >= threshold) strong += 1;
        }

        return { max, mean: frames === 0 ? 0 : sum / frames, frames, strong };
      },
    };
  } catch (error) {
    warn(
      `speech gate unavailable (${error instanceof Error ? error.message : String(error)}); ` +
        `turns will not be gated`
    );
    return null;
  }
}

let loaded: Promise<SpeechGate | null> | null = null;

/** The deployment's gate, loaded once. Null means it is unavailable and turns pass through. */
export function speechGate(): Promise<SpeechGate | null> {
  loaded ??= loadSpeechGate();
  return loaded;
}
