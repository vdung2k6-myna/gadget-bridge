import type { BridgeConfig } from "./config.js";
import { info } from "./log.js";
import { unfold } from "./protocol/framing.js";
import { createOpusDecoder, framesToWav, type OpusDecoder } from "./protocol/opus.js";

/**
 * Where the person's speech becomes a turn.
 *
 * The device does not signal the end of speech (D9): the firmware has no
 * device-side VAD that closes a turn, it streams Opus for as long as its
 * microphone is open, and the only message it sends to say it has stopped is one
 * it does not send. So the bridge decides, from the audio itself, and this is the
 * whole of that decision — the section of the rig that ran on real hardware, ported
 * with its measurements intact and its two defects designed out (D13, D14).
 *
 * Two rules, and the first matters more than the second:
 *
 *   1. Only frames received while the bridge has a window open are judged. While
 *      the device speaks, its microphone hears its own speaker and that echo
 *      measures as loud as speech — this board is half-duplex with no AEC — so no
 *      threshold can separate them. The device's own state can, and does.
 *   2. A turn closes on sustained silence that followed speech. No speech seen, no
 *      turn sent: a cough or a door slam must not become a turn.
 *
 * **One verdict per frame, on the frame (6.7).** The rig kept its per-frame verdicts
 * in a second array parallel to the frames, and both defects it produced were that
 * array drifting out of step with the first — one where it stored booleans and the
 * reader searched for `1`, one where a new window cleared the frames and not the
 * verdicts. Each silently degraded the upload to the whole listening window, which
 * the transcriber answered with invented text (D11). Here the samples a verdict was
 * computed from, the verdict, and the wire bytes are one entry, so a length mismatch
 * is unrepresentable rather than a case to handle. That is why `utteranceFrames`
 * carries no alignment guard where the rig's does.
 *
 * **The state is cleared before the turn is attempted, never after (6.4).** A
 * decision that still reads `turn` while something downstream declines it re-fires
 * on every frame that follows — measured in the rig at once per 60 ms for as long as
 * the microphone stayed open — so `frame()` reports the verdict and the caller opens
 * a fresh window immediately, synchronously, before any await.
 */

/** What the endpointer reads. Narrowed to the knobs it uses, so a test can hand it
 *  a plain object rather than a whole deployment. */
export type EndpointerConfig = Pick<
  BridgeConfig,
  | "framing"
  | "frameMs"
  | "deviceRate"
  | "vadMinRms"
  | "vadFloorRatio"
  | "vadSilenceMs"
  | "vadMinSpeechMs"
  | "vadSpeechWindowMs"
  | "maxTurnMs"
  | "vadNoSpeechMs"
  | "onsetLeadMs"
>;

/** One uplink frame, and everything the bridge knows about it. */
export interface ListeningFrame {
  /** The bytes as they arrived, framing header and all. Kept because it is what
   *  arrived, and because nothing here should be the reason a frame is re-derived. */
  wire: Buffer;
  /** Whether `vadStep` counted this frame as speech. */
  voiced: boolean;
  /** The samples that verdict was computed from, or null when the frame would not
   *  decode. The upload is these, concatenated — never a second decode (6.1). */
  samples: Int16Array | null;
  /** The frame's RMS, or null. Kept for the log, which is where a wrong gate shows. */
  rms: number | null;
}

/** The endpointer's own state. Not parallel to the frames: it is a sliding window
 *  over the last `vadSpeechWindowMs`, and it ages out on its own. */
export interface VadState {
  /** Speech in the window, in ms. Recomputed each step rather than accumulated. */
  speechMs: number;
  /** Silence since the last voiced frame, in ms. */
  silenceMs: number;
  /** Voiced frames in the window. */
  voiced: number;
  /** The loudest of them, which is what a person's voice measured at. */
  peak: number;
  /** Every voiced frame since this window opened, and the loudest of them — the two
   *  the sliding window above has forgotten by the time a window is given up on. */
  voicedEver: number;
  peakEver: number;
  /** The room's estimated floor, from the quiet frames alone. */
  floor: number;
  /** The gate this frame was judged against, `max(vadMinRms, floor × vadFloorRatio)`. */
  gate: number;
  /** Recent quiet frames, the estimate of the room rather than of the person. */
  quiet: number[];
  /** The sliding window itself. */
  hist: { voiced: boolean; rms: number }[];
  /** When this window's clock started, for the no-speech giveup. */
  t0: number;
}

