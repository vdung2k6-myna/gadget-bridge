// Node reads the file itself, the way the service does; no .env beside the
// script is not an error, because every value can come from the command line.
try {
  process.loadEnvFile();
} catch {
  // No .env beside the service.
}

import { readFileSync } from "node:fs";
import { createOpusDecoder, encodeOpusFrames } from "../src/protocol/opus.js";
import { createListening, createVad, vadStep } from "../src/listening.js";
import { ENDPOINTER_DEFAULTS } from "../src/config.js";
import { frame } from "../src/protocol/framing.js";
import { encodeUtterance, openSession, resolveDevice } from "./device-turn.js";

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
 * The turn itself lives in `scripts/device-turn.ts`, so the soak mode of
 * `scripts/load-test.ts` runs the same one.
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const location = await resolveDevice(options);
  console.log(`device  ${options.device}`);
  console.log(`socket  ${location.url}`);

  const packets = encodeUtterance(readFileSync(options.audio));

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
        `median ${Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0)}`
    );
  }

  const session = await openSession(options.device, location);
  const result = await session.turn(packets, {
    timeoutMs: options.timeoutMs,
    onSent: (frames) =>
      console.log(`sent    ${frames} frames (${((frames * 60) / 1000).toFixed(1)} s)`),
  });

  if (result.timedOut) {
    console.log("no reply: timed out waiting for the reply");
  }

  console.log(`reply   ${result.audioFrames} audio frames (${((result.audioFrames * 60) / 1000).toFixed(1)} s)`);
  console.log(`stt     ${result.transcript.length > 0 ? result.transcript.join(" / ") : "(none)"}`);

  await session.close();

  if (result.audioFrames === 0 || result.transcript.length === 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
