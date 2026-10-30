import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { ENDPOINTER_DEFAULTS, MUSIC_GAIN_DB_DEFAULT, type BridgeConfig } from "../src/config.js";
import { deriveToken } from "../src/credentials.js";
import type { HardwareReport } from "../src/protocol/hardware.js";
import { RegistryError, type ActivationState, type Gadget, type Registry } from "../src/registry.js";
import { createOtaServer } from "../src/server/ota.js";

/**
 * The OTA endpoint is the first thing a device asks and the only place it learns
 * where to connect. It is no longer the gate: a gadget nobody owns has to reach
 * it to receive its activation code, so what is pinned here is the two answers —
 * an owned gadget is given its address and its own token, an unclaimed one gets
 * the address plus a code — and what happens when the console cannot answer.
 */
const BOARD = "b8:1f:3f:4a:9b:01";
const SECRET = "s".repeat(43);

function configFor(otaPort: number): BridgeConfig {
  return {
    otaPort,
    wsPort: 8001,
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
    historyTurns: 20,
    commandStep: 10,
    handoverMs: 400,
  };
}

function gadgetFor(overrides: Partial<Gadget> = {}): Gadget {
  return {
    deviceId: "b81f3f4a9b01",
    owned: true,
    secret: SECRET,
    agent: null,
    partner: null,
    turns: [],
    firmware: null,
    ...overrides,
  };
}

function fakeRegistry(
  resolve: (deviceId: string) => Gadget | Promise<Gadget>,
  activate: (deviceId: string) => ActivationState | Promise<ActivationState> = () => "owned",
  reportHardware: (deviceId: string, hardware: HardwareReport) => void = () => {}
): Registry {
  return {
    resolve: async (deviceId) => resolve(deviceId),
    reportTools: () => {},
    reportHardware: (deviceId, hardware) => reportHardware(deviceId, hardware),
    activate: async (deviceId) => activate(deviceId),
    recordTurn: () => {},
    forget: () => {},
  };
}

async function startedServer(
  registry: Registry = fakeRegistry(() => gadgetFor()),
  config: BridgeConfig = configFor(0)
) {
  const server = createOtaServer(config, registry);
  if (!server.address()) await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}

