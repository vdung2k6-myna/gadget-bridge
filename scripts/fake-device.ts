// Node reads the file itself, the way the service does; no .env beside the
// script is not an error, because every value can come from the command line.
try {
  process.loadEnvFile();
} catch {
  // No .env beside the service.
}

import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { frame } from "../src/protocol/framing.js";
import { createOpusDecoder, encodeOpusFrames } from "../src/protocol/opus.js";
import { createListening, createVad, vadDecision, vadStep } from "../src/listening.js";
import { ENDPOINTER_DEFAULTS } from "../src/config.js";
import { parseWavAudio } from "../src/protocol/wav.js";

/**
 * A gadget made of a WAV file, for a deployment whose boards are not at hand.
 *
 * It does what the firmware does, in the order the firmware does it: ask the OTA
 * endpoint for a socket address and a token, open the socket with both, exchange
 * the hello, open a listening window, and send a whole utterance as framed Opus.
 * What it does not do is play the answer — the reply's frames are counted rather
 * than decoded, because the question this answers is whether the turn happened,
 * not whether the speaker sounds right.
 *
 * It exists because a deployment can be verified up to the last inch without a
 * board: everything after the socket — the endpointer, transcription, the turn
 * request with its providers, the reply, the record — is reachable from here.
 *
 * Usage:
 *   npx tsx scripts/fake-device.ts \
 *     --device b8:1f:3f:4a:9b:01 \
 *     --ota https://gw.example.com/xiaozhi/ota/ \
 *     --audio speech.wav
 *
 * `--bridge` overrides the socket address the OTA answer carries, which is only
 * useful when the answer names a host this machine cannot route to.
 */

