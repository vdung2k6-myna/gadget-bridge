import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeDevice,
  deriveToken,
  describeDenial,
  normalizeDeviceId,
} from "../src/credentials.js";

/**
 * The credential is the trust boundary: a gadget's own secret, resolved from the
 * console, decides the token it may connect with. What is pinned here is not
 * only that a good device is accepted but *why* the others are not — an absent
 * header, a token for a different device, and a token derived under another
 * gadget's secret.
 *
 * There is no allowlist to test any more: a gadget the console does not know is
 * refused before this module is reached, and this module only ever sees a secret.
 */
const BOARD = "b8:1f:3f:4a:9b:01";
const SECOND = "b8:1f:3f:4a:9b:02";
const SECRET = "s".repeat(43);

describe("device identifiers", () => {
  it("treats separators and case as presentation, not identity", () => {
    const forms = [BOARD, BOARD.toUpperCase(), "b8-1f-3f-4a-9b-01", "b81f3f4a9b01", " B8:1F:3F:4A:9B:01 "];
    for (const form of forms) {
      assert.equal(normalizeDeviceId(form), "b81f3f4a9b01", JSON.stringify(form));
    }
  });

  it("does not confuse two devices that differ in a digit", () => {
    assert.notEqual(normalizeDeviceId(BOARD), normalizeDeviceId(SECOND));
  });
});

describe("the issued token", () => {
  it("is the same on every call, so a restart does not rotate a device's credential", () => {
    assert.equal(deriveToken(SECRET, BOARD), deriveToken(SECRET, BOARD));
  });

  it("does not depend on how the identifier was spelled", () => {
    assert.equal(deriveToken(SECRET, "B8-1F-3F-4A-9B-01"), deriveToken(SECRET, BOARD));
  });

  it("differs per device and per secret", () => {
    assert.notEqual(deriveToken(SECRET, BOARD), deriveToken(SECRET, SECOND));
    assert.notEqual(deriveToken(SECRET, BOARD), deriveToken("t".repeat(43), BOARD));
  });
});

describe("authorizing a connection", () => {
  const token = deriveToken(SECRET, BOARD);

  it("accepts the device the token was issued to, and names it", () => {
    assert.deepEqual(authorizeDevice(SECRET, { deviceId: BOARD, authorization: `Bearer ${token}` }), {
      ok: true,
      deviceId: "b81f3f4a9b01",
    });
  });

  it("accepts the bare token the firmware would send without the prefix", () => {
    assert.equal(authorizeDevice(SECRET, { deviceId: BOARD, authorization: token }).ok, true);
  });

  it("refuses a device that presents no credential", () => {
    assert.deepEqual(authorizeDevice(SECRET, { deviceId: BOARD }), { ok: false, reason: "no-token" });
    assert.deepEqual(authorizeDevice(SECRET, { deviceId: BOARD, authorization: "" }), {
      ok: false,
      reason: "no-token",
    });
  });

  it("refuses a device that declares no identifier", () => {
    assert.deepEqual(authorizeDevice(SECRET, { authorization: `Bearer ${token}` }), {
      ok: false,
      reason: "no-device-id",
    });
  });

  it("refuses a well-formed token that this bridge did not issue", () => {
    assert.deepEqual(authorizeDevice(SECRET, { deviceId: BOARD, authorization: "Bearer spike" }), {
      ok: false,
      reason: "token-mismatch",
    });
  });

  it("refuses one device's token presented by another", () => {
    const tokenForSecond = deriveToken(SECRET, SECOND);
    assert.deepEqual(
      authorizeDevice(SECRET, { deviceId: BOARD, authorization: `Bearer ${tokenForSecond}` }),
      { ok: false, reason: "token-mismatch" }
    );
  });

  it("refuses a token of the right shape but the wrong length without throwing", () => {
    // timingSafeEqual throws on a length difference; a refusal is what is meant.
    assert.deepEqual(authorizeDevice(SECRET, { deviceId: BOARD, authorization: "Bearer short" }), {
      ok: false,
      reason: "token-mismatch",
    });
  });

  it("refuses a token derived under a different secret — which is what a release does", () => {
    const stolen = deriveToken("u".repeat(43), BOARD);
    assert.deepEqual(authorizeDevice(SECRET, { deviceId: BOARD, authorization: `Bearer ${stolen}` }), {
      ok: false,
      reason: "token-mismatch",
    });
  });

  it("says in words why a connection was refused", () => {
    for (const reason of ["no-device-id", "no-token", "token-mismatch"] as const) {
      assert.ok(describeDenial(reason).length > 0, reason);
    }
  });
});