function ask(port: number, headers: Record<string, string> = { "device-id": BOARD }) {
  return fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`, { headers });
}

describe("the OTA endpoint", () => {
  it("answers the flashed path with the address and the device's own token", async () => {
    const { port, stop } = await startedServer();
    try {
      const res = await ask(port, { "device-id": BOARD, "client-id": "test", "activation-version": "1" });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);

      const body = (await res.json()) as {
        websocket: { url: string; token: string; version: number };
        server_time: { timestamp: number; timezone_offset: number };
        activation?: unknown;
      };
      assert.equal(body.websocket.url, "ws://127.0.0.1:8001/xiaozhi/v1/");
      assert.equal(body.websocket.token, deriveToken(SECRET, BOARD), "the token issued is the one the socket will accept");
      assert.equal(body.websocket.version, 3, "the framing version the device must use comes from here");
      assert.equal(body.activation, undefined, "an owned gadget is not asked to activate");
      assert.ok(
        Math.abs(Date.now() - body.server_time.timestamp) < 60_000,
        "the device sets its clock from this, so it has to be the current time"
      );
      assert.ok(Number.isInteger(body.server_time.timezone_offset), "minutes east of UTC, as an integer");
    } finally {
      stop();
    }
  });

  it("names the TLS front when one is configured, and the raw address when it is not", async () => {
    // The device trusts this answer for both addresses, so a front that terminates
    // TLS has to be what the answer names — the raw ports stay plain and are no
    // longer opened to the internet.
    const fronted = await startedServer(fakeRegistry(() => gadgetFor()), {
      ...configFor(0),
      publicUrl: "https://gw.example.test",
    });
    try {
      const body = (await (await ask(fronted.port, { "device-id": BOARD })).json()) as {
        websocket: { url: string };
      };
      assert.equal(body.websocket.url, "wss://gw.example.test/xiaozhi/v1/");

      const page = await (await fetch(`http://127.0.0.1:${fronted.port}/`)).text();
      assert.match(page, /ota {6}https:\/\/gw\.example\.test\/xiaozhi\/ota\//);
      assert.match(page, /ws {7}wss:\/\/gw\.example\.test\/xiaozhi\/v1\//);
    } finally {
      fronted.stop();
    }

    const raw = await startedServer();
    try {
      const body = (await (await ask(raw.port, { "device-id": BOARD })).json()) as {
        websocket: { url: string };
      };
      assert.equal(body.websocket.url, "ws://127.0.0.1:8001/xiaozhi/v1/", "no front named, no change");
    } finally {
      raw.stop();
    }
  });

  it("answers an unclaimed gadget with a code and still with the address", async () => {
    const registry = fakeRegistry(() => gadgetFor({ owned: false, activation: { code: "481902" } }));
    const { port, stop } = await startedServer(registry);
    try {
      const res = await ask(port);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        websocket: { token: string };
        activation: { code: string; message: string; timeout_ms: number };
      };
      assert.equal(body.activation.code, "481902");
      assert.ok(body.activation.message.length > 0, "the gadget speaks this message");
      assert.ok(body.activation.timeout_ms > 0);
      assert.equal(body.websocket.token, deriveToken(SECRET, BOARD), "the token is issued before activation, and survives it");
    } finally {
      stop();
    }
  });

  it("refuses to answer at all when the console cannot be reached", async () => {
    const registry = fakeRegistry(() => {
      throw new RegistryError("the console could not be reached at http://console");
    });
    const { port, stop } = await startedServer(registry);
    try {
      const res = await ask(port);
      assert.equal(res.status, 503);
      assert.ok(!(await res.text()).includes("ws://"), "an unresolved gadget gets no address");
    } finally {
      stop();
    }
  });

  it("answers 429 when the console is rate-limiting this identifier", async () => {
    const registry = fakeRegistry(() => {
      throw new RegistryError("too many claim requests", 429);
    });
    const { port, stop } = await startedServer(registry);
    try {
      assert.equal((await ask(port)).status, 429);
    } finally {
      stop();
    }
  });

  it("refuses a device that does not identify itself", async () => {
    // The identifier is what the token is derived from, so this is no longer a
    // warning: there is nothing to issue a credential against.
    const { port, stop } = await startedServer();
    try {
      const res = await ask(port, {});
      assert.equal(res.status, 400);
      assert.ok(!(await res.text()).includes("ws://"));
    } finally {
      stop();
    }
  });

  it("answers a human at / with the addresses, and 404s anything else", async () => {
    const { port, stop } = await startedServer();
    try {
      const root = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(root.status, 200);
      const text = await root.text();
      assert.match(text, /xiaozhi\/ota/);
      assert.ok(!text.includes(SECRET), "the human page must not leak the device secret");
      assert.ok(!text.includes("console-token-abcdefgh"), "nor the console's credential");

      const missing = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/firmware`);
      assert.equal(missing.status, 404, "a path we do not serve is logged, not answered with the address");
    } finally {
      stop();
    }
  });
});

describe("the activation endpoint", () => {
  async function activate(port: number) {
    return fetch(`http://127.0.0.1:${port}/xiaozhi/ota/activate`, {
      method: "POST",
      headers: { "device-id": BOARD },
      body: "{}",
    });
  }

  it("answers 202 while the claim is pending, which is what the firmware reads as 'keep waiting'", async () => {
    const { port, stop } = await startedServer(fakeRegistry(() => gadgetFor({ owned: false }), () => "pending"));
    try {
      assert.equal((await activate(port)).status, 202);
    } finally {
      stop();
    }
  });

  it("answers 200 once the claim is complete", async () => {
    const { port, stop } = await startedServer(fakeRegistry(() => gadgetFor(), () => "owned"));
    try {
      assert.equal((await activate(port)).status, 200);
    } finally {
      stop();
    }
  });

  it("answers 404 for an identifier the console knows no claim for", async () => {
    const { port, stop } = await startedServer(fakeRegistry(() => gadgetFor({ owned: false }), () => "unknown"));
    try {
      assert.equal((await activate(port)).status, 404);
    } finally {
      stop();
    }
  });
});

/** The body the firmware posts, as `GetSystemInfoJson` builds it. */
const SYSTEM_INFO = {
  version: 2,
  language: "vi",
  flash_size: 16_777_216,
  mac_address: "b8:1f:3f:4a:9b:01",
  uuid: "00000000-0000-4000-8000-000000000000",
  chip_model_name: "esp32s3",
  chip_info: { model: 1, cores: 2, revision: 0, features: 0 },
  application: {
    name: "xiaozhi",
    version: "1.2.3",
    compile_time: "2026-10-01T00:00:00Z",
    idf_version: "v5.4",
    elf_sha256: "deadbeef",
  },
  partition_table: [{ label: "app", type: 1, subtype: 2 }],
  ota: { label: "ota_0" },
  display: { monochrome: false, width: 320, height: 240 },
  board: {
    type: "esp-box-3",
    name: "ESP32-S3-BOX-3",
    manufacturer: "espressif",
    ssid: "home",
    rssi: -40,
    channel: 6,
    ip: "192.168.1.20",
    mac: "b8:1f:3f:4a:9b:01",
  },
};