/** What the state says to do now. */
export type Verdict = "turn" | "giveup" | "wait";

/** A fresh endpointer, its clock started now. */
export function createVad(now: number): VadState {
  // `floor` starts at 0, not at `vadMinRms`: the minimum is a floor on the GATE and
  // not an estimate of the room. Seeding the room with it would make the opening
  // gate `vadMinRms × vadFloorRatio` — 18750 with the shipped defaults — and nothing
  // would be heard until enough quiet frames arrived to correct it.
  return { speechMs: 0, silenceMs: 0, voiced: 0, peak: 0, voicedEver: 0, peakEver: 0, floor: 0, gate: 0, quiet: [], hist: [], t0: now };
}

/**
 * Fold one frame's RMS into the state. True if it counted as speech.
 *
 * Deterministic given the state it is handed — no clock, no socket, no config
 * beyond the numbers it reads — which is what lets it be replayed offline against
 * captured audio, and what the rig's own checks were written against.
 */
export function vadStep(v: VadState, rms: number, config: EndpointerConfig): boolean {
  v.floor = v.quiet.length < 10 ? 0 : percentile([...v.quiet].sort((a, b) => a - b), 0.2);
  const gate = Math.max(config.vadMinRms, v.floor * config.vadFloorRatio);
  const voiced = rms >= gate;
  v.gate = gate;

  // Speech is counted over a sliding window rather than accumulated from the start
  // of the listening window. A cumulative total with a gate of 3782 — the rig's
  // default before this was fixed — closed a turn 13.9 s into a window with no speech
  // in it, because scattered noise adds up given long enough. `voiced` and `peak` are
  // recomputed over the same window, so the log describes the frames the decision was
  // actually made from. The scan is at most `window / frameMs` = 50 entries per frame;
  // an incremental maximum would have to undo itself as frames age out.
  v.hist.push({ voiced, rms });
  const windowFrames = Math.max(1, Math.round(config.vadSpeechWindowMs / config.frameMs));
  if (v.hist.length > windowFrames) v.hist.shift();

  v.voiced = 0;
  v.peak = 0;
  for (const h of v.hist) {
    if (!h.voiced) continue;
    v.voiced += 1;
    if (h.rms > v.peak) v.peak = h.rms;
  }
  v.speechMs = v.voiced * config.frameMs;

  // The window above is what the decision is made from and what the turn-side log
  // describes, and it is amnesiac. A window is held open for up to `vadNoSpeechMs`,
  // and a transient that crossed the gate ages out of it long before the giveup is
  // reached — so at the moment a window is discarded, `peak` and `voiced` read 0 and
  // the line that reports the discard says nothing about what it discarded. These two
  // do not age out, because the question the giveup log answers is "what did this
  // window hold?", which is a different question from "what does it hold now?".
  if (voiced) {
    v.voicedEver += 1;
    if (rms > v.peakEver) v.peakEver = rms;
  }

  if (voiced) {
    v.silenceMs = 0;
  } else {
    // Silence only begins to count once speech has been heard — otherwise a window
    // nobody spoke into would close itself on the silence of an empty room.
    if (v.speechMs) v.silenceMs += config.frameMs;
    // Only quiet frames feed the floor, so sustained speech cannot raise the floor
    // above itself and cut the speaker off mid-sentence.
    v.quiet.push(rms);
    if (v.quiet.length > 50) v.quiet.shift();
  }
  return voiced;
}

/**
 * How much of the counting window speech must occupy before the turn cap may close a turn.
 *
 * The cap is a backstop for a person who does not pause, so what it must ask for is speech
 * filling the window — not speech counted somewhere in it. Without this, a window held open on
 * nine frames of scattered room noise closed a turn the moment its bound was reached: measured
 * on the board 2026-10-29 at 15.96 s and 57.18 s, answered "nói dài." and "nói".
 *
 * A constant rather than a setting, on purpose. Every other endpointer figure is a measurement
 * of a room or a voice; this one is a property of the rule, and a deployment free to lower it
 * could put the misfire back while its own numbers still looked reasonable.
 */
