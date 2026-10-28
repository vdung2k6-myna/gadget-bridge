import type { BridgeConfig } from "./config.js";
import { normalizeDeviceId } from "./credentials.js";
import { warn } from "./log.js";
import type { RuntimeTarget } from "./platform.js";
import type { HardwareReport } from "./protocol/hardware.js";
import type { AnswerMode, RuntimeLlm, TurnEngine, TurnLanguage } from "./turn.js";

/**
 * What a gadget is, as the console holds it.
 *
 * One call answers everything a session needs: whether the gadget is owned, the
 * agent that answers it (with its runtime address and credential), the device's
 * own secret, its partner, and the turns already recorded. A connection resolves
 * once; the turn path then reads nothing.
 *
 * Resolution is cached for `registryTtlMs`, so a release reaches the bridge at
 * the end of that window rather than instantly — the bound the capability states
 * rather than a claim of revocation on demand. Everything else fails closed: an
 * unreachable console resolves nothing, and a gadget is not served.
 */

export interface GadgetAgent {
  id: string;
  name: string;
  systemPrompt: string;
  language: TurnLanguage;
  engine: TurnEngine;
  answerMode: AnswerMode;
  topics: string[];
  runtime: RuntimeTarget;
  /** The account's own model, or null for the runtime's default. */
  llm: RuntimeLlm | null;
}

export interface GadgetTurn {
  user: string;
  agent: string;
}

/**
 * What the console says this device should be running. The URL is the console's
 * own, built from its public base; this bridge relays it and never constructs one.
 */
export interface FirmwareTarget {
  version: string;
  url: string;
  force: boolean;
}

export interface Gadget {
  deviceId: string;
  owned: boolean;
  secret: string;
  agent: GadgetAgent | null;
  partner: string | null;
  turns: GadgetTurn[];
  firmware: FirmwareTarget | null;
  activation?: { code: string };
}

export interface RegistryTurn {
  deviceId: string;
  userText: string;
  assistantText: string;
  language: string;
  engine: string;
  startedAt: Date;
  endedAt: Date;
}

export type ActivationState = "owned" | "pending" | "unknown";