function postOta(port: number, body: string) {
  return fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`, {
    method: "POST",
    headers: { "device-id": BOARD, "content-type": "application/json" },
    body,
  });
}

describe("the board report", () => {
  it("reads the OTA body and hands over only the board facts", async () => {
    const seen: { deviceId: string; hardware: HardwareReport }[] = [];
    const { port, stop } = await startedServer(
      fakeRegistry(() => gadgetFor(), () => "owned", (deviceId, hardware) =>
        seen.push({ deviceId, hardware })
      )
    );
    try {
      const res = await postOta(port, JSON.stringify(SYSTEM_INFO));
      assert.equal(res.status, 200);

      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.deviceId, BOARD);
      assert.deepEqual(seen[0]!.hardware, {
        board: { type: "esp-box-3", name: "ESP32-S3-BOX-3", manufacturer: "espressif" },
        chip: "esp32s3",
        flashSize: 16_777_216,
        display: { width: 320, height: 240, monochrome: false },
        application: { name: "xiaozhi", version: "1.2.3" },
        language: "vi",
      });
      const forwarded = JSON.stringify(seen[0]!.hardware);
      for (const identifier of ["b8:1f", "uuid", "192.168", "ssid", "imei", "partition", "sha256"]) {
        assert.ok(!forwarded.includes(identifier), `${identifier} must not be forwarded`);
      }
    } finally {
      stop();
    }
  });

  it("answers as it did before when the body is absent, not JSON, or oversized", async () => {
    const seen: HardwareReport[] = [];
    const { port, stop } = await startedServer(
      fakeRegistry(() => gadgetFor(), () => "owned", (_deviceId, hardware) => seen.push(hardware))
    );
    try {
      const absent = await ask(port);
      assert.equal(absent.status, 200);
      assert.ok(((await absent.json()) as { websocket: { token: string } }).websocket.token);

      const malformed = await postOta(port, "not json");
      assert.equal(malformed.status, 200);
      assert.ok(((await malformed.json()) as { websocket: { token: string } }).websocket.token);

      const oversized = await postOta(
        port,
        JSON.stringify({ ...SYSTEM_INFO, padding: "x".repeat(40 * 1024) })
      );
      assert.equal(oversized.status, 200);
      assert.ok(((await oversized.json()) as { websocket: { token: string } }).websocket.token);

      assert.equal(seen.length, 0, "nothing readable was in any of those bodies");
    } finally {
      stop();
    }
  });

  it("does not change the answer when the console cannot take the report", async () => {
    const { port, stop } = await startedServer(
      fakeRegistry(() => gadgetFor(), () => "owned", () => {
        throw new Error("the console is down");
      })
    );
    try {
      const res = await postOta(port, JSON.stringify(SYSTEM_INFO));
      assert.equal(res.status, 200);
      assert.equal((await res.json() as { websocket: { version: number } }).websocket.version, 3);
    } finally {
      stop();
    }
  });
});

describe("the firmware block in the answer", () => {
  const FIRMWARE = {
    version: "1.2.4",
    url: "https://console.example.com/firmware/6f1c2a3e",
    force: false,
  };

  it("is present for an owned device that carries a target, with force as a number", async () => {
    const { port, stop } = await startedServer(
      fakeRegistry(() => gadgetFor({ firmware: FIRMWARE }))
    );
    try {
      const res = await ask(port);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        websocket: { token: string; version: number };
        firmware?: { version: string; url: string; force: unknown };
      };
      assert.deepEqual(body.firmware, { ...FIRMWARE, force: 0 });
      assert.equal(body.websocket.version, 3, "the rest of the answer is unchanged");
      assert.equal(typeof body.websocket.token, "string");
    } finally {
      stop();
    }
  });

  it("says force is 1 when the target is forced", async () => {
    const { port, stop } = await startedServer(
      fakeRegistry(() => gadgetFor({ firmware: { ...FIRMWARE, force: true } }))
    );
    try {
      const body = (await (await ask(port)).json()) as { firmware?: { force: unknown } };
      assert.equal(body.firmware?.force, 1);
    } finally {
      stop();
    }
  });

  it("is absent when the gadget carries no target", async () => {
    const { port, stop } = await startedServer(fakeRegistry(() => gadgetFor()));
    try {
      const body = (await (await ask(port)).json()) as Record<string, unknown>;
      assert.equal("firmware" in body, false);
    } finally {
      stop();
    }
  });

  it("is absent for a device nobody owns, even if a target were carried", async () => {
    const { port, stop } = await startedServer(
      fakeRegistry(() => gadgetFor({ owned: false, activation: { code: "481902" }, firmware: FIRMWARE }))
    );
    try {
      const body = (await (await ask(port)).json()) as Record<string, unknown>;
      assert.equal("firmware" in body, false);
      assert.ok(body.activation, "an unclaimed gadget still gets its code");
    } finally {
      stop();
    }
  });
});
