// Node reads the file itself, the way the service does; no .env beside the
// script is not an error, because every value can come from the command line.
try {
  process.loadEnvFile();
} catch {
  // No .env beside the service.
}
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { deriveToken, normalizeDeviceId } from "../src/credentials.js";
import { encodeUtterance, openSession, resolveDevice } from "./device-turn.js";

/**
 * A capacity probe, not a test suite: it drives the running services and reports
 * what came back.
 *
 * Three modes, because a deployment has three different ceilings:
 *
 *   runtime  — how many turns the runtime can answer at once. Each is the same
 *              request the bridge sends, text instead of audio and `speak=0`, so
 *              no transcription or synthesis is in the way: what is measured is
 *              the model slots (`OLLAMA_MAX_CONCURRENT_REQUESTS`) and the queue
 *              behind them.
 *
 *   bridge   — how many device sessions the bridge will hold. Each is a real
 *              WebSocket upgrade with the token the console would issue, then a
 *              hello and a wait. No audio is sent, so what is measured is
 *              connections, not turns.
 *
 *   soak     — what N sessions cost once frames are flowing. Each is a real
 *              device (claimed, with an agent) driven through full turns by
 *              `scripts/device-turn.ts`, so the bridge's Opus, endpointer and
 *              reply path are all exercised. Time-to-first-audio is measured from
 *              the last uplink frame.
 *
 * Usage:
 *   npx tsx scripts/load-test.ts runtime --count 12
 *   npx tsx scripts/load-test.ts bridge  --count 50
 *   npx tsx scripts/load-test.ts soak    --count 100 --turns 3 \
 *     --ota http://127.0.0.1:8003/xiaozhi/ota/ --audio speech.wav
 *
 * The defaults come from the bridge's own `.env` for the console, and from the
 * command line for the runtime (which the bridge no longer talks to directly).
 */

interface Options {
  mode: "runtime" | "bridge" | "soak";
  count: number;
  consoleUrl: string;
  consoleToken: string;
  runtimeUrl: string;
  runtimeToken: string;
  bridgeUrl: string;
  /** The soak's OTA endpoint and utterance; unused by the other modes. */
  ota: string;
  audio: string;
  turns: number;
  intervalMs: number;
  /** Every device id is this prefix plus a two-hex index. */
  devicePrefix: string;
  /** The soak uses the OTA answer's address unless this is set. */
  bridgeOverride: string | null;
  /** Spread the devices' first turns over one interval instead of starting together. */
  stagger: boolean;
  timeoutMs: number;
  /** An account's own model, sent the way the bridge sends it; empty means none. */
  llm: { baseUrl: string; model: string; apiKey: string; temperature: string } | null;
}

