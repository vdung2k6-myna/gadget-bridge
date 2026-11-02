# Soak results

Operator-run probes of the bridge under many device sessions. Figures are from the
host they were run on, which is not necessarily the deployment's target — read the
host row before comparing runs.

## 2026-11-03 — 100 devices, isolated, crashed

| | |
| --- | --- |
| Host | desktop Linux, **16 cores**, local disks |
| Bridge | this tree at the change's working revision; one Node process |
| Runtime | `scripts/stub-runtime.ts` on `127.0.0.1:4100` (no STT, no model) |
| Harness | `scripts/load-test.ts soak --count 100 --turns 1 --stagger --interval 25000` |
| Devices | 100 claimed consoles rows, one agent, seeded with `npm run seed:soak` |
| Audio | one 4.9 s utterance per device, sent as framed Opus |
| Metrics | `BRIDGE_METRICS_PORT=9100`, read on loopback |

### What came back

```
answered        45/100
failed          55   (every failure: no reply within the 60 s timeout)
wall            87.5 s
first audio     p50 24 ms, p95 29 ms   (among the 45 that were answered)
bridge RSS      not captured — the process died before the run ended
bridge CPU      not captured — the process died before the run ended
```

### How the run ended

At about 71 s the bridge process aborted:

```
RuntimeError: memory access out of bounds
    at wasm://wasm/...:wasm-function[40]
    ...
    at OpusScript.del (node_modules/opusscript/index.js)
    at Object.close (src/protocol/opus.ts:151)
    at Object.open (src/listening.ts:365)
    at <anonymous> (src/server/ws.ts:1181)
```

`Listening.open()` closes the previous window's Opus decoder and creates a new one.
Under 100 sessions the `opusscript` WASM decoder's `delete()` faults, and the bridge
exits. The 55 timeouts are sessions that had not been answered when the process
died; they are not evidence that a turn failed on its own.

### What this run does not establish

- It is the local host, not the deployment's target; do not compare its wall times
  with the 2026-10-31 connection-only run without saying so.
- The clients ran on the same host as the bridge, so client-side contention is in
  every figure.
- The stub runtime answers in milliseconds, so this run says nothing about STT,
  the model, or end-to-end turn latency.

### The next run

The bridge must survive 100 sessions before a cadence or burst figure means anything.
Until the decoder lifecycle is fixed (or shown not to fault), this document should
not be read as the bridge's capacity.

## 2026-11-03 — 100 devices, isolated, after the decoder lifecycle fix

The same run, after `gadget-bridge-opus-decoder-lifecycle` made the decoder live for
the session instead of per window.

| | |
| --- | --- |
| Host | desktop Linux, **16 cores**, local disks |
| Runtime | `scripts/stub-runtime.ts` on `127.0.0.1:4100` |
| Harness | `scripts/load-test.ts soak --count 100 --turns 1 --stagger --interval 25000` |
| Metrics | `BRIDGE_METRICS_PORT=9100` |

```
answered        80/100
failed          20   (no reply: the session's decoder produced no audio)
wall            87.7 s
first audio     p50 23 ms, p95 27 ms   (among the 80 answered)
bridge RSS      130 MB
bridge CPU      6.5 s of 87.7 s wall (7%)
event loop      p95 0.8 ms, max 133.8 ms
process         alive at the end
```

**The crash is gone; the capacity limit is not.** The 20 failures are the last
sessions in creation order, and a direct experiment explains them:

```
create 60 decoders, decode one packet:      60/60 decode
create 100 decoders, decode one packet:     79/100 decode  (21 return nothing)
create 150:                                 79/150 decode
create/delete 60 decoders, 50 batches:      60/60 every time
2000 sequential create/decode/delete:       0 failures
```

`opusscript` supports about **79 live decoder instances**; beyond that, new instances
construct but decode nothing. The lifecycle fix removed the delete fault (the crash),
but a single bridge process still cannot decode for more than ~79 concurrent sessions.

### What this means

A 100-device figure cannot be stated until the decoder strategy is chosen: cap the
bridge's sessions near 79 and run more than one bridge, pool a bounded number of
decoders across windows, or replace the decoder library. Each is an architecture
decision, not a lifecycle bug.

## 2026-11-03 — after replacing the decoder library

`gadget-bridge-opus-decoder-lifecycle` also replaced `opusscript` with `@evan/opus`,
after the experiment above showed the old library's ~79-instance ceiling. Two runs of
the same 100-device isolated soak:

| | run 1 | run 2 |
| --- | --- | --- |
| answered | **100/100** | **100/100** |
| wall | 28.3 s | 26.7 s |
| first audio p50 / p95 | 20 / 26 ms | 19 / 22 ms |
| bridge CPU | 5.2 s of 28.3 s (**18%**) | 4.7 s of 26.7 s (**17%**) |
| bridge RSS | 155 MB | 137 MB |
| event loop p95 / max | 1.3 / 147 ms | 1.3 / 147 ms |
| process | alive | alive |

Every session was served, the process survived both runs, and the 79-instance ceiling
is gone. The event-loop maximum (147 ms) is the connection storm at the start, not the
turn work: p95 is 1.3 ms once sessions are settled.

The bridge is still one Node process on a 16-core host, with the clients on the same
host; the caveats above still apply. This is the bridge's isolated ceiling, not the
platform's end-to-end capacity.

## 2026-11-03 — end-to-end, 100 devices, the real runtime

Same host, same audio tier, the runtime on `127.0.0.1:4000` instead of the stub.

| | cadence (`--stagger --interval 25000`) | burst (no stagger) |
| --- | --- | --- |
| answered | **23/100** | **17/100** |
| wall | 207.9 s | 184.2 s |
| first audio p50 / p95 | 109.6 / 172.9 s | 95.7 / 164.9 s |
| bridge CPU | 4% | 5% |
| bridge RSS | 167 MB | 184 MB |
| process | alive | alive |

Every failure was `no reply within the timeout`; none was a bridge failure. The bridge
stayed at 4–5% CPU and handed every turn over. The wall is the platform's: STT
serialises at about 1.27 s per utterance, and the model's ~15-concurrent ceiling and its
own variance sit behind it (`docs/CAPACITY.md`). One audio tier served both runs; it was
not scaled for 100.

Read these as the platform's end-to-end shape at 100 turns, not as the bridge's
capacity. The bridge's isolated ceiling is the section above.