export interface Registry {
  resolve(deviceId: string): Promise<Gadget>;
  /** Fire-and-forget: what the gadget declared, for its page and for nothing else. */
  reportTools(deviceId: string, tools: readonly { name: string; description: string }[]): void;
  /** Fire-and-forget: what the firmware said about its board, for its page and for nothing else. */
  reportHardware(deviceId: string, hardware: HardwareReport): void;
  activate(deviceId: string): Promise<ActivationState>;
  /** Fire-and-forget: a turn is never delayed or lost for a record's sake. */
  recordTurn(turn: RegistryTurn): void;
  /** Drops a cached resolution, so the next call asks the console again. */
  forget(deviceId: string): void;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

const LANGUAGES: readonly string[] = ["english", "vietnamese"];
const ENGINES: readonly string[] = ["kokoro", "piper", "supertonic"];
const CONSOLE_TIMEOUT_MS = 5000;

type FetchImpl = typeof fetch;

export function createRegistry(
  config: BridgeConfig,
  fetchImpl: FetchImpl = fetch,
  now: () => number = Date.now
): Registry {
  const cache = new Map<string, { expiresAt: number; gadget: Gadget }>();

  async function post(path: string, body: unknown): Promise<Response> {
    return fetchImpl(`${config.consoleUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.consoleToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONSOLE_TIMEOUT_MS),
    });
  }

  return {
    async resolve(rawDeviceId: string): Promise<Gadget> {
      const deviceId = normalizeDeviceId(rawDeviceId);
      const cached = cache.get(deviceId);
      if (cached !== undefined && cached.expiresAt > now()) return cached.gadget;

      let response: Response;
      try {
        response = await post("/api/bridge/resolve", { deviceId });
      } catch (error) {
        throw new RegistryError(
          `the console could not be reached at ${config.consoleUrl}: ${messageOf(error)}`
        );
      }

      if (response.status === 429) {
        throw new RegistryError("the console is rate-limiting claim requests for this device", 429);
      }
      if (!response.ok) {
        throw new RegistryError(
          `the console answered ${response.status} for ${deviceId}`,
          response.status
        );
      }

      const gadget = parseGadget(await response.json(), deviceId);
      cache.set(deviceId, { expiresAt: now() + config.registryTtlMs, gadget });
      return gadget;
    },

    reportTools(rawDeviceId: string, tools: readonly { name: string; description: string }[]): void {
      const deviceId = normalizeDeviceId(rawDeviceId);
      void post("/api/bridge/tools", { deviceId, tools })
        .then((response) => {
          if (!response.ok) {
            warn(
              `the console did not take the tool catalogue for ${deviceId} (${response.status}) — ` +
                `the session is unaffected and its page keeps what it had`
            );
          }
        })
        .catch((error: unknown) => {
          warn(
            `the console could not be reached to record the catalogue for ${deviceId}: ` +
              `${messageOf(error)} — the session is unaffected`
          );
        });
    },

    reportHardware(rawDeviceId: string, hardware: HardwareReport): void {
      const deviceId = normalizeDeviceId(rawDeviceId);
      void post("/api/bridge/hardware", { deviceId, hardware })
        .then((response) => {
          if (!response.ok) {
            warn(
              `the console did not take the board report for ${deviceId} (${response.status}) — ` +
                `the session is unaffected and its page keeps what it had`
            );
          }
        })
        .catch((error: unknown) => {
          warn(
            `the console could not be reached to record the board for ${deviceId}: ` +
              `${messageOf(error)} — the session is unaffected`
          );
        });
    },

    async activate(rawDeviceId: string): Promise<ActivationState> {
      const deviceId = normalizeDeviceId(rawDeviceId);
      let response: Response;
      try {
        response = await post("/api/bridge/activate", { deviceId });
      } catch (error) {
        throw new RegistryError(
          `the console could not be reached at ${config.consoleUrl}: ${messageOf(error)}`
        );
      }

      if (response.status === 200) {
        // A claim can happen inside the cache window, and the cached answer would
        // still say "unowned" — which is the state the gadget is leaving, so it is
        // dropped here. A *release* does not come through this route and keeps the
        // stated bound.
        cache.delete(deviceId);
        return "owned";
      }
      if (response.status === 202) return "pending";
      if (response.status === 404) return "unknown";
      throw new RegistryError(
        `the console answered ${response.status} for the activation of ${deviceId}`,
        response.status
      );
    },

    recordTurn(turn: RegistryTurn): void {
      void post("/api/bridge/turns", {
        deviceId: turn.deviceId,
        userText: turn.userText,
        assistantText: turn.assistantText,
        language: turn.language,
        engine: turn.engine,
        startedAt: turn.startedAt.toISOString(),
        endedAt: turn.endedAt.toISOString(),
      })
        .then((response) => {
          if (!response.ok) {
            warn(
              `the console did not record the turn for ${turn.deviceId} (${response.status}) — ` +
                `the reply was spoken and only its record is missing`
            );
          }
        })
        .catch((error: unknown) => {
          warn(
            `the console could not be reached to record the turn for ${turn.deviceId}: ` +
              `${messageOf(error)} — the reply was spoken and only its record is missing`
          );
        });
    },

    forget(rawDeviceId: string): void {
      cache.delete(normalizeDeviceId(rawDeviceId));
    },
  };
}

function parseGadget(payload: unknown, expectedDeviceId: string): Gadget {
  if (typeof payload !== "object" || payload === null) {
    throw new RegistryError("the console answered a resolution that is not an object");
  }
  const body = payload as Record<string, unknown>;
  const deviceId = typeof body.deviceId === "string" ? normalizeDeviceId(body.deviceId) : "";
  if (deviceId === "" || deviceId !== expectedDeviceId) {
    throw new RegistryError(
      `the console answered a resolution for ${JSON.stringify(String(body.deviceId))}, not ${expectedDeviceId}`
    );
  }
  if (typeof body.secret !== "string" || body.secret === "") {
    throw new RegistryError(`the console answered no secret for ${deviceId}`);
  }

  const owned = body.owned === true;
  if (!owned) {
    const activation = body.activation;
    return {
      deviceId,
      owned: false,
      secret: body.secret,
      agent: null,
      partner: null,
      turns: [],
      firmware: null,
      ...(typeof activation === "object" && activation !== null && typeof (activation as { code?: unknown }).code === "string"
        ? { activation: { code: (activation as { code: string }).code } }
        : {}),
    };
  }

  return {
    deviceId,
    owned: true,
    secret: body.secret,
    agent: body.agent === null || body.agent === undefined ? null : parseAgent(body.agent, deviceId),
    partner: typeof body.partner === "string" ? normalizeDeviceId(body.partner) : null,
    turns: parseTurns(body.turns),
    firmware: parseFirmware(body.firmware, deviceId),
  };
}

/**
 * The firmware target, read leniently.
 *
 * A target is bookkeeping: a session must not be refused because the console's
 * firmware metadata is odd. So an unusable block is dropped with a warning and the
 * device is served as it would have been before firmware releases existed. The URL
 * must be absolute http(s) — the firmware's downloader cannot do anything else —
 * and nothing here composes one from the request.
 */
function parseFirmware(payload: unknown, deviceId: string): FirmwareTarget | null {
  if (payload === null || payload === undefined) return null;

  if (typeof payload !== "object" || Array.isArray(payload)) {
    warn(`the console answered a firmware target for ${deviceId} that is not an object — ignored`);
    return null;
  }

  const target = payload as Record<string, unknown>;
  const version = typeof target.version === "string" ? target.version.trim() : "";
  const url = typeof target.url === "string" ? target.url.trim() : "";
  if (version === "" || url === "") {
    warn(`the console answered an incomplete firmware target for ${deviceId} — ignored`);
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    warn(`the console answered a firmware target for ${deviceId} whose URL is not absolute — ignored`);
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    warn(`the console answered a firmware target for ${deviceId} whose URL is not http(s) — ignored`);
    return null;
  }

  return { version, url, force: target.force === true };
}

function parseAgent(payload: unknown, deviceId: string): GadgetAgent {
  if (typeof payload !== "object" || payload === null) {
    throw new RegistryError(`the console answered an agent that is not an object for ${deviceId}`);
  }
  const agent = payload as Record<string, unknown>;

  const language = typeof agent.language === "string" ? agent.language : "";
  if (!LANGUAGES.includes(language)) {
    throw new RegistryError(
      `the console answered agent ${JSON.stringify(deviceId)} with language ${JSON.stringify(language)}, ` +
        "which the runtime does not name"
    );
  }
  const engine = typeof agent.engine === "string" ? agent.engine : "";
  if (!ENGINES.includes(engine)) {
    throw new RegistryError(
      `the console answered agent ${JSON.stringify(deviceId)} with engine ${JSON.stringify(engine)}, ` +
        "which the runtime does not name"
    );
  }

  const runtime = agent.runtime;
  if (typeof runtime !== "object" || runtime === null) {
    throw new RegistryError(`the console answered no runtime for agent ${JSON.stringify(deviceId)}`);
  }
  const target = runtime as Record<string, unknown>;
  if (typeof target.baseUrl !== "string" || typeof target.token !== "string") {
    throw new RegistryError(`the console answered an incomplete runtime for ${JSON.stringify(deviceId)}`);
  }

  const answerMode = agent.answerMode === "material" ? "material" : "generate";
  return {
    id: String(agent.id ?? ""),
    name: String(agent.name ?? ""),
    systemPrompt: typeof agent.systemPrompt === "string" ? agent.systemPrompt : "",
    language: language as TurnLanguage,
    engine: engine as TurnEngine,
    answerMode,
    topics: Array.isArray(agent.topics) ? agent.topics.filter((t): t is string => typeof t === "string") : [],
    runtime: { baseUrl: target.baseUrl, token: target.token },
    llm: parseLlm(agent.llm, deviceId),
  };
}

/**
 * The account's model, read whole or refused whole: half a profile would be a
 * turn sent to somebody's endpoint with no key, which fails where the person
 * cannot see why.
 */
function parseLlm(payload: unknown, deviceId: string): RuntimeLlm | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== "object") {
    throw new RegistryError(`the console answered a malformed LLM profile for ${JSON.stringify(deviceId)}`);
  }
  const llm = payload as Record<string, unknown>;
  if (
    typeof llm.baseUrl !== "string" ||
    typeof llm.model !== "string" ||
    typeof llm.apiKey !== "string"
  ) {
    throw new RegistryError(`the console answered an incomplete LLM profile for ${JSON.stringify(deviceId)}`);
  }
  return {
    baseUrl: llm.baseUrl,
    model: llm.model,
    apiKey: llm.apiKey,
    temperature: typeof llm.temperature === "number" ? llm.temperature : null,
  };
}

function parseTurns(payload: unknown): GadgetTurn[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const turn = entry as Record<string, unknown>;
    return [
      {
        user: typeof turn.userText === "string" ? turn.userText : "",
        agent: typeof turn.assistantText === "string" ? turn.assistantText : "",
      },
    ];
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
