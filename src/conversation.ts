import type { BridgeConfig } from "./config.js";
import { matchCommand } from "./commands.js";
import type { Gadget, GadgetTurn, Registry } from "./registry.js";
import type { TurnAudio, TurnMessage, TurnOutcome, TurnSink, TurnTool } from "./turn.js";
import { DEVICE_GONE, runTurn } from "./turn.js";

/**
 * A gadget's conversation, carried across its turns.
 *
 * A runtime keeps no conversation of its own. It is stateless and
 * self-describing: the agent's prompt arrives as `systemPrompt`, and everything
 * said earlier arrives as `history`, every turn. So this is where a conversation
 * lives — and since the console records every served turn, it is also where a
 * conversation is restored from when a bridge restarts: a session seeds its
 * history from the turns the resolution returned, and appends to memory and to
 * the console as it goes.
 *
 * The conversation is kept per device rather than per socket, because that is
 * what "this gadget's conversation" means: a device that drops its connection and
 * comes back is the same gadget.
 */

/** One completed exchange, as the conversation keeps it. */
export interface TurnExchange {
  /** What the person said, as the runtime transcribed it. May be empty. */
  user: string;
  /** What the gadget answered. May be empty, if the turn produced no reply. */
  agent: string;
}

export interface Conversations {
  /** The earlier turns, oldest first, ready to send as a turn's `history`. */
  history(deviceId: string): TurnMessage[];
  /** Load what the console recorded, when a session begins. */
  seed(deviceId: string, turns: readonly GadgetTurn[]): void;
  /** Take down a turn that was served. */
  record(deviceId: string, exchange: TurnExchange): void;
}

/**
 * Hold every device's conversation, bounded to the most recent `historyTurns`
 * turns. The bound drops the oldest turns, and a turn is dropped whole: a
 * history beginning with the gadget's answer to a question that is no longer in
 * it is worse than a shorter one.
 */
export function createConversations(config: BridgeConfig): Conversations {
  const byDevice = new Map<string, TurnExchange[]>();

  return {
    history(deviceId: string): TurnMessage[] {
      return flatten(byDevice.get(deviceId) ?? []);
    },

    seed(deviceId: string, turns: readonly GadgetTurn[]): void {
      const kept = turns.filter((turn) => turn.user !== "" || turn.agent !== "").map((turn) => ({ ...turn }));
      while (kept.length > config.historyTurns) kept.shift();
      byDevice.set(deviceId, kept);
    },

    record(deviceId: string, exchange: TurnExchange): void {
      // A turn that produced nothing on either side is not a turn. Recording an
      // empty exchange would spend a slot of the bound on it.
      if (exchange.user === "" && exchange.agent === "") return;

      const kept = byDevice.get(deviceId) ?? [];
      kept.push(exchange);
      // Trimmed here rather than in `history`, so what is held is what is sent:
      // a conversation that only ever grew would be a leak in a service meant to
      // run for months, whatever the request carried.
      while (kept.length > config.historyTurns) kept.shift();
      byDevice.set(deviceId, kept);
    },
  };
}

function flatten(exchanges: readonly TurnExchange[]): TurnMessage[] {
  const messages: TurnMessage[] = [];
  for (const exchange of exchanges) {
    // A side that is empty is left out rather than sent blank. The runtime's own
    // parser accepts an empty content, so a blank message would be carried into
    // the prompt as a turn nobody took.
    if (exchange.user !== "") messages.push({ role: "user", content: exchange.user });
    if (exchange.agent !== "") messages.push({ role: "agent", content: exchange.agent });
  }
  return messages;
}

/** What a turn needs from the device: what the person said or spoke. The
 *  language and engine are the gadget's own, read from the agent the console
 *  returned, so a caller cannot pass a different pair. */
export interface DeviceTurnInput {
  audio?: TurnAudio;
  text?: string;
  /** The gadget's own account of itself, appended to the prompt for this turn only. */
  gadgetCondition?: string;
  /** What this turn may be asked to do: the gadget's catalogue and the bridge's own tools. */
  tools?: readonly TurnTool[];
}

export type DeviceTurnResult =
  | { served: true; userText: string; outcome: TurnOutcome }
  | {
      served: false;
      miss: "no-agent" | "not-owned";
      detail: string;
      message: string;
    };

/**
 * Take one turn for a device: carry the conversation in, send it, and put the
 * turn back into the conversation and into the console.
 */
export async function takeTurn(
  config: BridgeConfig,
  gadget: Gadget,
  conversations: Conversations,
  registry: Registry,
  input: DeviceTurnInput,
  sink: TurnSink,
  signal?: AbortSignal
): Promise<DeviceTurnResult> {
  if (!gadget.owned) {
    return {
      served: false,
      miss: "not-owned",
      detail: `${gadget.deviceId} is not claimed`,
      message: `${gadget.deviceId} belongs to no account, so no turn can be asked as it`,
    };
  }

  const agent = gadget.agent;
  if (agent === null) {
    return {
      served: false,
      miss: "no-agent",
      detail: `${gadget.deviceId} has no agent`,
      message: `${gadget.deviceId} has no agent bound, so it has nothing to say — bind one in the console`,
    };
  }

  const startedAt = new Date();
  // The turn's own transcript, captured from the stream as it passes. It is the
  // only copy: the runtime keeps nothing, and by the time the turn ends the event
  // that carried it is gone.
  let userText = "";

  const outcome = await runTurn(
    agent.runtime,
    {
      systemPrompt:
        input.gadgetCondition === undefined
          ? agent.systemPrompt
          : `${agent.systemPrompt}\n\n${input.gadgetCondition}`,
      enabledTopics: agent.topics,
      answerMode: agent.answerMode,
      language: agent.language,
      engine: agent.engine,
      history: conversations.history(gadget.deviceId),
      ...(agent.llm === null ? {} : { llm: agent.llm }),
      ...(input.audio ? { audio: input.audio } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
    },
    {
      ...sink,
      onUser: async (text) => {
        userText = text;
        await sink.onUser?.(text);
      },
    },
    signal
  );

  // A turn cancelled because its gadget left is a turn nobody heard. The runtime produces
  // faster than the device plays, and it can produce the whole reply after the socket has
  // gone — measured twice on 2026-10-28 — so what was read from the stream is not what
  // reached the device. The transcript keeps the question and records no answer, rather
  // than seeding the next session with words that were never spoken.
  const unheard = signal?.aborted === true && signal.reason === DEVICE_GONE;
  const replyText = unheard ? "" : outcome.replyText;

  // A command the bridge answered itself is not a turn of this conversation: the
  // person said nothing to the agent and it answered nothing — what happened
  // happened on the gadget. Recording it would put a question nobody put to the
  // model into the history, followed by the silence where its answer should be.
  const answeredByTheBridge =
    replyText === "" && matchCommand(agent.language, userText, { music: config.musicDir !== "" }) !== null;
  if (!answeredByTheBridge) {
    conversations.record(gadget.deviceId, { user: userText, agent: replyText });
    // Fire-and-forget: the reply has already been spoken, and a record is never
    // allowed to delay or shorten it.
    registry.recordTurn({
      deviceId: gadget.deviceId,
      userText,
      assistantText: replyText,
      language: agent.language,
      engine: agent.engine,
      startedAt,
      endedAt: new Date(),
    });
  }
  return { served: true, userText, outcome };
}
