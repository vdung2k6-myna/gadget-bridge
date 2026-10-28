import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveToken } from "../src/credentials.js";
import { runtimeAuthHeaders } from "../src/platform.js";

/**
 * The runtime's credential crosses the boundary in exactly one shape: a Bearer
 * header on a request this bridge makes on a gadget's behalf. That shape is
 * pinned here because a runtime compares the presented token byte for byte — so
 * anything done here for convenience (trimming, re-casing, a prefix of its own)
 * is not a tidier credential but one that stops authenticating.
 *
 * The other half is which credential is in it. The bridge holds two secrets that
 * must never be confused: a gadget's own, which its socket token is derived
 * from, and the runtime's, which a gadget must never see.
 */
const BOARD = "b8:1f:3f:4a:9b:01";
const DEVICE_SECRET = "s".repeat(43);
const RUNTIME = "runtime-token-abcdefgh";
const BASE = "http://127.0.0.1:4000";

describe("the runtime credential as a request", () => {
  it("is presented as a Bearer header, verbatim", () => {
    assert.deepEqual(runtimeAuthHeaders({ baseUrl: BASE, token: RUNTIME }), {
      Authorization: `Bearer ${RUNTIME}`,
    });
  });

  it("does not reshape a token the console returned", () => {
    // Whitespace on the ends is the runtime's business, not this service's: it
    // carries the token it was given.
    const asIssued = ` ${RUNTIME} `;
    assert.equal(
      runtimeAuthHeaders({ baseUrl: BASE, token: asIssued }).Authorization,
      `Bearer ${asIssued}`
    );
  });

  it("carries the runtime's credential and never a gadget's", () => {
    const header = runtimeAuthHeaders({ baseUrl: BASE, token: RUNTIME }).Authorization;
    assert.equal(
      header.includes(deriveToken(DEVICE_SECRET, BOARD)),
      false,
      "a request to a runtime must not carry a gadget's token, and vice versa"
    );
    assert.equal(header.includes(DEVICE_SECRET), false);
  });
});
