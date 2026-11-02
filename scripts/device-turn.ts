/**
 * A gadget made of a WAV file, as a reusable session.
 *
 * It does what the firmware does, in the order the firmware does it: ask the OTA
 * endpoint for a socket address and a token, open the socket with both, exchange
 * the hello, open a listening window, and send a whole utterance as framed Opus.
 * What it does not do is play the answer — the reply's frames are counted rather
 * than decoded, because the question this answers is whether the turn happened,
 * not whether the speaker sounds right.
 *
 * `scripts/fake-device.ts` is the one-device probe built on this; the soak mode of
 * `scripts/load-test.ts` runs many of them. Keeping the turn here is what makes
 * the two measure the same thing.
 */

import { WebSocket } from "ws";
import { frame } from "../src/protocol/framing.js";
import { encodeOpusFrames } from "../src/protocol/opus.js";
import { parseWavAudio } from "../src/protocol/wav.js";

const DEVICE_RATE = 16_000;
const FRAME_MS = 60;

/** Where a device should connect, as its OTA answer named it. */
export interface DeviceLocation {
  url: string;
  token: string;
}

export interface DeviceAddressOptions {
  device: string;
  ota: string;
  /** Overrides the socket address the OTA answer carries. */
  bridge?: string | null;
}

interface OtaAnswer {
  websocket?: { url?: string; token?: string };
  activation?: { code?: string };
}

/**
 * Ask the OTA endpoint where this device should connect, and with what.
 *
 * An unclaimed device is reported rather than connected: its answer carries an
 * activation code, and the socket would not answer its turns.
 */
export async function resolveDevice(options: DeviceAddressOptions): Promise<DeviceLocation> {
  const ota = await fetch(options.ota, { headers: { "device-id": options.device } });
  if (!ota.ok) {
    throw new Error(`the OTA endpoint answered ${ota.status}`);
  }
  const answer = (await ota.json()) as OtaAnswer;
  if (answer.activation !== undefined) {
    throw new Error(
      `the device is not claimed yet: enter code ${answer.activation.code ?? "?"} in the console, then run this again`
    );
  }
  const url = options.bridge ?? answer.websocket?.url ?? "";
  const token = answer.websocket?.token ?? "";
  if (url === "" || token === "") {
    throw new Error("the OTA answer carried no socket address or no token");
  }
  return { url, token };
}

/**
 * One utterance: a moment of room tone, the file's speech, then the silence that
 * closes the window — the same three stretches `spoken-turn.test.ts` sends, with
 * real speech in the middle.
 */
export function utterance(wav: Buffer): Buffer {
  const audio = parseWavAudio(wav);
  let samples = toSamples(audio.pcm);
  if (audio.channels > 1) samples = downmix(samples, audio.channels);
  if (audio.sampleRate !== DEVICE_RATE) samples = resample(samples, audio.sampleRate, DEVICE_RATE);

  // A synthesised sentence leaves the gateway at line level — measured at RMS 1400
  // for `voice=F1`, against the bridge's 7500 floor for a microphone. A person
  // speaking into the gadget is near full scale, so the utterance is brought there
  // rather than left quiet enough for the endpointer to call it furniture.
  samples = normalize(samples);

  const roomTone = Buffer.alloc(Math.round(DEVICE_RATE * 0.3) * 2);
  const speech = samplesToBuffer(samples);
  // 1.6 s, past the default silence that closes a window, so the endpointer sees
  // the end of the utterance rather than the socket going quiet.
  const closing = Buffer.alloc(Math.round(DEVICE_RATE * 1.6) * 2);
  return Buffer.concat([roomTone, speech, closing]);
}

/** The WAV as the framed Opus packets the firmware would send for it. */
export function encodeUtterance(wav: Buffer): Buffer[] {
  return encodeOpusFrames(utterance(wav), 1, {
    sampleRate: DEVICE_RATE,
    frameMs: FRAME_MS,
  });
}

export function toSamples(pcm: Buffer): Int16Array {
  const samples = new Int16Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
  return samples;
}

function samplesToBuffer(samples: Int16Array): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(samples[i]!, i * 2);
  return pcm;
}

/**
 * Bring a synthesised sentence to the level the board's microphone produces.
 *
 * The gateway returns line level — measured at RMS 1400 for `voice=F1` — while the
 * endpointer's floor is set for a close microphone, where the board measures 19–24k
 * RMS and its own echo 5–8k. Peak-normalising alone does not close that gap: the
 * sentence's crest factor is ~7.7, so scaling the peak to full scale leaves an RMS
 * around 3.6k and quiet frames under the gate. A tanh soft clip lifts the RMS while
 * keeping every sample inside full scale; the distortion it adds is well under what a
 * transcriber tolerates.
 */
function normalize(samples: Int16Array): Int16Array {
  const drive = 32;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.round(32_767 * Math.tanh((samples[i]! * drive) / 32_767));
  }
  return out;
}

