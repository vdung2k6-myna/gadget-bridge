# gadget-bridge

Speaks the XiaoZhi gadget protocol in front of `gadget-console`.

A XiaoZhi device only knows one way to reach a server: ask an OTA endpoint where
to connect, then open a WebSocket and say hello. The console speaks HTTP and
holds the data; this service answers the OTA request, holds the device's socket,
and turns every spoken turn into a request to the runtime the gadget's agent
names.

**The bridge names no device and holds no prompt.** Who owns a gadget, what it is
called, which agent answers it, what that agent says, which language it is heard
in and which engine it is spoken through all live in the console. The bridge asks
the console when a gadget connects, and is given everything a session needs.
Nothing here is configured per device.

It speaks and it listens: the handshake works, a turn's reply reaches the gadget's
own speaker in Opus, and what the person says comes back as a turn of its own —
closed by this service's own endpointer rather than by anything the device sends.
A short command said to the gadget is the exception: it is not sent to the runtime
at all, and the bridge carries it out itself.

## Running it

Node **22 or newer** — the version whose built-in `fetch` the tests use. No
database, no build step, no compiler at run time.

**The console runs first.** The bridge reads every device from it, and a console
that is not up is a bridge that resolves nobody:

```bash
# console, in ../gadget-console
npm install && npm run db:migrate && npm start        # listens on 3001

# bridge, here
npm install
cp .env.example .env      # then set BRIDGE_CONSOLE_URL and BRIDGE_CONSOLE_TOKEN
npm start                 # tsx src/index.ts
```

