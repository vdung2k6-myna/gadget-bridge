/**
 * The bridge's side of the runtime boundary, and the only place it crosses.
 *
 * A runtime credential reaches exactly one kind of request — the turns this
 * bridge sends on a gadget's behalf — and must not reach any other kind, and in
 * particular nothing this service sends to a device: not the OTA answer, not the
 * hello reply, not a message inside a turn. That is why the credential is turned
 * into a header *here* rather than at each call site: one audited place is the
 * difference between an invariant and a promise. A future call that builds its
 * own `Authorization` header is the way this leaks.
 *
 * The credential arrives with the agent, resolved from the console, so it is not
 * the bridge's own secret any more — but it still belongs to this service and
 * never to a gadget.
 *
 * A runtime compares the presented token byte for byte, so it is passed through
 * exactly as the console returned it: no trimming, no case folding, no
 * normalization.
 */
export interface RuntimeTarget {
  baseUrl: string;
  token: string;
}

export function runtimeAuthHeaders(runtime: RuntimeTarget): Record<string, string> {
  return { Authorization: `Bearer ${runtime.token}` };
}
