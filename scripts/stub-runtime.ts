/**
 * A runtime that answers every turn with one canned sentence.
 *
 * A soak that goes through the real platform measures the bridge and STT and the
 * model at once, and the loudest of them is not the bridge. This stub answers in
 * milliseconds, so the bridge's own Opus, endpointer, pacing and reply path are
 * what the figures contain. Pair it with a seeded agent whose runtime points here
 * (the seed takes `RUNTIME_URL`).
 *
 *   npx tsx scripts/stub-runtime.ts --port 4100
 *   npx tsx scripts/stub-runtime.ts --port 4100 --sentence "Yes, I am here."
 *
 * The stream is the same shape the platform sends: `sentence` carries the text and
 * the sentence's audio as base64, and `done` ends it. The audio is a short WAV of
 * silence unless `--audio` names a file — the bridge counts and paces it the same
 * way either way, and what the soak asks is whether frames left, not what they say.
 */

import { readFileSync } from "node:fs";
import http from "node:http";

try {
  process.loadEnvFile();
} catch {
  // No .env beside the service.
}

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

/** A mono 16-bit WAV of silence, which decodes to frames that are paced like any other. */
function silenceWav(sampleRate = 24_000, seconds = 0.6): Buffer {
  const samples = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const port = Number(flag("port", "4100"));
const sentence = flag("sentence", "Hello from the stub runtime.");
const audioPath = flag("audio", "");
const audio = audioPath === "" ? silenceWav() : readFileSync(audioPath);

const server = http.createServer((req, res) => {
  const path = req.url ?? "/";

  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok\n");
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/voice-agent/stream")) {
    // The utterance's body is not read: the answer does not depend on it, and
    // draining it keeps the connection from stalling behind an unread form.
    req.resume();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (name: string, payload: Record<string, unknown>): void => {
      res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    send("user", { text: "(stub input)" });
    send("sentence", { index: 0, text: sentence, audioData: audio.toString("base64") });
    send("done", { fullText: sentence });
    res.end();
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/voice-agent/tool-result")) {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found\n");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`stub runtime on http://127.0.0.1:${port} — answering "${sentence}"`);
});