`.env` is read by Node itself, so `npm start`, `npm run dev` and a bare
`node --import tsx src/index.ts` all behave the same. Every value has a default
except three, which have none on purpose: the console's address, the console's
credential, and the ports the flashed device expects — see
[Credentials](#credentials).

`npm start` starts **both** servers and prints the addresses:

```
gadget-bridge
  ota      http://192.168.1.100:8003/xiaozhi/ota/
  ws       ws://192.168.1.100:8001/xiaozhi/v1/
  framing  v3
  downlink 24000 Hz / 60 ms
  console  http://127.0.0.1:3001
  devices  resolved per connection; none are named here
```

| Command | What it does |
| --- | --- |
| `npm start` | Runs the service once. |
| `npm run dev` | Same, restarting on source change. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | The test suite (`tsx --test test/*.test.ts`). |

### The two servers

**OTA — `http://<host>:8003/xiaozhi/ota/`.** The device is flashed with this URL
(`CONFIG_OTA_URL`), asks it before anything else, and reads the WebSocket address,
its own token and the framing version out of the answer. A device that cannot
reach this endpoint reports a network failure rather than "no server". `GET /`
returns the addresses as text, for a human with a browser.

**Activation — `POST /xiaozhi/ota/activate`.** The firmware's own flow, used as it
is: an `activation` block in the OTA answer makes the gadget show and speak a
code, then poll this route until it answers `200`. `202` means the claim is still
pending; the gadget waits and asks again. See [Claiming a gadget](#claiming-a-gadget).

**WebSocket — `ws://<host>:8001/xiaozhi/v1/`.** Any path is accepted; the
firmware appends a version segment. On connect the device sends a `hello`, and the
reply must carry `transport` — without it the firmware fails the connect ten
seconds later, with nothing logged on this side. Binary frames are counted and
logged, and deliberately not answered. A connection whose credential does not
check out is refused with **401 during the upgrade**; a connection the console
cannot resolve is refused with **503**, because a gadget this bridge has not
resolved must not be served. The firmware reads anything but a 101 as "server not
connected", so the device reports a failure instead of believing it was connected.

`BRIDGE_PUBLIC_HOST` is the address written into the OTA answer, and it has to be
one the device can route to. Unset, the bridge picks a LAN address itself and logs
which one it chose; set it when that pick is wrong (a second adapter, a VPN, a
machine whose device is on another subnet).

### The console

`BRIDGE_CONSOLE_URL` is where `gadget-console` is — for example
`http://127.0.0.1:3001`. Required, and with no default: the only obvious default
is localhost, which is right on a developer's machine and silently wrong
everywhere else.

The bridge asks it once per connection, at OTA and again at the upgrade, and the
answer carries everything the session needs: whether the gadget is owned, its own
secret, its agent (prompt, topics, answer mode, language, engine, its runtime's
address and credential, and the account's own model where it names one), its
partner, and the turns already recorded.

Once the tool channel is up, the bridge reports back what the gadget declared — its
`tools/list` catalogue, names and descriptions — so the console can show it on the
device's page. That report is fire-and-forget: a catalogue is bookkeeping, and a
session never waits on one.

The OTA request also carries the firmware's own system-info body: the board type
and name, the chip, flash, the display, and the application version. The bridge
reads it within a 32 KiB bound and forwards only those facts — the partition
table, the ELF hash, the MAC address, the UUID, the IP, the SSID and any cellular
identifiers are dropped before anything leaves the process, and the body itself is
never logged. That report is fire-and-forget too: a body that is absent, oversized
or unreadable leaves the OTA answer exactly as it was.

The same answer may carry a `firmware` block — `version`, a URL on the console, and
`force` — when the console says the device should be running something other than
what it reported. It is included **only for an owned device**; an unclaimed gadget
gets its code and nothing else. The URL is the console's own and is never composed
here or taken from a request. `force` is translated into the number the firmware
reads: `1` installs regardless of version order, `0` lets its own comparison decide.
A block in a shape the firmware cannot use is dropped with a warning, and the session
is not refused over it.

A resolution is reused for `BRIDGE_REGISTRY_TTL_MS` (default 60 s), which is also
how long a released gadget may keep working — the bound is stated rather than
implied.

**An unreachable console fails closed.** Nothing is served from a remembered
answer: a connection that cannot be resolved is refused, and a session already
resolved runs to its end, because what it needs is already held.

### Claiming a gadget

A gadget nobody owns is not refused — it could not then receive a code. Instead:
its OTA answer carries an `activation` block, the gadget shows the six digits and
speaks them aloud, and the person enters the code in the console. Entering it
records a request: the bridge's poll of `/activate` keeps answering `202` while an
admin decides, and answers `200` once the request is approved — which is what lets
the gadget connect.

The code is short-lived, single-use, rate-limited, and shown *and* spoken by the
physical gadget. It is not a strong barrier: the identity it protects is a
`Device-Id` the gadget declares, so whoever knows that identifier can ask for the
same code. What the code narrows is the window, and what the pairing with the
console adds is an owner. The firmware also implements a hardware challenge (an
HMAC over an eFuse key), which would close that gap; it is not used here because
it needs keys recorded when the board was made.

### What an agent is

An agent is everything a turn needs, and it lives in the console:

| Agent field | What it decides |
| --- | --- |
| `systemPrompt` | what the gadget says |
| `topics` | the search scope its runtime may read |
| `answerMode` | `generate`, or `material` — read from its topics |
| `language` | how the person is heard, and how the reply is spoken |
| `engine` | `kokoro`, `piper` or `supertonic` |
| `runtime` | the base URL and credential that answer it |
| `model` | the account's own OpenAI-compatible endpoint, where it names one; otherwise absent, and the runtime's default answers |

The **voice** is not on that list, and deliberately: the runtime resolves it from
`(engine, language)` itself. The console therefore offers no voice picker — a
setting that would not be honoured is worse than no setting. One agent may serve
several devices; a device has at most one agent and at most one partner.

An engine or language the runtime does not name is refused when the agent is
saved, and again when it is resolved: the runtime folds an unknown value into one
of its own rather than refusing it, so those two moments are the only places the
mistake is visible.

### The turn

A turn is the same request the browser makes to the runtime: multipart form data
carrying the agent's fields, the gadget's language, the conversation so far, and
the person's input as either an audio file or text. The runtime is stateless and
self-describing — it looks no agent up — so everything it needs is in the request.

| A turn's field | Comes from |
| --- | --- |
| `systemPrompt`, `enabledTopics`, `answerMode` | the agent |
| `language`, `engine` | the agent |
| the device's identity (`Device-Id`) | the device, and the console's record of it |
| `audio` | the device, per turn |
| `history` | the conversation so far: memory, seeded from the console |
| `llmBaseUrl`, `llmModel`, `llmApiKey`, `llmTemperature` | the agent's own model, when it names one; all four absent otherwise, so the runtime asks its default exactly as before |

The request goes through one place, `src/platform.ts`, where the runtime's
credential becomes a header. It is the one credential that reaches the runtime,
and it never reaches a device.

### The conversation, and its record

The runtime keeps no conversation, so the bridge carries one per device, bounded
to the most recent `BRIDGE_HISTORY_TURNS` exchanges. At `hello` the bridge seeds
that conversation from the turns the console already holds, so a restart does not
make the gadget forget; each served turn is appended to memory **and posted to the
console**.

That post is fire-and-forget. The reply has been spoken by the time the console is
told about it: a console that is slow, down, or refusing never delays a turn or
cuts a reply short. A lost record is the accepted cost of never trading speech for
durability.

A turn is recorded as text — the runtime's transcription of the person and the
reply the bridge spoke — and never as audio. Records expire after the console's
retention period, and are deleted when the gadget is released.

### Two gadgets that hold a conversation

When the console pairs two devices, a turn on one is followed by a turn on its
partner whose input is the reply's own text — not a transcription of what the
partner heard. The partner's turn is asked while the first is still speaking and
spoken when the first reports it has begun listening, plus `BRIDGE_HANDOVER_MS`.
While an exchange is in flight neither microphone is judged, and the wake word
ends it. A deployment that pairs nothing reaches none of it.

### Music, and commands answered here

`BRIDGE_MUSIC_DIR` names a directory the bridge lists when asked, and empty means
this deployment has no music at all. Two spoken commands — play a track, stop —
are answered by the bridge itself rather than sent to the runtime; anything the
directory cannot settle (a name several files carry, or none) falls through as an
ordinary utterance. `BRIDGE_MUSIC_GAIN_DB` is the level a track is played at, as a
difference from the file, so a track does not drown the voice it plays beside.

The same is true of the gadget's own settings: a short command that changes
volume, brightness or the like is carried out here. A command is not a turn of the
conversation, and recording it would put a question nobody put to the model into
the history.

### The endpointer, and the session

The firmware sends no `listen stop`, so the bridge decides when a person has
finished speaking: a gate on the room's own noise floor, a minimum amount of
speech, and a silence threshold, all of which are settings rather than constants
(`BRIDGE_VAD_*`, `BRIDGE_MAX_TURN_MS`). A window in which nobody spoke produces no
turn however loud the room is.

A session nobody speaks into ends after `BRIDGE_SESSION_IDLE_MS`, measured by what
a person was behind and by what the bridge still has to play — not by the bytes
arriving, because a gadget streams whether or not anyone is speaking. Ending a
session leaves the gadget able to take another.

## A load test

`scripts/load-test.ts` drives the running services and reports what came back. Two
modes, because a deployment has two ceilings:

```bash
# How many turns the runtime can answer at once: the same request the bridge
# sends, text instead of audio and speak=0, so the model slot is the only thing
# being measured.
RUNTIME_TOKEN=… npx tsx scripts/load-test.ts runtime --count 12

# …and with an account's own model, the four fields the bridge would send:
RUNTIME_TOKEN=… npx tsx scripts/load-test.ts runtime --count 12   --llm-url http://127.0.0.1:11434/v1 --llm-model deepseek-v4.1-flash:cloud --llm-key ollama

# How many device sessions the bridge will hold: real upgrades with real tokens,
# a hello, and nothing else. An identifier nobody owns still yields the secret its
# token is derived from, so no gadget is needed — but each leaves a pending claim
# in the console until CLAIM_APPROVAL_TTL_MS.
npx tsx scripts/load-test.ts bridge --count 50
```

`--console`/`--token` override the bridge's own `.env`; `--runtime-token` is the
runtime's credential, which the bridge no longer holds. The bridge's RSS is the
number to watch for connection capacity, and it comes from the OS, not from the
script.

What the numbers mean: a turn holds a model slot only while its reply is being
produced, and `OLLAMA_MAX_CONCURRENT_REQUESTS` (default 12) bounds how many do at
once. Beyond that turns queue, and one that waits past the 120 s chat timeout fails.

## Credentials

Three credentials exist, and none of the last two ever reaches a gadget.

| Credential | Held by | What it does |
| --- | --- | --- |
| A gadget's secret | the console, one per device | the bridge derives the gadget's socket token from it (`HMAC-SHA256(secret, "device:" + id)`) |
| `BRIDGE_CONSOLE_TOKEN` | the bridge | authenticates every `/api/bridge/*` call; never sent to a device |
| A runtime's token | the console, attached to the agent | authenticates a turn; sent only to the runtime |
| An account's LLM key | the console, encrypted | names the model that answers a turn; carried with it to the runtime, never to a device |

The gadget's socket token is derived, not stored, so a restart issues the same
token it issued before. Releasing a gadget replaces its secret in the console, so
its old token stops working and no other device's does.

`src/platform.ts` is the only place the runtime credential becomes a header, and
`src/credentials.ts` is the only place a gadget's token is checked. A future call
that builds its own `Authorization` header is the way this leaks.

## Dependencies

`ws` for the device socket. Node's own `crypto` for the token and the password-free
HMAC; nothing else — no database driver, no Opus library (the framing is done here
and the payloads are handed over as they arrive).

## Status

Every turn path is implemented and covered: OTA and activation, the upgrade and
the handshake, the endpointer, speech in and out, commands, music, the paired
exchange, the conversation's record, and the console resolution that makes a
device exist at all. What is not here is the console itself — see its own README.

## Layout

| Path | What lives there |
| --- | --- |
| `src/index.ts` | The composition root: config, console client, both servers. |
| `src/config.ts` | Everything read from the environment, and what is refused. |
| `src/registry.ts` | The console client: resolution, activation, the turn record. |
| `src/credentials.ts` | Device identifiers and the token derivation. |
| `src/platform.ts` | The one place a runtime credential becomes a header. |
| `src/conversation.ts` | A gadget's conversation, and taking one turn. |
| `src/turn.ts` | The runtime's turn request and its event stream. |
| `src/speech.ts` | The downlink: brackets, sentences, Opus frames. |
| `src/listening.ts` | The uplink: the window and the endpointer. |
| `src/commands.ts` | The short commands the bridge answers itself. |
| `src/music.ts` | The bridge's own music. |
| `src/server/ota.ts` | OTA, activation, and the token. |
| `src/server/ws.ts` | The device's socket and its session. |
| `src/protocol/` | Framing, Opus, MCP, the message shapes. |
| `docs/` | The protocol deltas, and the hardware. |

## License

MIT — see `LICENSE`.