const SUSTAINED_SHARE = 0.5;

/** The share above, in the milliseconds `vadDecision` compares against. */
const sustainedMs = (config: EndpointerConfig): number =>
  Math.round(config.vadSpeechWindowMs * SUSTAINED_SHARE);

/**
 * What the state says to do now: close the turn, give up on the window, or wait.
 *
 * Three conditions, asking three different questions about the same window:
 *
 *   - **Silence after speech** — the person spoke and then stopped. This is the ordinary
 *     close, and the only one that needs no backstop.
 *   - **The cap** — the person has not stopped for longer than a turn may run. It exists so
 *     that nobody is waited on indefinitely, so what it asks for is speech *occupying* the
 *     counting window rather than speech counted somewhere in it. A burst that never filled
 *     the window is not a person who never paused, and closing on one is how a turn came to
 *     be taken from a room where nobody had spoken.
 *   - **The giveup** — the window heard no utterance and is spent without a turn. It asks
 *     whether an utterance's worth was heard, not whether there was exactly nothing: an
 *     equality against zero lets one stray frame hold a window open for as long as the
 *     counting window is long, and the cap then closes a turn on whatever accumulated.
 *     Measured on the board 2026-10-29: a window alive 57.18 s, closed on 0.54 s of noise,
 *     answered "nói".
 */
export function vadDecision(v: VadState, elapsedMs: number, config: EndpointerConfig): Verdict {
  if (v.speechMs >= config.vadMinSpeechMs && v.silenceMs >= config.vadSilenceMs) return "turn";
  if (
    v.speechMs >= config.vadMinSpeechMs &&
    v.speechMs >= sustainedMs(config) &&
    elapsedMs >= config.maxTurnMs
  )
    return "turn";
  // An utterance's worth or nothing: below the minimum, the window is spent (above).
  if (v.speechMs < config.vadMinSpeechMs && elapsedMs >= config.vadNoSpeechMs) return "giveup";
  return "wait";
}

/**
 * Where the sustained run ending at `last` began, for a window with no quiet edge.
 *
 * At each point, the stretch a turn must at least be — `vadMinSpeechMs` — must be at least
 * `SUSTAINED_SHARE` voiced, the share the cap asks for before it may close a turn in a room that
 * never goes quiet. The walk stops at the first point where that fails, which is where speech
 * stopped being continuous.
 *
 * The measure is that short stretch and not the counting window, and the difference is a cut
 * sentence: a 2.3 s utterance inside a 3 s counting window is 78 % voiced at its end but drops
 * under half almost a second before it begins, so a counting-window test would trim the utterance's
 * own first second away. Measuring over the minimum turn asks the question the trim needs — is
 * there speech here? — rather than the cap's — has there been enough of it lately?
 *
 * Local rather than the share of the whole candidate, because the whole-candidate figure is diluted
 * by the silence the window opened into, and would walk a long utterance's start backwards into
 * that silence even when every second of it was speech.
 *
 * The beginning of the recording is not evidence that speech was thin there: a walk that reaches
 * before the first full stretch has found the window's own start, and returns it.
 */
function sustainedOnset(
  frames: readonly ListeningFrame[],
  last: number,
  config: EndpointerConfig
): number {
  const windowFrames = Math.max(1, Math.round(config.vadMinSpeechMs / config.frameMs));
  const needed = Math.max(1, Math.ceil(windowFrames * SUSTAINED_SHARE));
  for (let i = last; i > 0; i--) {
    const from = i - windowFrames + 1;
    if (from < 0) return 0;
    let voiced = 0;
    for (let j = from; j <= i; j++) if (frames[j]!.voiced) voiced++;
    if (voiced < needed) return Math.min(i + 1, last);
  }
  return 0;
}

