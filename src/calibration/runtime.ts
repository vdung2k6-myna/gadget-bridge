/**
 * The runtime calls a spoken calibration needs beyond a normal turn: speaking an
 * instruction in the gadget's own voice, and transcribing one sample without a reply.
 *
 * The speech route is handed the provider fields the gadget's turn already carries —
 * the bridge does not hold the console's profile row id, and the runtime's own catalog
 * does not contain the account's profiles.
 */

import type { RuntimeTarget } from "../platform.js";
import { runtimeAuthHeaders } from "../platform.js";
import type { RuntimeProvider, TurnLanguage } from "../turn.js";

const SPEAK_PATH = "/api/voice/speak";

/** One instruction, synthesized by the runtime in the voice the gadget speaks with. */
export async function speakInstruction(
  runtime: RuntimeTarget,
  tts: RuntimeProvider | undefined,
  language: TurnLanguage,
  text: string
): Promise<Buffer> {
  const response = await fetch(`${runtime.baseUrl}${SPEAK_PATH}`, {
    method: "POST",
    headers: { ...runtimeAuthHeaders(runtime), "content-type": "application/json" },
    body: JSON.stringify({
      text,
      language,
      ...(tts === undefined
        ? {}
        : {
            ttsBaseUrl: tts.baseUrl,
            ttsModel: tts.model,
            ttsVoice: tts.voice ?? "",
            ...(tts.apiKey ? { ttsApiKey: tts.apiKey } : {}),
          }),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `the runtime could not speak the instruction (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`
    );
  }
  return Buffer.from(await response.arrayBuffer());
}
