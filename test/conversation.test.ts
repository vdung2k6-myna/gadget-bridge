import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ENDPOINTER_DEFAULTS, MUSIC_GAIN_DB_DEFAULT, type BridgeConfig } from "../src/config.js";
import type { Gadget, Registry } from "../src/registry.js";
import { createConversations, takeTurn } from "../src/conversation.js";
import { DEVICE_GONE } from "../src/turn.js";
import type { TurnLanguage, TurnSink } from "../src/turn.js";

/**
 * A gadget's conversation, which the platform does not keep.
 *
 * The endpoint is stateless (D2), so this is the only thing standing between the
 * gadget and total amnesia — and it fails quietly when it fails. A conversation
 * that is dropped looks exactly like a conversation that was never sent, and one
 * that is not bounded looks fine until the turn where it is refused. So the two
 * halves under test are the ones a person would notice: what a turn carries in,
 * and what it leaves behind.
 *
 * The stub platform speaks both routes this module needs, and the requests it
 * records are read back as the fields they were posted as — because the thing
 * being pinned is what a turn says on the wire, not what a function returned.
 */
const PLATFORM = "platform-token-abcdefgh";

/** The fields an agent carries, as the console holds them. */
interface Persona {
  id: string;
  label: string;
  defaultPrompt: string;
  knowledgeTopics: string[];
  answerMode: "generate" | "material";
}

const CATALOG: Persona[] = [
  {
    id: "interview-coach",
    label: "Interview Coach",
    defaultPrompt: "You are an interview coach.",
    knowledgeTopics: ["STAR Method"],
    answerMode: "generate",
  },
  {
    id: "language-partner",
    label: "Language Partner",
    defaultPrompt: "You are a patient language partner.",
    knowledgeTopics: [],
    answerMode: "generate",
  },
];

interface ConfigMeta {
  url: string;
  binding?: string;
  language?: TurnLanguage;
}

/** What each config was built for, so a gadget can be built from the same options. */
const meta = new WeakMap<BridgeConfig, ConfigMeta>();

function configFor(
  runtimeUrl: string,
  options: { historyTurns?: number; binding?: string; language?: TurnLanguage } = {}
): BridgeConfig {
  const config: BridgeConfig = {
    otaPort: 0,
    wsPort: 0,
    publicHost: "127.0.0.1",
    consoleUrl: "http://127.0.0.1:3001",
    consoleToken: "console-token-abcdefgh",
    registryTtlMs: 60_000,
    framing: 3,
    serverRate: 24000,
    frameMs: 60,
    ...ENDPOINTER_DEFAULTS,
    sessionIdleMs: 60000,
    musicDir: "",
    musicGainDb: MUSIC_GAIN_DB_DEFAULT,
    historyTurns: options.historyTurns ?? 20,
    commandStep: 10,
    handoverMs: 400,
  };
  meta.set(config, { url: runtimeUrl, ...options });
  return config;
}

interface StubRequest {
  path: string;
  body: string;
}

interface Stub {
  url: string;
  requests: StubRequest[];
  /** Replace the stream the turn route answers with. */
  reply(stream: (res: ServerResponse) => void | Promise<void>): void;
  stop(): void;
}

