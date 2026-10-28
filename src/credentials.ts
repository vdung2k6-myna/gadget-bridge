import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The device credential — who may connect, and with what.
 *
 * A gadget holds one opaque string, issued per device, that only this bridge can
 * check. It holds nothing the runtime accepts: the runtime's credential arrives
 * with the agent and stays here.
 *
 * There is still no token store. The token is derived from the device's own
 * secret — which the console holds and returns when the bridge resolves the
 * device — and from its identifier. Releasing a gadget rotates that secret in the
 * console, so its old token stops working and no other device's does.
 *
 * What this model does not do is stated in the README: the identifier is a header
 * the client declares, so a claim narrows who owns a gadget rather than proving
 * the person holding it is its owner.
 */
export type Denial = "no-device-id" | "no-token" | "token-mismatch";

export type Authorization =
  | { ok: true; deviceId: string }
  | { ok: false; reason: Denial };

/**
 * One spelling per device. Separators and case are presentation, and a device
 * identifier that differs from another only in them is the same device — so
 * `b8:1f:3f:4a:9b:01`, `B8-1F-3F-4A-9B-01` and `b81f3f4a9b01` are one gadget,
 * and an operator can paste whichever form they have.
 */
export function normalizeDeviceId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The token issued to one device, and the only token it can connect with. */
export function deriveToken(secret: string, deviceId: string): string {
  // The identifier is inside the HMAC input, not merely beside it, so a token is
  // a statement about one device rather than a shared secret with a label.
  return createHmac("sha256", secret).update(`device:${normalizeDeviceId(deviceId)}`).digest("base64url");
}

/**
 * The connect-time verdict. A device is authorized only by the combination of
 * its declared identifier and the token issued for that identifier — neither
 * alone, and no reason to treat a missing header as "the one device we have".
 *
 * `secret` is the gadget's own, resolved from the console. There is no allowlist
 * to consult here: a gadget the console does not know is refused before this is
 * called.
 */
export function authorizeDevice(
  secret: string,
  presented: { deviceId?: string | undefined; authorization?: string | undefined }
): Authorization {
  const deviceId = presented.deviceId?.trim();
  if (!deviceId) return { ok: false, reason: "no-device-id" };

  const token = bearerToken(presented.authorization);
  if (!token) return { ok: false, reason: "no-token" };

  return matchesToken(secret, deviceId, token)
    ? { ok: true, deviceId: normalizeDeviceId(deviceId) }
    : { ok: false, reason: "token-mismatch" };
}

/** `Authorization: Bearer <token>`, or the bare token. The firmware sends the
 * prefixed form, and accepting the bare one costs nothing. */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const value = header.trim();
  if (value === "") return null;
  const match = /^bearer\s+(.+)$/i.exec(value);
  return (match ? match[1]! : value).trim() || null;
}

function matchesToken(secret: string, deviceId: string, presented: string): boolean {
  const expected = Buffer.from(deriveToken(secret, deviceId), "utf8");
  const actual = Buffer.from(presented, "utf8");
  // Length first: timingSafeEqual throws on a length difference, and the
  // throw would be an exception where a refusal is meant.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** One line an operator can act on, for the log and for a refusal. */
export function describeDenial(reason: Denial): string {
  switch (reason) {
    case "no-device-id":
      return "no Device-Id header";
    case "no-token":
      return "no Authorization header";
    case "token-mismatch":
      return "a token this bridge did not issue for that Device-Id";
  }
}