/**
 * The frames worth uploading: the utterance, not the whole listening window (6.1).
 *
 * The window stays open until the endpointer closes it, so by decision time it holds
 * everything since `listen start` — the rig measured 640 frames (38.4 s) for a 1.32 s
 * utterance. Handing that to the transcriber is not a bandwidth problem but a
 * correctness one: silence-padded input comes back as invented words, measured at
 * 1.26 s / 1.5 s / 0.24 s utterances inside 41.8 s / 35.0 s / 10.5 s of room tone
 * returning Thai script and invented Chinese, while the same utterances trimmed to
 * 2.9–3.1 s returned clean Vietnamese (D11).
 *
 * The utterance is found by walking **back** from the last voiced frame. Walking
 * forward from the start of the window is what the rig's run 11 exposed: that window
 * held six 15 s no-speech giveups before the person spoke, one stray transient 31 s
 * in was the earliest voiced frame, and anchoring on it uploaded 68.4 s of audio to
 * carry 0.24 s of speech. The walk back stops at a gap of at least `vadSilenceMs`, so
 * a short pause inside a sentence keeps the utterance whole while a blip half a
 * minute earlier does not drag the onset onto itself. That gap is also exactly what
 * closed the turn, so the segment found here is the one the endpointer decided on.
 *
 * A negative onset means there was no utterance to locate at all — no frame in the
 * window was voiced — and the caller sends no turn, because a window trimmed at a
 * guessed position is the failure this function exists to prevent.
 */
export function utteranceFrames(
  frames: readonly ListeningFrame[],
  config: EndpointerConfig
): { frames: ListeningFrame[]; onset: number } {
  if (frames.length === 0) return { frames: [], onset: -1 };

  let last = -1;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i]!.voiced) {
      last = i;
      break;
    }
  }
  // No voiced frame is not a slice to guess at: there is no utterance in this window.
  if (last < 0) return { frames: [], onset: -1 };

  const gapFrames = Math.max(1, Math.round(config.vadSilenceMs / config.frameMs));
  let first = last;
  let quiet = 0;
  let foundGap = false;
  for (let i = last; i >= 0; i--) {
    if (frames[i]!.voiced) {
      quiet = 0;
      first = i;
    } else if (++quiet >= gapFrames) {
      foundGap = true;
      break;
    }
  }
  // Where the room never falls quiet enough to offer that gap — a window that crosses the gate
  // every second or so, measured on the boards 2026-10-29 at 16.0 s uploaded for 2.3 s of speech —
  // the walk above reaches the start and would carry the whole window. The fallback stops where
  // speech stops being sustained instead.
  if (!foundGap) first = sustainedOnset(frames, last, config);

  // A backstop on the upload itself, independent of the segment search: the
  // endpointer already bounds a turn at `maxTurnMs`, so nothing longer than that
  // belongs in one. Without it a bad onset still hands the platform a minute of room
  // tone, which is the whole failure this function exists to prevent.
  const capFrames = Math.max(1, Math.round(config.maxTurnMs / config.frameMs));
  const onset = Math.max(0, first - Math.round(config.onsetLeadMs / config.frameMs), frames.length - capFrames);
  return { frames: frames.slice(onset), onset };
}

/** A listening window: the frames, the endpointer over them, and the decoder that
 *  reads them. One per turn, opened on `listen start` and re-opened at every
 *  decision, since the state that decided must not decide again. */
export interface Listening {
  /** Start a fresh window. Idempotent, and safe to call mid-window: the frames, the
   *  verdicts and the endpointer are cleared together, and any two of the three is
   *  the rig's run 10 (6.7). */
  open(): void;
  /**
   * Judge one uplink frame and say what the window should do.
   *
   * The caller opens a new window on anything but `"wait"`, and does so **before**
   * attempting the turn (6.4).
   */
  frame(wire: Buffer): Verdict;
  /** The utterance that closed the turn, and where it began in the window. */
  utterance(): { frames: ListeningFrame[]; onset: number };
  /** The utterance as the file the platform is handed, or nothing when no frame in
   *  it decoded. */
  upload(): { wav: Buffer | null; seconds: number; failed: number };
  /** Release the decoder. */
  close(): void;
}

