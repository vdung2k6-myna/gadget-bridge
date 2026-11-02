/**
 * What this process is doing, for a soak to read while it runs.
 *
 * The connection probe can say how many sockets were opened; it cannot say what a
 * session costs once frames are flowing. These are the counters that answer that:
 * how many sessions are live, how many uplink frames were judged against the
 * endpointer, how many were dropped before judging, and how many turns are in
 * flight. The event-loop delay is here because the audio path is one Node loop:
 * a loop that cannot keep up shows up as delayed frames before it shows up as a
 * failed turn.
 *
 * Read-only and cheap to update, so a hot path can count without measuring.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

// Five milliseconds: fine enough to see a loop falling behind, coarse enough not
// to spend the loop's time measuring itself. The histogram rounds up to this
// resolution, so the snapshot subtracts it rather than reporting the floor as a
// real delay.
const RESOLUTION_MS = 5;
const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
delay.enable();

const startedAt = Date.now();

let sessionsActive = 0;
let sessionsTotal = 0;
let framesJudged = 0;
let framesDropped = 0;
let turnsInFlight = 0;

export interface MetricsSnapshot {
  uptimeSeconds: number;
  rssBytes: number;
  heapUsedBytes: number;
  /** Cumulative since the process started, in milliseconds. */
  eventLoopDelayMs: { p50: number; p95: number; p99: number; max: number };
  sessions: { active: number; total: number };
  frames: { judged: number; dropped: number };
  turnsInFlight: number;
}

const millis = (nanoseconds: number): number =>
  Math.max(0, Math.round(nanoseconds / 1e5) / 10 - RESOLUTION_MS);

export const metrics = {
  sessionOpened(): void {
    sessionsActive += 1;
    sessionsTotal += 1;
  },
  sessionClosed(): void {
    sessionsActive = Math.max(0, sessionsActive - 1);
  },
  /** A frame handed to the endpointer. */
  frameJudged(): void {
    framesJudged += 1;
  },
  /** A frame counted but not judged: our own audio, an exchange, or no window. */
  frameDropped(): void {
    framesDropped += 1;
  },
  turnStarted(): void {
    turnsInFlight += 1;
  },
  turnFinished(): void {
    turnsInFlight = Math.max(0, turnsInFlight - 1);
  },
  snapshot(): MetricsSnapshot {
    const memory = process.memoryUsage();
    return {
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      eventLoopDelayMs: {
        p50: millis(delay.percentile(50)),
        p95: millis(delay.percentile(95)),
        p99: millis(delay.percentile(99)),
        max: millis(delay.max),
      },
      sessions: { active: sessionsActive, total: sessionsTotal },
      frames: { judged: framesJudged, dropped: framesDropped },
      turnsInFlight,
    };
  },
};