/** The two routes this module uses: the catalog, and a turn's stream. */
async function stubPlatform(): Promise<Stub> {
  const requests: StubRequest[] = [];
  let stream: (res: ServerResponse) => void | Promise<void> = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: done\ndata: {"fullText":"ok"}\n\n');
    res.end();
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      if ((req.url ?? "").startsWith("/api/personas")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(CATALOG));
        return;
      }
      void stream(res);
    });
  });
  server.listen(0, "127.0.0.1");
  // 127.0.0.1 rather than "localhost", for the reason the other stubs give: the
  // name resolves to ::1 first here, and a stub on IPv4 then looks like a bug.
  if (!server.address()) await once(server, "listening");

  return {
    requests,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    reply(next) {
      stream = next;
    },
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** A multipart field's value, as the platform reads it off the wire. */
function fieldOf(body: string, name: string): string | null {
  const at = body.indexOf(`name="${name}"`);
  if (at < 0) return null;
  const start = body.indexOf("\r\n\r\n", at);
  if (start < 0) return null;
  const end = body.indexOf("\r\n--", start);
  return end < 0 ? null : body.slice(start + 4, end);
}

/** The `history` a turn was posted with, as messages. */
function historyOf(body: string): Array<{ role: string; content: string }> {
  const raw = fieldOf(body, "history");
  assert.ok(raw !== null, "every turn carries a history field, empty or not");
  return JSON.parse(raw) as Array<{ role: string; content: string }>;
}

/** Answer each turn with the next reply, transcribing it as `asked <n>`. */
function replyingWith(replies: string[]) {
  let index = 0;
  return (res: ServerResponse) => {
    index += 1;
    const text = replies[Math.min(index - 1, replies.length - 1)];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: user\ndata: ${JSON.stringify({ text: `asked ${index}` })}\n\n`);
    res.write(`event: text\ndata: ${JSON.stringify({ text })}\n\n`);
    res.write(`event: done\ndata: ${JSON.stringify({ fullText: text })}\n\n`);
    res.end();
  };
}

const noSink: TurnSink = {};

/**
 * The gadget a config describes. The console used to be the catalog this test
 * read; now it is a resolution, and what a turn is asked with comes from it.
 */
function gadgetFor(config: BridgeConfig): Gadget {
  const options = meta.get(config)!;
  const persona = CATALOG.find((entry) => entry.id === (options.binding ?? "interview-coach"));
  return {
    deviceId: "b81f3f4a9b01",
    owned: true,
    secret: "s".repeat(43),
    agent:
      persona === undefined
        ? null
        : {
            id: persona.id,
            name: persona.label,
            systemPrompt: persona.defaultPrompt,
            language: options.language ?? "english",
            engine: "engine-c",
            answerMode: persona.answerMode,
            topics: persona.knowledgeTopics,
            runtime: { baseUrl: options.url, token: PLATFORM },
            providers: { stt: null, tts: null, llm: null },
          },
    partner: null,
    turns: [],
    firmware: null,
  };
}

/** A registry whose writes are ignored: this file is about what a turn says. */
const registry: Registry = {
  resolve: async (deviceId) => ({
    deviceId,
    owned: true,
    secret: "s".repeat(43),
    agent: null,
    partner: null,
    turns: [],
    firmware: null,
  }),
  reportTools: () => {},
  reportHardware: () => {},
  activate: async () => "owned",
  recordTurn: () => {},
  forget: () => {},
};

describe("holding a conversation", () => {
  it("keeps each device's conversation to itself", () => {
    const conversations = createConversations(configFor("http://unused"));
    conversations.record("b81f3f4a9b01", { user: "one", agent: "answer one" });
    conversations.record("aa11bb22cc33", { user: "two", agent: "answer two" });

    assert.deepEqual(conversations.history("b81f3f4a9b01"), [
      { role: "user", content: "one" },
      { role: "agent", content: "answer one" },
    ]);
    assert.deepEqual(conversations.history("aa11bb22cc33"), [
      { role: "user", content: "two" },
      { role: "agent", content: "answer two" },
    ]);
  });

  it("gives a device that has never spoken an empty history", () => {
    const conversations = createConversations(configFor("http://unused"));
    assert.deepEqual(conversations.history("aa11bb22cc33"), []);
  });

  it("orders turns oldest first, the person before the gadget", () => {
    const conversations = createConversations(configFor("http://unused"));
    conversations.record("d", { user: "first question", agent: "first answer" });
    conversations.record("d", { user: "second question", agent: "second answer" });

    assert.deepEqual(
      conversations.history("d").map((m) => `${m.role}:${m.content}`),
      ["user:first question", "agent:first answer", "user:second question", "agent:second answer"]
    );
  });

  it("leaves out a side that is empty rather than sending it blank", () => {
    // A refused turn has no reply; a turn with nothing recognised in it has no
    // transcript. Either would otherwise reach the model as a turn nobody took.
    const conversations = createConversations(configFor("http://unused"));
    conversations.record("d", { user: "something said", agent: "" });

    assert.deepEqual(conversations.history("d"), [{ role: "user", content: "something said" }]);
  });

  it("does not spend a turn on an exchange with nothing in it", () => {
    const conversations = createConversations(configFor("http://unused"));
    conversations.record("d", { user: "", agent: "" });
    assert.deepEqual(conversations.history("d"), []);
  });
});

describe("bounding a conversation", () => {
  it("drops the oldest turns and keeps the most recent", () => {
    const conversations = createConversations(configFor("http://unused", { historyTurns: 2 }));
    for (const n of [1, 2, 3, 4]) {
      conversations.record("d", { user: `q${n}`, agent: `a${n}` });
    }

    assert.deepEqual(
      conversations.history("d").map((m) => m.content),
      ["q3", "a3", "q4", "a4"],
      "the bound drops from the front, so the oldest is what goes"
    );
  });

  it("drops a turn whole, so the history never opens on an answer to nothing", () => {
    const conversations = createConversations(configFor("http://unused", { historyTurns: 3 }));
    for (const n of [1, 2, 3, 4, 5]) {
      conversations.record("d", { user: `q${n}`, agent: `a${n}` });
    }

    const roles = conversations.history("d").map((m) => m.role);
    assert.equal(roles[0], "user", `history opened with ${roles[0]}: ${roles.join(",")}`);
    assert.deepEqual(roles, ["user", "agent", "user", "agent", "user", "agent"]);
  });

  it("still holds a turn longer than the whole budget", () => {
    // Worse to send nothing than to send one long turn: the alternative is a gadget
    // that cannot speak until the conversation it is already in gets shorter.
    const conversations = createConversations(configFor("http://unused", { historyTurns: 1 }));
    conversations.record("d", { user: "q1", agent: "a1" });
    conversations.record("d", { user: "q2", agent: "a2" });

    assert.deepEqual(
      conversations.history("d").map((m) => m.content),
      ["q2", "a2"]
    );
  });

  it("holds only what it will send, however long the conversation runs", () => {
    // The bound is on what is kept, not only on what is sent: a service meant to
    // run for months cannot hold every turn a gadget has ever taken.
    const conversations = createConversations(configFor("http://unused", { historyTurns: 3 }));
    for (let n = 0; n < 500; n++) {
      conversations.record("d", { user: `q${n}`, agent: `a${n}` });
    }
    assert.equal(conversations.history("d").length, 6);
  });
});

describe("a device's turn, from the conversation's side", () => {
  it("sends the turns so far, and not the one being taken", async () => {
    const platform = await stubPlatform();
    platform.reply(replyingWith(["first answer", "second answer"]));
    try {
      const config = configFor(platform.url);
      const conversations = createConversations(config);

      await takeTurn(
        config, gadgetFor(config), conversations, registry, { text:"first question" }, noSink
      );
      await takeTurn(
        config, gadgetFor(config), conversations, registry, { text:"second question" }, noSink
      );

      const turns = platform.requests.filter((r) => r.path.includes("stream"));
      assert.deepEqual(historyOf(turns[0].body), [], "nothing was said before the first turn");
      // The platform appends the current turn to the history itself, so sending it
      // here as well would put the same question to the model twice.
      assert.deepEqual(historyOf(turns[1].body), [
        { role: "user", content: "asked 1" },
        { role: "agent", content: "first answer" },
      ]);
      assert.equal(fieldOf(turns[1].body, "text"), "second question");
    } finally {
      platform.stop();
    }
  });

  it("logs no part of the account's key", async () => {
    // A key is the account's, not ours: it may cross this process, and it must
    // never land in a line an operator or a log collector reads.
    const platform = await stubPlatform();
    const captured: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const capture = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      const config = configFor(platform.url);
      const gadget = gadgetFor(config);
      const withLlm = {
        ...gadget,
        agent: {
          ...gadget.agent!,
          llm: {
            baseUrl: platform.url,
            model: "test-model",
            apiKey: "sk-secret-that-must-not-be-logged",
            temperature: null,
          },
        },
      };

      console.log = capture;
      console.warn = capture;
      console.error = capture;
      console.info = capture;

      await takeTurn(config, withLlm, createConversations(config), registry, { text: "hello" }, noSink);
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
      console.info = originals.info;
      platform.stop();
    }

    assert.equal(captured.join(" | ").includes("sk-secret-that-must-not-be-logged"), false);
  });

  it("answers without waiting for the record", async () => {
    // Recording is fire-and-forget: the reply has been spoken by the time the
    // console is told about it, and a console that never answers must not delay a
    // single turn.
    const platform = await stubPlatform();
    try {
      const config = configFor(platform.url);
      const slow: Registry = { ...registry, recordTurn: () => { void new Promise(() => {}); } };
      const result = await takeTurn(
        config, gadgetFor(config), createConversations(config), slow,
        { text: "hello" }, noSink
      );
      assert.equal(result.served, true);
    } finally {
      platform.stop();
    }
  });

  it("takes the person's side from the stream's own transcription", async () => {
    // Not from what was submitted. The platform's transcription is what the model
    // will be shown next turn, and on an audio turn it is the only copy of what was
    // said that exists anywhere at all.
    const platform = await stubPlatform();
    platform.reply((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: user\ndata: {"text":"hôm nay trời đẹp"}\n\n');
      res.write('event: done\ndata: {"fullText":"Đúng vậy."}\n\n');
      res.end();
    });
    try {
      const config = configFor(platform.url);
      const conversations = createConversations(config);

      await takeTurn(
        config, gadgetFor(config), conversations, registry, { text:"something else entirely" }, noSink
      );

      assert.deepEqual(conversations.history("b81f3f4a9b01"), [
        { role: "user", content: "hôm nay trời đẹp" },
        { role: "agent", content: "Đúng vậy." },
      ]);
    } finally {
      platform.stop();
    }
  });

  it("still hands the transcript to the sink, having kept a copy", async () => {
    const platform = await stubPlatform();
    platform.reply(replyingWith(["Chào bạn."]));
    try {
      const config = configFor(platform.url);
      const seen: string[] = [];

      await takeTurn(
        config, gadgetFor(config), createConversations(config), registry, { text:"hi" },
        { onUser: (text) => void seen.push(text) }
      );

      // 6.2 reports this same text back to the device as its `stt` message, so
      // capturing it here must not swallow the event on its way past.
      assert.deepEqual(seen, ["asked 1"]);
    } finally {
      platform.stop();
    }
  });

  it("serves no turn at all when the device has no agent bound", async () => {
    const platform = await stubPlatform();
    try {
      const config = configFor(platform.url, { binding: "gone-from-the-catalog" });

      const result = await takeTurn(
        config, gadgetFor(config), createConversations(config), registry, { text:"hello" }, noSink
      );

      assert.equal(result.served, false);
      if (result.served) return;
      assert.equal(result.miss, "no-agent");
      // The line an operator reads has to name the device, or there is nothing in
      // it to act on.
      assert.match(result.message, /b81f3f4a9b01/);
      assert.equal(
        platform.requests.filter((r) => r.path.includes("stream")).length,
        0,
        "a gadget the catalog does not report is answered as no one, not as somebody else"
      );
    } finally {
      platform.stop();
    }
  });

  it("keeps the person's line, and invents nothing for the gadget, when a turn is refused", async () => {
    const platform = await stubPlatform();
    platform.reply((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: user\ndata: {"text":"hello"}\n\n');
      res.write('event: error\ndata: {"message":"systemPrompt is required"}\n\n');
      res.end();
    });
    try {
      const config = configFor(platform.url);
      const conversations = createConversations(config);

      await takeTurn(
        config, gadgetFor(config), conversations, registry, { text:"hello" }, noSink
      );

      assert.deepEqual(conversations.history("b81f3f4a9b01"), [
        { role: "user", content: "hello" },
      ]);
      // And the device can take a further turn: a refused turn is the platform's
      // answer to one turn, not a state the conversation is left in (4.4).
      const after = await takeTurn(
        config, gadgetFor(config), conversations, registry, { text:"again" }, noSink
      );
      assert.equal(after.served, true);
    } finally {
      platform.stop();
    }
  });

  it("records no reply for a turn the gadget left before hearing it", async () => {
    // The socket closed after the runtime had started answering, and the runtime went on
    // producing after it had gone — measured twice on 2026-10-28. What was read from the
    // stream is not what reached the gadget, so the transcript keeps the question and
    // records no answer, rather than seeding the next session with words nobody heard.
    const platform = await stubPlatform();
    platform.reply((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: user\ndata: {"text":"hôm nay trời đẹp"}\n\n');
      res.write('event: text\ndata: {"text":"Đúng"}\n\n');
      res.write('event: done\ndata: {"fullText":"Đúng vậy, trời rất đẹp."}\n\n');
      res.end();
    });
    try {
      const config = configFor(platform.url);
      const conversations = createConversations(config);
      const controller = new AbortController();

      let said: () => void = () => {};
      const textArrived = new Promise<void>((resolve) => {
        said = resolve;
      });
      const running = takeTurn(
        config,
        gadgetFor(config),
        conversations,
        registry,
        { text: "hello" },
        {
          onText: () => {
            // The gadget goes away as the reply is arriving, which is the shape the
            // close handler produces: a turn aborted for the device, not for the person.
            controller.abort(DEVICE_GONE);
            said();
          },
        },
        controller.signal
      );
      await textArrived;
      await running;

      assert.deepEqual(
        conversations.history("b81f3f4a9b01"),
        [{ role: "user", content: "hôm nay trời đẹp" }],
        "the question stands and the answer nobody heard does not"
      );
    } finally {
      platform.stop();
    }
  });
});

describe("a command the bridge answered itself", () => {
  it("is not carried into the conversation", async () => {
    // Requirement 4, at the one recording site (4.2). The command does reach the platform
    // — the transcript is the only place it exists at all, since the bridge has no
    // recogniser of its own (D12) — and is dropped there. What must not survive it is the
    // transcript: a history holding "giảm âm lượng" with silence where the answer would
    // be is a question nobody put to the model, and the next interview turn would be
    // asked against a conversation that never took place.
    const platform = await stubPlatform();
    // No `done`: the bridge let go of the stream, and what it had read by then stands.
    platform.reply((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: user\ndata: {"text":"giảm âm lượng"}\n\n');
      res.end();
    });
    try {
      const config = configFor(platform.url, { language: "vietnamese" });
      const conversations = createConversations(config);

      const result = await takeTurn(
        config, gadgetFor(config), conversations, registry, { text:"anything" }, noSink
      );

      assert.equal(result.served, true, "the turn was taken; it was the gadget that answered it");
      assert.deepEqual(conversations.history("b81f3f4a9b01"), []);
    } finally {
      platform.stop();
    }
  });

  it("is recorded all the same when the platform did answer it", async () => {
    // The other half of the shape the recording site reads. A turn that was spoken for
    // was answered, however its transcript happens to read, and leaving it out would
    // lose the person's own half — which is the half that certainly happened (D15).
    const platform = await stubPlatform();
    platform.reply(replyingWith(["Được."]));
    try {
      const config = configFor(platform.url, { language: "vietnamese" });
      const conversations = createConversations(config);

      await takeTurn(
        config, gadgetFor(config), conversations, registry, { text:"giảm âm lượng" }, noSink
      );

      assert.deepEqual(conversations.history("b81f3f4a9b01"), [
        { role: "user", content: "asked 1" },
        { role: "agent", content: "Được." },
      ]);
    } finally {
      platform.stop();
    }
  });
});

describe("the gadget's condition, on the turn", () => {
  // The device's own report, as `gadget.ts` writes it — the one string the platform
  // ever sees about the gadget on the other end.
  const REPORT =
    "The device this reply is spoken through reports its own state as: speaker volume 42 of 100; " +
    "battery 12%, not charging.";

  it("carries the gadget's own report, after the persona's own words", async () => {
    // 42 and 12% are the gadget's facts; "nearly flat" is nobody's. What is pinned
    // here is that the report reaches the model word for word and unembellished, which
    // is the bridge's whole share of the requirement — whether the model then says
    // anything sensible with it is the model's, and is checked on the device.
    const platform = await stubPlatform();
    platform.reply(replyingWith(["ok"]));
    try {
      const config = configFor(platform.url);

      await takeTurn(
        config, gadgetFor(config), createConversations(config), registry, { text:"how are you", gadgetCondition: REPORT }, noSink
      );

      const [turn] = platform.requests.filter((r) => r.path.includes("stream"));
      const prompt = fieldOf(turn.body, "systemPrompt");
      assert.ok(prompt !== null);
      assert.ok(prompt.startsWith("You are an interview coach."), `the persona's own words still open it: ${prompt}`);
      assert.ok(prompt.includes(REPORT), `the report is carried verbatim: ${prompt}`);
      // Read back through the multipart encoder's own line endings: `FormData` writes a
      // field's newlines as CRLF, the way a browser posts a form, and that is the wire
      // format rather than anything this module decided.
      assert.equal(prompt.replace(/\r\n/g, "\n"), `You are an interview coach.\n\n${REPORT}`);
    } finally {
      platform.stop();
    }
  });

  it("asks for a turn with no condition exactly as it asked before this existed", async () => {
    // A gadget that reported nothing, or whose report could not be read, sends a turn
    // byte-identical to one from a bridge that has never heard of the gadget's
    // condition: no placeholder, no empty appendix (requirement 5).
    const platform = await stubPlatform();
    platform.reply(replyingWith(["ok"]));
    try {
      const config = configFor(platform.url);

      await takeTurn(
        config, gadgetFor(config), createConversations(config), registry, { text:"how are you" }, noSink
      );

      const [turn] = platform.requests.filter((r) => r.path.includes("stream"));
      assert.equal(fieldOf(turn.body, "systemPrompt"), "You are an interview coach.");
    } finally {
      platform.stop();
    }
  });

  it("leaves the conversation the condition is not part of untouched", async () => {
    // The condition is per turn and never recorded: a later turn carries it again from
    // the gadget, and the history behind it holds only what was actually said.
    const platform = await stubPlatform();
    platform.reply(replyingWith(["first answer", "second answer"]));
    try {
      const config = configFor(platform.url);
      const conversations = createConversations(config);

      await takeTurn(
        config, gadgetFor(config), conversations, registry, { text:"one", gadgetCondition: REPORT }, noSink
      );
      await takeTurn(
        config, gadgetFor(config), conversations, registry, { text:"two" }, noSink
      );

      const turns = platform.requests.filter((r) => r.path.includes("stream"));
      assert.deepEqual(historyOf(turns[1].body), [
        { role: "user", content: "asked 1" },
        { role: "agent", content: "first answer" },
      ]);
      assert.equal(fieldOf(turns[1].body, "systemPrompt"), "You are an interview coach.");
    } finally {
      platform.stop();
    }
  });
});