export function createListening(config: EndpointerConfig, clock: () => number = Date.now): Listening {
  let decoder: OpusDecoder = createOpusDecoder(config.deviceRate);
  let frames: ListeningFrame[] = [];
  let vad = createVad(clock());

  const endpointerLog = (why: string): void =>
    info(
      `endpointer: ${(vad.speechMs / 1000).toFixed(2)}s speech in ${vad.voiced} frame(s) ` +
        `(peak ${Math.round(vad.peak)}, floor ${Math.round(vad.floor)}) ` +
        `at gate ${Math.round(vad.gate)}, ${(vad.silenceMs / 1000).toFixed(2)}s silence — ${why}`
    );

  return {
    open(): void {
      decoder.close();
      decoder = createOpusDecoder(config.deviceRate);
      frames = [];
      vad = createVad(clock());
    },

    frame(wire: Buffer): Verdict {
      // The framing header comes off BEFORE the decode. Leaving it on does not throw:
      // `opusscript` returns a short block of garbage instead — measured at 160 samples
      // of 960, a tone of true RMS 6364 read as 995 — so the gate sees a signal six times
      // too quiet, the floor collapses to ~1, and the endpointer degenerates into the
      // fixed threshold this board cannot use. It still fires, which is what makes it
      // dangerous: the rig's run 4 closed three turns on speech counts of 20/6/16 frames,
      // every one of them against `floor 1` (6.1).
      const samples = decoder.decode(unfold(wire, config.framing));
      const rms = rmsOf(samples);
      const voiced = rms === null ? false : vadStep(vad, rms, config);
      // Pushed before any decision, so this frame's entry exists even when the verdict
      // below closes the turn and the entry becomes part of the upload.
      frames.push({ wire, voiced, samples, rms });

      // An undecodable frame is captured but decides nothing. It is still the person's
      // audio — the frames either side of it decode — so it stays in the window with its
      // verdict, and the endpointer simply does not see it.
      if (rms === null) return "wait";

      const verdict = vadDecision(vad, clock() - vad.t0, config);
      if (verdict === "turn") {
        endpointerLog(
          vad.silenceMs >= config.vadSilenceMs ? "silence after speech" : "held open past the turn cap"
        );
      } else if (verdict === "giveup") {
        info(
          `no speech in ${(config.vadNoSpeechMs / 1000).toFixed(0)}s ` +
            `(loudest ${Math.round(vad.peakEver)}, floor ${Math.round(vad.floor)}) ` +
            `at gate ${Math.round(vad.gate)}, ${vad.voicedEver} frame(s) over it ` +
            `— closing the window with no turn`
        );
      }
      return verdict;
    },

    utterance(): { frames: ListeningFrame[]; onset: number } {
      return utteranceFrames(frames, config);
    },

    upload(): { wav: Buffer | null; seconds: number; failed: number } {
      const { frames: utterance, onset } = utteranceFrames(frames, config);
      if (onset < 0) {
        // No frame in the window was voiced, so there is no utterance to locate and nothing this
        // function would send that it could call the person's. The window whole is the guess the
        // requirement forbids — and the guess that came back as invented words in the field.
        info(
          `no utterance to upload: ${frames.length} frame(s) in the window, none of them voiced ` +
            `— sending no turn rather than a guessed slice`
        );
        // Counted the way the upload would have counted them: a frame that would not decode is a
        // failure the log has to keep, whether or not a later one is sent.
        const failed = frames.filter((frame) => !frame.samples || frame.samples.length === 0).length;
        return { wav: null, seconds: 0, failed };
      }

      const result = framesToWav(
        utterance.map((frame) => frame.samples),
        config.deviceRate
      );

      info(
        `uploading from speech onset: ${utterance.length} frame(s) = ` +
          `${((utterance.length * config.frameMs) / 1000).toFixed(1)}s ` +
          `(onset at frame ${onset}, ${((onset * config.frameMs) / 1000).toFixed(2)}s into the window)`
      );
      if (result.wav) {
        info(
          `uplink WAV: ${result.seconds.toFixed(2)}s @ ${config.deviceRate} Hz, ${result.wav.length} B` +
            `${result.failed ? `, ${result.failed} frame(s) undecodable and skipped` : ""}`
        );
      }
      return result;
    },

    close(): void {
      decoder.close();
    },
  };
}

/** The RMS of a decoded frame, or null when there is no frame to measure. */
function rmsOf(samples: Int16Array | null): number | null {
  if (!samples || samples.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

/** The `p`-th centile of an ascending array. Nearest-rank, which is what the rig
 *  used on hardware and is exact for the small samples it is given. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]!;
}
