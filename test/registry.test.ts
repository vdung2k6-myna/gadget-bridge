import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ENDPOINTER_DEFAULTS, MUSIC_GAIN_DB_DEFAULT, type BridgeConfig } from "../src/config.js";
import { createRegistry, RegistryError } from "../src/registry.js";

/**
 * The console is what every connection reads, so what is pinned here is the two
 * behaviours that decide whether a gadget is served: a resolution is reused for
 * the window the deployment states, and anything the console does not answer
 * cleanly is refused rather than remembered.
 */
const CONSOLE = "http://127.0.0.1:3001";
const TOKEN = "console-token-abcdefgh";

function configFor(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    otaPort: 0,
    wsPort: 8001,
    publicHost: "127.0.0.1",
    consoleUrl: CONSOLE,
    consoleToken: TOKEN,
    registryTtlMs: 60_000,
    framing: 3,
    serverRate: 24000,
    frameMs: 60,
    ...ENDPOINTER_DEFAULTS,
    sessionIdleMs: 60000,
    musicDir: "",
    musicGainDb: MUSIC_GAIN_DB_DEFAULT,
    historyTurns: 20,
    commandStep: 10,
    handoverMs: 400,
    ...overrides,
  };
}

const OWNED = {
  deviceId: "b81f3f4a9b01",
  owned: true,
  secret: "s".repeat(43),
  partner: null,
  agent: {
    id: "agent-1",
    name: "assistant",
    systemPrompt: "be helpful",
    language: "vietnamese",
    engine: "engine-a",
    answerMode: "generate",
    topics: ["Truyện cười"],
    runtime: { baseUrl: "http://127.0.0.1:4000", token: "runtime-token" },
  },
  turns: [{ userText: "xin chào", assistantText: "chào bạn" }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The three profiles as the console resolves them: keys decrypted, names kept for the record. */
const PROVIDERS = {
  stt: {
    name: "audio.cpp",
    baseUrl: "https://stt.example/v1",
    model: "whisper-1",
    apiKey: "sk-stt-abc",
  },
  tts: {
    name: "engine-a-vi",
    baseUrl: "https://tts.example/v1",
    model: "tts-1",
    voice: "alloy",
    apiKey: "sk-tts-abc",
  },
  llm: {
    name: "gpt-mini",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "sk-llm-abc",
    temperature: 0.3,
  },
};

describe("resolving a gadget", () => {
  it("reuses a resolution inside the window, and asks again after it", async () => {
    let calls = 0;
    let clock = 1_000;
    const registry = createRegistry(
      configFor(),
      async () => {
        calls += 1;
        return jsonResponse(OWNED);
      },
      () => clock
    );

    await registry.resolve("B8-1F-3F-4A-9B-01");
    await registry.resolve("b81f3f4a9b01");
    assert.equal(calls, 1, "a resolution is reused for the window the deployment states");

    clock += 60_001;
    await registry.resolve("b8:1f:3f:4a:9b:01");
    assert.equal(calls, 2, "and asked again once the window has passed");
  });

  it("parses the agent, the runtime and the recorded turns", async () => {
    const registry = createRegistry(configFor(), async () => jsonResponse(OWNED));
    const gadget = await registry.resolve("b8:1f:3f:4a:9b:01");

    assert.equal(gadget.owned, true);
    assert.equal(gadget.secret, OWNED.secret);
    assert.equal(gadget.agent?.language, "vietnamese");
    assert.equal(gadget.agent?.engine, "engine-a");
    assert.deepEqual(gadget.agent?.runtime, { baseUrl: "http://127.0.0.1:4000", token: "runtime-token" });
    assert.deepEqual(gadget.turns, [{ user: "xin chào", agent: "chào bạn" }]);
  });

  it("carries the claim code of an unclaimed gadget, and no agent", async () => {
    const registry = createRegistry(configFor(), async () =>
      jsonResponse({
        deviceId: "b81f3f4a9b01",
        owned: false,
        secret: "s".repeat(43),
        activation: { code: "481902" },
      })
    );
    const gadget = await registry.resolve("b8:1f:3f:4a:9b:01");
    assert.equal(gadget.owned, false);
    assert.equal(gadget.agent, null);
    assert.equal(gadget.activation?.code, "481902");
  });

  it("refuses an unreachable console rather than remembering an answer", async () => {
    const registry = createRegistry(configFor(), async () => {
      throw new Error("ECONNREFUSED");
    });
    await assert.rejects(() => registry.resolve("b8:1f:3f:4a:9b:01"), RegistryError);
  });

  it("refuses a resolution that names another device", async () => {
    const registry = createRegistry(configFor(), async () => jsonResponse({ ...OWNED, deviceId: "aa11bb22cc33" }));
    await assert.rejects(() => registry.resolve("b8:1f:3f:4a:9b:01"), /not b81f3f4a9b01/);
  });

  it("carries the account's model when the agent names one", async () => {
    const registry = createRegistry(configFor(), async () =>
      jsonResponse({
        ...OWNED,
        agent: {
          ...OWNED.agent,
          llm: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-live-abc123", temperature: 0.4 },
        },
      })
    );
    const gadget = await registry.resolve("b8:1f:3f:4a:9b:01");
    assert.deepEqual(gadget.agent?.providers.llm, {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-live-abc123",
      temperature: 0.4,
    });
  });

  it("carries null when the agent names none", async () => {
    const registry = createRegistry(configFor(), async () => jsonResponse(OWNED));
    const gadget = await registry.resolve("b8:1f:3f:4a:9b:01");
    assert.equal(gadget.agent?.providers.llm, null);
  });

  it("refuses a malformed model profile rather than half-reading it", async () => {
    const registry = createRegistry(configFor(), async () =>
      jsonResponse({ ...OWNED, agent: { ...OWNED.agent, llm: { baseUrl: "https://api.openai.com/v1" } } })
    );
    await assert.rejects(() => registry.resolve("b8:1f:3f:4a:9b:01"), /incomplete LLM profile/);
  });

  it("carries each provider the console resolved, whole", async () => {
    const registry = createRegistry(configFor(), async () =>
      jsonResponse({ ...OWNED, agent: { ...OWNED.agent, providers: PROVIDERS } })
    );
    const gadget = await registry.resolve("b8:1f:3f:4a:9b:01");
    assert.deepEqual(gadget.agent?.providers, PROVIDERS);
  });

  it("refuses half a speech provider rather than sending it", async () => {
    // An endpoint with no model is a request that fails where the person cannot see why,
    // so it is refused against the console's answer instead of on the wire.
    const registry = createRegistry(configFor(), async () =>
      jsonResponse({
        ...OWNED,
        agent: {
          ...OWNED.agent,
          providers: { stt: null, tts: { baseUrl: "https://tts.example/v1", voice: "alloy" }, llm: null },
        },
      })
    );
    await assert.rejects(() => registry.resolve("b8:1f:3f:4a:9b:01"), /incomplete tts provider/);
  });

  it("refuses a tts provider with no voice, which is the half that speaks", async () => {
    const registry = createRegistry(configFor(), async () =>
      jsonResponse({
        ...OWNED,
        agent: {
          ...OWNED.agent,
          providers: {
            stt: null,
            tts: { name: "silent", baseUrl: "https://tts.example/v1", model: "tts-1" },
            llm: null,
          },
        },
      })
    );
    await assert.rejects(() => registry.resolve("b8:1f:3f:4a:9b:01"), /tts provider with no voice/);
  });

  it("never writes a provider's key to the log", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    try {
      const registry = createRegistry(configFor(), async () =>
        jsonResponse({ ...OWNED, agent: { ...OWNED.agent, providers: PROVIDERS } })
      );
      await registry.resolve("b8:1f:3f:4a:9b:01");
    } finally {
      console.log = original;
    }
    const written = lines.join("\n");
    for (const key of [PROVIDERS.stt.apiKey, PROVIDERS.tts.apiKey, PROVIDERS.llm.apiKey]) {
      assert.ok(!written.includes(key), `the log carries no ${key}`);
    }
  });

  it("carries an engine it does not recognise, because this bridge names no engine", async () => {
    // The engine is a compatibility string for the runtime's legacy path: this
    // bridge neither knows nor validates it, so a deployment may drop its audio
    // stack without this repository knowing what was in it.
    const registry = createRegistry(configFor(), async () =>
      jsonResponse({ ...OWNED, agent: { ...OWNED.agent, engine: "whisper" } })
    );
    const gadget = await registry.resolve("b8:1f:3f:4a:9b:01");
    assert.equal(gadget.agent?.engine, "whisper");
  });
});

describe("reporting a catalogue", () => {
  it("posts the gadget's tools for its own device, however the identifier was written", async () => {
    const calls: { url: string; body: string }[] = [];
    const registry = createRegistry(configFor(), async (url, init) => {
      calls.push({ url: String(url), body: String((init as RequestInit | undefined)?.body ?? "") });
      return new Response(null, { status: 204 });
    });

    registry.reportTools("B8-1F-3F-4A-9B-01", [
      { name: "self.get_device_status", description: "Provides the real-time information." },
    ]);
    // Fire-and-forget: give the promise it started a turn of the event loop.
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(calls[0]?.url, `${CONSOLE}/api/bridge/tools`);
    const body = JSON.parse(calls[0]!.body) as {
      deviceId: string;
      tools: { name: string; description: string }[];
    };
    assert.equal(body.deviceId, "b81f3f4a9b01");
    assert.deepEqual(body.tools, [
      { name: "self.get_device_status", description: "Provides the real-time information." },
    ]);
  });

  it("does not throw, and does not change the session, when the console refuses it", async () => {
    const registry = createRegistry(configFor(), async () => {
      throw new Error("ECONNREFUSED");
    });

    assert.doesNotThrow(() =>
      registry.reportTools("b8:1f:3f:4a:9b:01", [{ name: "x", description: "y" }])
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe("asking about a claim", () => {
  it("maps the console's answers to the three states", async () => {
    for (const [status, state] of [
      [200, "owned"],
      [202, "pending"],
      [404, "unknown"],
    ] as const) {
      const registry = createRegistry(configFor(), async () => jsonResponse({}, status));
      assert.equal(await registry.activate("b8:1f:3f:4a:9b:01"), state);
    }
  });
});

describe("a claim inside the cache window", () => {
  it("drops the cached 'unowned' answer the moment the claim completes", async () => {
    // A gadget is claimed while the bridge still holds its unowned resolution.
    // The next connection must see the owner, or the board that was just claimed
    // is told it belongs to nobody until the window ends.
    let calls = 0;
    const registry = createRegistry(configFor(), async (url) => {
      if (String(url).endsWith("/api/bridge/activate")) return jsonResponse({ activated: true });
      calls += 1;
      return jsonResponse(OWNED);
    });

    await registry.resolve("b8:1f:3f:4a:9b:01");
    assert.equal(calls, 1);
    await registry.activate("b8:1f:3f:4a:9b:01");
    await registry.resolve("b8:1f:3f:4a:9b:01");
    assert.equal(calls, 2, "the cached answer was dropped when the claim completed");
  });
});

describe("recording a turn", () => {
  it("never throws, whatever the console does — the reply has already been spoken", async () => {
    const rejecting = createRegistry(configFor(), async () => {
      throw new Error("ECONNREFUSED");
    });
    assert.doesNotThrow(() =>
      rejecting.recordTurn({
        deviceId: "b81f3f4a9b01",
        userText: "a",
        assistantText: "b",
        language: "vietnamese",
        engine: "engine-a",
        startedAt: new Date(),
        endedAt: new Date(),
      })
    );

    // Give the rejected promise a turn of the event loop to surface: if it were
    // unhandled, node would report it and this test would fail.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe("reporting the board", () => {
  it("posts the report for its own device, however the identifier was written", async () => {
    const calls: { url: string; body: string }[] = [];
    const registry = createRegistry(configFor(), async (url, init) => {
      calls.push({ url: String(url), body: String((init as RequestInit | undefined)?.body ?? "") });
      return new Response(null, { status: 204 });
    });

    registry.reportHardware("B8-1F-3F-4A-9B-01", {
      board: { type: "esp-box-3" },
      chip: "esp32s3",
      display: { width: 320, height: 240, monochrome: false },
    });
    // Fire-and-forget: give the promise it started a turn of the event loop.
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(calls[0]?.url, `${CONSOLE}/api/bridge/hardware`);
    const body = JSON.parse(calls[0]!.body) as { deviceId: string; hardware: unknown };
    assert.equal(body.deviceId, "b81f3f4a9b01");
    assert.deepEqual(body.hardware, {
      board: { type: "esp-box-3" },
      chip: "esp32s3",
      display: { width: 320, height: 240, monochrome: false },
    });
  });

  it("does not throw, and does not change the session, when the console is unreachable", async () => {
    const registry = createRegistry(configFor(), async () => {
      throw new Error("ECONNREFUSED");
    });

    assert.doesNotThrow(() => registry.reportHardware("b8:1f:3f:4a:9b:01", { chip: "esp32s3" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe("the firmware target in a resolution", () => {
  const FIRMWARE = {
    version: "1.2.4",
    url: "https://console.example.com/firmware/6f1c2a3e",
    force: false,
  };

  it("carries a target the firmware can use", async () => {
    const registry = createRegistry(configFor(), async () =>
      jsonResponse({ ...OWNED, firmware: FIRMWARE })
    );
    const gadget = await registry.resolve("b8:1f:3f:4a:9b:01");
    assert.deepEqual(gadget.firmware, FIRMWARE);
  });

  it("carries the force flag as a boolean", async () => {
    const registry = createRegistry(configFor(), async () =>
      jsonResponse({ ...OWNED, firmware: { ...FIRMWARE, force: true } })
    );
    const gadget = await registry.resolve("b8:1f:3f:4a:9b:01");
    assert.equal(gadget.firmware?.force, true);
  });

  it("drops an unusable target and still serves the session", async () => {
    for (const firmware of [
      "a target",
      {},
      { version: "", url: FIRMWARE.url },
      { version: "1.2.4", url: "" },
      { version: "1.2.4", url: "/firmware/6f1c2a3e" },
      { version: "1.2.4", url: "ftp://console.example.com/firmware/6f1c2a3e" },
      { version: "1.2.4", url: "not a url" },
    ]) {
      const registry = createRegistry(configFor(), async () =>
        jsonResponse({ ...OWNED, firmware })
      );
      const gadget = await registry.resolve("b8:1f:3f:4a:9b:01");
      assert.equal(gadget.owned, true);
      assert.equal(gadget.firmware, null, JSON.stringify(firmware));
    }
  });

  it("carries null when the console sends none", async () => {
    const registry = createRegistry(configFor(), async () => jsonResponse(OWNED));
    const gadget = await registry.resolve("b8:1f:3f:4a:9b:01");
    assert.equal(gadget.firmware, null);
  });
});