function parseArgs(argv: string[]): Options {
  const mode = argv[0] === "bridge" ? "bridge" : argv[0] === "soak" ? "soak" : "runtime";
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  const consoleUrl = flag("console") ?? process.env.BRIDGE_CONSOLE_URL ?? "";
  const consoleToken = flag("token") ?? process.env.BRIDGE_CONSOLE_TOKEN ?? "";
  // The soak resolves devices through the OTA endpoint, so the console is not on
  // its path; the other modes resolve directly and cannot work without it.
  if (mode !== "soak" && (consoleUrl === "" || consoleToken === "")) {
    throw new Error("the console is required: BRIDGE_CONSOLE_URL and BRIDGE_CONSOLE_TOKEN, or --console/--token");
  }
  const ota = flag("ota") ?? "";
  const audio = flag("audio") ?? "";
  if (mode === "soak" && (ota === "" || audio === "")) {
    throw new Error("soak mode needs --ota and --audio");
  }
  return {
    mode,
    count: Number(flag("count") ?? (mode === "runtime" ? 12 : 50)),
    consoleUrl,
    consoleToken,
    runtimeUrl: flag("runtime") ?? "http://127.0.0.1:4000",
    runtimeToken: flag("runtime-token") ?? process.env.RUNTIME_TOKEN ?? "",
    bridgeUrl: flag("bridge") ?? "ws://127.0.0.1:8001/xiaozhi/v1/",
    ota,
    audio,
    turns: Number(flag("turns") ?? 1),
    intervalMs: Number(flag("interval") ?? 25_000),
    devicePrefix: flag("device-prefix") ?? "aa:50:00:00:00:",
    bridgeOverride: flag("bridge") ?? null,
    stagger: argv.includes("--stagger"),
    timeoutMs: Number(flag("timeout") ?? 180_000),
    llm:
      flag("llm-url") === undefined
        ? null
        : {
            baseUrl: flag("llm-url")!,
            model: flag("llm-model") ?? "",
            apiKey: flag("llm-key") ?? "",
            temperature: flag("llm-temp") ?? "",
          },
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function summarise(label: string, durations: number[], failures: string[]): void {
  const ok = durations.length;
  console.log(`\n${label}`);
  console.log(`  succeeded  ${ok}`);
  console.log(`  failed     ${failures.length}`);
  if (ok > 0) {
    console.log(`  p50        ${percentile(durations, 0.5).toFixed(0)} ms`);
    console.log(`  p95        ${percentile(durations, 0.95).toFixed(0)} ms`);
    console.log(`  max        ${Math.max(...durations).toFixed(0)} ms`);
  }
  for (const failure of failures.slice(0, 10)) console.log(`  ! ${failure}`);
  if (failures.length > 10) console.log(`  … ${failures.length - 10} more`);
}

async function runtimeTurn(options: Options, index: number): Promise<number> {
  const started = performance.now();
  const form = new FormData();
  form.append("systemPrompt", "Trả lời thật ngắn, một câu.");
  form.append("language", "vietnamese");
  form.append("engine", "supertonic");
  form.append("answerMode", "generate");
  form.append("history", "[]");
  form.append("speak", "0");
  form.append("text", `Câu hỏi số ${index + 1}.`);
  if (options.llm !== null) {
    form.append("llmBaseUrl", options.llm.baseUrl);
    form.append("llmModel", options.llm.model);
    form.append("llmApiKey", options.llm.apiKey);
    if (options.llm.temperature !== "") form.append("llmTemperature", options.llm.temperature);
  }

  const response = await fetch(`${options.runtimeUrl}/api/voice-agent/stream`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.runtimeToken}` },
    body: form,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  // The turn is over when the stream is: consuming it is what waits for the model.
  const body = await response.text();
  if (!response.ok) throw new Error(`answered ${response.status}`);
  // A turn the runtime could not answer still arrives as HTTP 200 with an `error`
  // event, so the status alone would report a timeout as a success.
  if (/event:\s*error/.test(body)) throw new Error("the turn reported an error (a timeout behind the slot queue reads this way)");
  return performance.now() - started;
}

async function runtimeMode(options: Options): Promise<void> {
  if (options.runtimeToken === "") {
    throw new Error("runtime mode needs a runtime token: --runtime-token or RUNTIME_TOKEN");
  }
  console.log(
    `runtime: ${options.count} turns at once against ${options.runtimeUrl} ` +
      `(model: ${options.llm === null ? "the runtime default" : `${options.llm.model} at ${options.llm.baseUrl}`}; ` +
      `slots are OLLAMA_MAX_CONCURRENT_REQUESTS, the rest queue, and one waiting past the chat timeout fails)`
  );

  const durations: number[] = [];
  const failures: string[] = [];
  const started = performance.now();
  await Promise.all(
    Array.from({ length: options.count }, (_, index) =>
      runtimeTurn(options, index).then(
        (ms) => durations.push(ms),
        (error: unknown) => failures.push(error instanceof Error ? error.message : String(error))
      )
    )
  );
  summarise(`all ${options.count} turns (${(performance.now() - started).toFixed(0)} ms wall clock)`, durations, failures);
}

async function resolve(options: Options, deviceId: string): Promise<string> {
  const response = await fetch(`${options.consoleUrl}/api/bridge/resolve`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.consoleToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  if (!response.ok) throw new Error(`resolve answered ${response.status}`);
  const body = (await response.json()) as { secret?: unknown };
  if (typeof body.secret !== "string") throw new Error("the resolution carried no secret");
  return body.secret;
}

/** One session: upgrade, hello, wait for the server's hello, then let go. */
async function bridgeSession(options: Options, deviceId: string): Promise<number> {
  const started = performance.now();
  if (process.env.LOAD_TEST_DEBUG) console.error(`[debug] ${deviceId}: resolving`);
  const secret = await resolve(options, deviceId);
  if (process.env.LOAD_TEST_DEBUG) console.error(`[debug] ${deviceId}: resolved`);
  const token = deriveToken(secret, deviceId);

  const ws = new WebSocket(options.bridgeUrl, {
    headers: { "device-id": deviceId, authorization: `Bearer ${token}` },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no upgrade within 10 s")), 10_000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("unexpected-response", (_request, response) => {
        clearTimeout(timer);
        reject(new Error(`upgrade refused: ${response.statusCode}`));
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const hello = {
      type: "hello",
      version: 3,
      transport: "websocket",
      audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 },
      features: { mcp: false },
    };
    ws.send(JSON.stringify(hello));

    if (process.env.LOAD_TEST_DEBUG) console.error(`[debug] ${deviceId}: open, hello sent`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no server hello within 10 s")), 10_000);
      ws.on("message", (data: Buffer) => {
        const text = data.toString("utf8");
        if (text.includes('"transport"')) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on("close", () => {
        clearTimeout(timer);
        reject(new Error("closed before the server hello"));
      });
    });

    return performance.now() - started;
  } finally {
    ws.terminate();
  }
}

async function bridgeMode(options: Options): Promise<void> {
  console.log(
    `bridge: ${options.count} sessions against ${options.bridgeUrl}. ` +
      `An identifier nobody owns is resolved as unclaimed, which still yields the ` +
      `secret its token is derived from — so these are real upgrades with real tokens, ` +
      `and each leaves a pending claim in the console (they expire on CLAIM_APPROVAL_TTL_MS).`
  );

  // A fresh salt per run: the console rate-limits claim issuance per identifier,
  // so reusing the same ids would start refusing them on the second run.
  const salt = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  const ids = Array.from(
    { length: options.count },
    (_, index) => `aa:${salt.slice(0, 2)}:${salt.slice(2)}:00:00:${index.toString(16).padStart(2, "0")}`
  );

  const durations: number[] = [];
  const failures: string[] = [];
  const started = performance.now();
  await Promise.all(
    ids.map((deviceId) =>
      bridgeSession(options, deviceId).then(
        (ms) => durations.push(ms),
        (error: unknown) => failures.push(`${normalizeDeviceId(deviceId)}: ${error instanceof Error ? error.message : String(error)}`)
      )
    )
  );
  summarise(
    `all ${options.count} sessions (${(performance.now() - started).toFixed(0)} ms wall clock)`,
    durations,
    failures
  );
}

/** What one turn of one device produced, for the soak's summary. */
interface SoakTurn {
  deviceId: string;
  turn: number;
  firstAudioMs: number | null;
  audioFrames: number;
  transcript: number;
  timedOut: boolean;
  error: string | null;
}

function soakDeviceIds(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `${prefix}${index.toString(16).padStart(2, "0")}`
  );
}

function isAnswered(turn: SoakTurn): boolean {
  return turn.error === null && !turn.timedOut && turn.audioFrames > 0 && turn.transcript > 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function soakMode(options: Options): Promise<void> {
  console.log(
    `soak: ${options.count} device(s) x ${options.turns} turn(s), ${options.intervalMs} ms apart, ` +
      `OTA ${options.ota}${options.bridgeOverride === null ? "" : ` (socket forced to ${options.bridgeOverride})`}`
  );

  // Encoded once: every device sends the same utterance, and encoding it per
  // session would put the harness's own CPU in front of what it measures.
  const packets = encodeUtterance(readFileSync(options.audio));
  const ids = soakDeviceIds(options.devicePrefix, options.count);
  const outcomes: SoakTurn[] = [];
  const started = performance.now();

  await Promise.all(
    ids.map(async (deviceId, index) => {
      try {
        const location = await resolveDevice({
          device: deviceId,
          ota: options.ota,
          bridge: options.bridgeOverride,
        });
        const session = await openSession(deviceId, location);
        try {
          for (let turn = 0; turn < options.turns; turn++) {
            // Every session is opened first; a cadence run spaces the *turns*, not
            // the sockets, so the bridge holds 100 sessions either way and the two
            // runs differ only in when the frames arrive.
            if (turn === 0 && options.stagger) {
              await pause(Math.floor((index * options.intervalMs) / options.count));
            } else if (turn > 0) {
              await pause(options.intervalMs);
            }
            try {
              const result = await session.turn(packets, { timeoutMs: options.timeoutMs });
              outcomes.push({
                deviceId,
                turn,
                firstAudioMs: result.firstAudioMs,
                audioFrames: result.audioFrames,
                transcript: result.transcript.length,
                timedOut: result.timedOut,
                error: null,
              });
            } catch (error) {
              outcomes.push({
                deviceId,
                turn,
                firstAudioMs: null,
                audioFrames: 0,
                transcript: 0,
                timedOut: false,
                error: describeError(error),
              });
              break;
            }
          }
        } finally {
          await session.close().catch(() => 0);
        }
      } catch (error) {
        outcomes.push({
          deviceId,
          turn: 0,
          firstAudioMs: null,
          audioFrames: 0,
          transcript: 0,
          timedOut: false,
          error: describeError(error),
        });
      }
    })
  );

  const answered = outcomes.filter(isAnswered);
  const failures = outcomes.filter((turn) => !isAnswered(turn));
  const firstAudio = answered
    .map((turn) => turn.firstAudioMs)
    .filter((ms): ms is number => ms !== null);
  const wall = performance.now() - started;

  console.log(
    `\nsoak: ${options.count} device(s) x ${options.turns} turn(s) ` +
      `(${(wall / 1000).toFixed(1)} s wall clock)`
  );
  console.log(`  answered   ${answered.length}/${outcomes.length}`);
  if (failures.length > 0) {
    for (const failure of failures.slice(0, 10)) {
      const reason =
        failure.error ??
        (failure.timedOut
          ? "no reply within the timeout"
          : `reply had ${failure.audioFrames} audio frame(s) and ${failure.transcript} transcript(s)`);
      console.log(`  ! ${normalizeDeviceId(failure.deviceId)} turn ${failure.turn + 1}: ${reason}`);
    }
    if (failures.length > 10) console.log(`  … ${failures.length - 10} more`);
  }
  if (firstAudio.length > 0) {
    console.log(
      `  first audio after the utterance  p50 ${percentile(firstAudio, 0.5).toFixed(0)} ms, ` +
        `p95 ${percentile(firstAudio, 0.95).toFixed(0)} ms`
    );
  }
  if (failures.length > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "runtime") await runtimeMode(options);
  else if (options.mode === "bridge") await bridgeMode(options);
  else await soakMode(options);
  console.log(
    `\nbridge process RSS is the number to watch for connection capacity: ` +
      `get it from the OS (Get-Process node | Select WorkingSet64), not from here.`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