interface Options {
  device: string;
  ota: string;
  bridge: string | null;
  audio: string;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Options {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  const device = flag("device") ?? "";
  const ota = flag("ota") ?? "";
  const audio = flag("audio") ?? "";
  if (device === "" || ota === "" || audio === "") {
    throw new Error("--device, --ota and --audio are required");
  }
  return {
    device,
    ota,
    bridge: flag("bridge") ?? null,
    audio,
    // Generous: a CPU transcriber on a small host takes seconds per sentence, and
    // the turn is not done until its reply has been spoken.
    timeoutMs: Number(flag("timeout") ?? 180_000),
  };
}

/** The OTA answer, as the firmware reads it. */
interface OtaAnswer {
  websocket?: { url?: string; token?: string };
  activation?: { code?: string };
}

/**
 * One utterance: a moment of room tone, the file's speech, then the silence that
 * closes the window — the same three stretches `spoken-turn.test.ts` sends, with
 * real speech in the middle.
 */
function utterance(wav: Buffer): Buffer {
  const audio = parseWavAudio(wav);
  let samples = toSamples(audio.pcm);
  if (audio.channels > 1) samples = downmix(samples, audio.channels);
  if (audio.sampleRate !== 16_000) samples = resample(samples, audio.sampleRate, 16_000);

  // A synthesised sentence leaves the gateway at line level — measured at RMS 1400
  // for `voice=F1`, against the bridge's 7500 floor for a microphone. A person
  // speaking into the gadget is near full scale, so the utterance is brought there
  // rather than left quiet enough for the endpointer to call it furniture.
  samples = normalize(samples);

  const roomTone = Buffer.alloc(Math.round(16_000 * 0.3) * 2);
  const speech = samplesToBuffer(samples);
  // 1.6 s, past the default silence that closes a window, so the endpointer sees
  // the end of the utterance rather than the socket going quiet.
  const closing = Buffer.alloc(Math.round(16_000 * 1.6) * 2);
  return Buffer.concat([roomTone, speech, closing]);
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

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
  console.log(`device  ${options.device}`);
  console.log(`socket  ${url}`);

  const packets = encodeOpusFrames(utterance(readFileSync(options.audio)), 1, {
    sampleRate: 16_000,
    frameMs: 60,
  });

  if (process.env.FAKE_DEVICE_DEBUG) {
    // The same frames through the bridge's own endpointer, offline: whatever it says
    // here is what the server should have said, so a disagreement points at the
    // deployment's configuration rather than at the audio.
    const replay = createListening({
      framing: 3,
      frameMs: 60,
      deviceRate: 16_000,
      ...ENDPOINTER_DEFAULTS,
      vadMinRms: Number(process.env.FAKE_DEVICE_VAD_MIN_RMS ?? ENDPOINTER_DEFAULTS.vadMinRms),
    });
    replay.open();
    const verdicts: Record<string, number> = {};
    for (const packet of packets) {
      const verdict = replay.frame(frame(packet, 3));
      verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
    }
    replay.close();
    console.log(`offline endpointer  ${JSON.stringify(verdicts)}`);

    // The same walk with the state visible, for the case where the verdict above is
    // not the one expected.
    const config = {
      framing: 3,
      frameMs: 60,
      deviceRate: 16_000,
      ...ENDPOINTER_DEFAULTS,
      vadMinRms: Number(process.env.FAKE_DEVICE_VAD_MIN_RMS ?? ENDPOINTER_DEFAULTS.vadMinRms),
    } as const;
    const decoder2 = createOpusDecoder(16_000);
    const vad = createVad(Date.now());
    packets.forEach((packet, index) => {
      const samples = decoder2.decode(packet);
      let rms = 0;
      if (samples) for (const sample of samples) rms += sample * sample / samples.length;
      rms = Math.sqrt(rms);
      const voiced = vadStep(vad, rms, config);
      if (index % 10 === 0 || voiced !== (index > 5 && index < 28)) {
        console.log(
          `frame ${index} rms=${Math.round(rms)} voiced=${voiced} speech=${vad.speechMs} ` +
            `silence=${vad.silenceMs} gate=${Math.round(vad.gate)} floor=${Math.round(vad.floor)}`
        );
      }
    });
    decoder2.close();
  }

  if (process.env.FAKE_DEVICE_DEBUG) {
    // Measured through the bridge's own decoder, because the gate judges the samples
    // that decoder produces rather than the ones the encoder was handed.
    const decoder = createOpusDecoder(16_000);
    const levels = packets.map((packet) => {
      const samples = decoder.decode(packet);
      if (!samples) return 0;
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      return Math.sqrt(sum / samples.length);
    });
    decoder.close();
    const sorted = [...levels].sort((a, b) => a - b);
    console.log(
      `levels  max ${Math.round(sorted[sorted.length - 1] ?? 0)} ` +
        `median ${Math.round(sorted[sorted.length >> 1] ?? 0)}`
    );
  }

  const ws = new WebSocket(url, {
    headers: { "device-id": options.device, authorization: `Bearer ${token}` },
  });

  const messages: string[] = [];
  let audioFrames = 0;

  const heard = (predicate: (text: string) => boolean, what: string, ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const check = (): void => {
        if (messages.some(predicate)) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`timed out waiting for ${what}`));
        }
      };
      const timer = setInterval(check, 100);
      check();
    });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      audioFrames += 1;
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
  });

  const closed = new Promise<number>((resolve) =>
    ws.on("close", (code, reason) => {
      if (process.env.FAKE_DEVICE_DEBUG) console.log(`closed  ${code} ${reason.toString()}`);
      resolve(code);
    })
  );
  const failure = new Promise<never>((_resolve, reject) => ws.on("error", reject));

  await Promise.race([
    new Promise<void>((resolve) => ws.on("open", () => resolve())),
    failure,
  ]);

  // The bridge answers a hello with its own, and the downlink's format lives in it.
  ws.send(JSON.stringify({ type: "hello", version: 3, transport: "websocket" }));
  await heard((text) => text.includes('"transport"'), "the server hello", 10_000);

  ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
  for (const packet of packets) {
    ws.send(frame(packet, 3), { binary: true });
  }
  console.log(`sent    ${packets.length} frames (${((packets.length * 60) / 1000).toFixed(1)} s)`);

  // The turn is done when the reply has been spoken to its end; `tts stop` is the
  // last thing the bridge says about it.
  try {
    await heard((text) => text.includes('"tts"') && text.includes('"stop"'), "the reply", options.timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (error) {
    console.log(`no reply: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`reply   ${audioFrames} audio frames (${((audioFrames * 60) / 1000).toFixed(1)} s)`);
  const transcript = messages
    .map((text) => JSON.parse(text) as { type?: string; text?: string })
    .filter((message) => message.type === "stt" && message.text)
    .map((message) => message.text as string);
  console.log(`stt     ${transcript.length > 0 ? transcript.join(" / ") : "(none)"}`);

  ws.terminate();
  await closed.catch(() => 0);

  if (audioFrames === 0 || transcript.length === 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