function downmix(samples: Int16Array, channels: number): Int16Array {
  const frames = Math.floor(samples.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c]!;
    out[i] = Math.round(sum / channels);
  }
  return out;
}

/** Linear interpolation, the same arithmetic the bridge's own normaliser uses. */
function resample(samples: Int16Array, from: number, to: number): Int16Array {
  const ratio = to / from;
  const out = new Int16Array(Math.floor(samples.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const f = src - i0;
    out[i] = Math.round(samples[i0]! * (1 - f) + samples[i1]! * f);
  }
  return out;
}

export interface TurnOptions {
  /** How long to wait for the reply's `tts stop`. */
  timeoutMs: number;
  /** Called as the utterance finishes leaving, before the reply is awaited. */
  onSent?: (frames: number) => void;
}

/** What one turn produced, and how long its answer took to start. */
export interface TurnResult {
  sentFrames: number;
  audioFrames: number;
  transcript: string[];
  /** Last uplink frame to first downlink frame, or null when no audio came back. */
  firstAudioMs: number | null;
  /** True when the reply did not finish within the timeout. */
  timedOut: boolean;
}

export interface DeviceSession {
  /** Send one utterance and wait for the reply's `tts stop`. */
  turn(packets: readonly Buffer[], options: TurnOptions): Promise<TurnResult>;
  /** Close the socket and resolve with its close code. */
  close(): Promise<number>;
}

/**
 * Open a session for one device and exchange the hello.
 *
 * The session stays open across `turn` calls, which is what the firmware does: a
 * conversation is carried on one socket, and a soak that reconnected per turn
 * would measure a shape no gadget has.
 */
export async function openSession(device: string, location: DeviceLocation): Promise<DeviceSession> {
  const ws = new WebSocket(location.url, {
    headers: { "device-id": device, authorization: `Bearer ${location.token}` },
  });

  const messages: string[] = [];
  let audioFramesTotal = 0;
  let ttsStops = 0;
  let turnActive = false;
  let firstAudioAt: number | null = null;
  let socketError: Error | null = null;

  const closed = new Promise<number>((resolve) => {
    ws.on("close", (code, reason) => {
      if (process.env.FAKE_DEVICE_DEBUG) console.log(`closed  ${code} ${reason.toString()}`);
      resolve(code);
    });
  });
  const failure = new Promise<never>((_resolve, reject) => ws.on("error", reject));

  ws.on("error", (error: Error) => {
    socketError = error;
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      audioFramesTotal += 1;
      if (turnActive && firstAudioAt === null) firstAudioAt = performance.now();
      return;
    }
    const text = data.toString("utf8");
    messages.push(text);
    const message = JSON.parse(text) as { type?: string; state?: string; text?: string; message?: string };
    if (process.env.FAKE_DEVICE_DEBUG) console.log(`recv    ${text}`);
    if (message.type === "stt" && message.text) console.log(`heard   ${message.text}`);
    if (message.type === "tts" && message.state === "sentence_start" && message.text) {
      console.log(`spoke   ${message.text}`);
    }
    if (message.type === "alert" && message.message) console.log(`alert   ${message.message}`);
    if (message.type === "tts" && message.state === "stop") ttsStops += 1;
  });

  await Promise.race([new Promise<void>((resolve) => ws.on("open", () => resolve())), failure]);

  // The bridge answers a hello with its own, and the downlink's format lives in it.
  ws.send(JSON.stringify({ type: "hello", version: 3, transport: "websocket" }));
  const hello = await waitFor(() => messages.some((text) => text.includes('"transport"')), 10_000, () => socketError);
  if (!hello) throw new Error("timed out waiting for the server hello");

  async function turn(packets: readonly Buffer[], options: TurnOptions): Promise<TurnResult> {
    const messageStart = messages.length;
    const audioStart = audioFramesTotal;
    const stopsStart = ttsStops;
    firstAudioAt = null;
    turnActive = true;

    ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
    for (const packet of packets) {
      ws.send(frame(packet, 3), { binary: true });
    }
    const lastSentAt = performance.now();
    options.onSent?.(packets.length);

    const arrived = await waitFor(() => ttsStops > stopsStart, options.timeoutMs, () => socketError);
    turnActive = false;

    const transcript = messages
      .slice(messageStart)
      .map((text) => JSON.parse(text) as { type?: string; text?: string })
      .filter((message) => message.type === "stt" && message.text)
      .map((message) => message.text as string);

    return {
      sentFrames: packets.length,
      audioFrames: audioFramesTotal - audioStart,
      transcript,
      firstAudioMs: firstAudioAt === null ? null : firstAudioAt - lastSentAt,
      timedOut: !arrived,
    };
  }

  async function close(): Promise<number> {
    ws.terminate();
    return closed;
  }

  return { turn, close };
}

/**
 * Poll for a condition, with a deadline.
 *
 * A socket error rejects rather than waiting out the deadline: the turn it
 * belonged to cannot finish, and a soak should count it as failed immediately.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  socketError: () => Error | null
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const error = socketError();
    if (error !== null) throw error;
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
