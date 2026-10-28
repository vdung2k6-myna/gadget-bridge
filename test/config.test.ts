import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  ENDPOINTER_DEFAULTS,
  MUSIC_GAIN_DB_DEFAULT,
} from "../src/config.js";

/**
 * The configuration is where the rules that must not fail open live. Two values
 * have no default on purpose: the console's address, because the only obvious
 * default is localhost and localhost is right on one machine and silently wrong
 * on every other; and the console's credential, because a bridge that cannot
 * authenticate to the console is a bridge that can resolve no gadget at all.
 *
 * What used to be here — the allowlist, the device secret, the per-device
 * persona/language/engine bindings and the pair — is no longer configuration:
 * it is the console's data, and this file pins that the bridge refuses those
 * settings rather than starting with them silently ignored.
 */
const CONSOLE = "http://127.0.0.1:3001";
const TOKEN = "console-token-abcdefgh";

/** The minimum a config needs to load: the console and its credential. */
const minimal = {
  BRIDGE_CONSOLE_URL: CONSOLE,
  BRIDGE_CONSOLE_TOKEN: TOKEN,
} as NodeJS.ProcessEnv;

const withEnv = (fields: Record<string, string>): NodeJS.ProcessEnv =>
  ({ ...minimal, ...fields }) as NodeJS.ProcessEnv;

describe("the console's address", () => {
  it("refuses to load without one, because the obvious default is localhost", () => {
    assert.throws(
      () => loadConfig({ BRIDGE_CONSOLE_TOKEN: TOKEN }),
      /BRIDGE_CONSOLE_URL must be set/
    );
  });

  it("drops trailing slashes, so joining a path is a plain concatenation", () => {
    assert.equal(loadConfig(withEnv({ BRIDGE_CONSOLE_URL: `${CONSOLE}/` })).consoleUrl, CONSOLE);
  });

  it("keeps a base path, since a deployment may front the console with one", () => {
    assert.equal(
      loadConfig(withEnv({ BRIDGE_CONSOLE_URL: `${CONSOLE}/console` })).consoleUrl,
      `${CONSOLE}/console`
    );
  });

  it("tolerates surrounding whitespace, unlike the credential", () => {
    assert.equal(loadConfig(withEnv({ BRIDGE_CONSOLE_URL: `  ${CONSOLE}  ` })).consoleUrl, CONSOLE);
  });

  it("refuses anything that is not an http(s) base URL", () => {
    for (const bad of ["console.example.com", "ftp://console", `${CONSOLE}/?a=1`]) {
      assert.throws(() => loadConfig(withEnv({ BRIDGE_CONSOLE_URL: bad })), /BRIDGE_CONSOLE_URL/, bad);
    }
  });
});

describe("the console's credential", () => {
  it("refuses to load without one, so a bridge never starts unable to resolve a gadget", () => {
    assert.throws(
      () => loadConfig({ BRIDGE_CONSOLE_URL: CONSOLE }),
      /BRIDGE_CONSOLE_TOKEN must be set/
    );
  });

  it("treats a value that is only whitespace as absent", () => {
    assert.throws(
      () => loadConfig(withEnv({ BRIDGE_CONSOLE_TOKEN: "   " })),
      /BRIDGE_CONSOLE_TOKEN must be set/
    );
  });

  it("carries the token byte for byte, since the console compares it exactly", () => {
    const asIssued = ` ${TOKEN} `;
    assert.equal(loadConfig(withEnv({ BRIDGE_CONSOLE_TOKEN: asIssued })).consoleToken, asIssued);
  });
});

describe("the rest of the configuration", () => {
  it("keeps the values that were already settled", () => {
    const config = loadConfig(minimal);
    assert.equal(config.otaPort, 8003);
    assert.equal(config.wsPort, 8001);
    assert.equal(config.framing, 3);
    assert.equal(config.serverRate, 24000);
    assert.equal(config.frameMs, 60);
    assert.equal(config.registryTtlMs, 60_000);
  });

  it("reads the endpointer's own defaults, which are not the downlink's rate", () => {
    const config = loadConfig(minimal);
    assert.equal(config.deviceRate, ENDPOINTER_DEFAULTS.deviceRate);
    assert.equal(config.vadSilenceMs, ENDPOINTER_DEFAULTS.vadSilenceMs);
    assert.equal(config.vadMinSpeechMs, ENDPOINTER_DEFAULTS.vadMinSpeechMs);
    assert.equal(config.vadSpeechWindowMs, ENDPOINTER_DEFAULTS.vadSpeechWindowMs);
    assert.equal(config.vadNoSpeechMs, ENDPOINTER_DEFAULTS.vadNoSpeechMs);
  });

  it("refuses an endpointer that could never close a turn", () => {
    assert.throws(
      () =>
        loadConfig(
          withEnv({
            BRIDGE_VAD_SPEECH_WINDOW_MS: "1000",
            BRIDGE_VAD_SILENCE_MS: "900",
            BRIDGE_VAD_MIN_SPEECH_MS: "200",
          })
        ),
      /speech ages out of the window/
    );
  });

  it("refuses a floor ratio that is not a positive number", () => {
    assert.throws(
      () => loadConfig(withEnv({ BRIDGE_VAD_FLOOR_RATIO: "0" })),
      /BRIDGE_VAD_FLOOR_RATIO/
    );
  });

  it("reads the session window, where nought is a value and not a mistake", () => {
    assert.equal(loadConfig(withEnv({ BRIDGE_SESSION_IDLE_MS: "0" })).sessionIdleMs, 0);
  });

  it("leaves the bridge with no music unless a deployment says where it is", () => {
    assert.equal(loadConfig(minimal).musicDir, "");
  });

  it("plays a track at the measured level unless a deployment says otherwise", () => {
    assert.equal(loadConfig(minimal).musicGainDb, MUSIC_GAIN_DB_DEFAULT);
    assert.equal(loadConfig(withEnv({ BRIDGE_MUSIC_GAIN_DB: "0" })).musicGainDb, 0);
  });

  it("still refuses a malformed value rather than falling back", () => {
    assert.throws(() => loadConfig(withEnv({ WS_PORT: "eight thousand" })), /WS_PORT/);
  });
});

describe("the settings the console replaced", () => {
  const retired = [
    "BRIDGE_ALLOWED_DEVICES",
    "BRIDGE_DEVICE_PERSONAS",
    "BRIDGE_DEVICE_LANGUAGES",
    "BRIDGE_DEVICE_ENGINES",
    "BRIDGE_DEVICE_PARTNERS",
    "BRIDGE_DEVICE_SECRET",
    "BRIDGE_PLATFORM_URL",
    "API_AUTH_TOKEN",
    "BRIDGE_LANGUAGE",
    "BRIDGE_TURN_ENGINE",
  ];

  it("refuses every one of them, where it is still recorded — an empty line too", () => {
    for (const name of retired) {
      assert.throws(() => loadConfig(withEnv({ [name]: "" })), new RegExp(`${name} is no longer read`), name);
      assert.throws(() => loadConfig(withEnv({ [name]: "anything" })), new RegExp(`${name} is no longer read`), name);
    }
  });

  it("starts without any of them, which is every deployment after the move to the console", () => {
    const config = loadConfig(minimal);
    assert.equal(config.consoleUrl, CONSOLE);
  });
});
