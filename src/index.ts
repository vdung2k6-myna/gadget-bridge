import { loadConfig } from "./config.js";
import { createConversations } from "./conversation.js";
import { log, warn } from "./log.js";
import { createRegistry } from "./registry.js";
import { createOtaServer } from "./server/ota.js";
import { createWsServer } from "./server/ws.js";

/**
 * The service: the OTA endpoint and the device socket, and nothing else.
 *
 * Started together because they are useless apart — a device that cannot reach
 * OTA never connects, and one that connects without OTA never finds the address —
 * and because the two together are what "the bridge is running" means.
 *
 * Every device fact comes from the console at the moment it is needed. This file
 * builds the client for it and nothing else: no lists, no bindings, and no read
 * that could go stale between a restart and a claim.
 */

// Node 22 reads the file itself, so `npm start`, `npm run dev` and a bare
// `node --import tsx src/index.ts` all behave the same and none of them needs a
// shell flag. Absent, every value has a default except the three that refuse to
// have one on purpose — the console's address, the console's credential and the
// bridge's own — and each of those reports its own absence better than this could.
try {
  process.loadEnvFile();
} catch {
  // No .env beside the service. Not an error on its own.
}

const config = loadConfig();

const registry = createRegistry(config);
const conversations = createConversations(config);

createOtaServer(config, registry);
createWsServer(config, { registry, conversations });

const wsUrl = `ws://${config.publicHost}:${config.wsPort}/xiaozhi/v1/`;

console.log(
  `\ngadget-bridge\n` +
    `  ota      http://${config.publicHost}:${config.otaPort}/xiaozhi/ota/\n` +
    `  ws       ${wsUrl}\n` +
    `  framing  v${config.framing}\n` +
    `  downlink ${config.serverRate} Hz / ${config.frameMs} ms\n` +
    `  console  ${config.consoleUrl}\n` +
    `  devices  resolved per connection; none are named here\n`
);

// The thing an operator must not have to infer, said out loud at every start.
// Neither credential is ever printed: the console's is named as held and not
// shown, because that the bridge has it while a device does not is the invariant.
warn(
  `NOTE a gadget's identity is the Device-Id it declares, which is a header the client sets. The ` +
    `console decides who owns it and what it says; this bridge only verifies the token derived from ` +
    `that gadget's own secret.`
);
warn(
  `NOTE the console is what every connection reads (${config.consoleUrl}). If it cannot be reached, ` +
    `no gadget is admitted — a gadget this bridge has not resolved must not be served.`
);

// The endpointer, said plainly because its numbers are what decide when a gadget
// answers and a wrong one is silent rather than loud. The relation between the three
// that have one was checked at start and threw if it did not hold, so what is left is
// to report the figures an operator would otherwise have to infer from a log of
// frames that were never judged.
log(
  `endpointer: speech closes a turn after ${config.vadSilenceMs}ms of silence, ` +
    `counted over ${config.vadSpeechWindowMs}ms and needing ${config.vadMinSpeechMs}ms of it; ` +
    `gate ${config.vadMinRms} RMS or ${config.vadFloorRatio}x the room's floor; ` +
    `a window with no speech is given up on after ${config.vadNoSpeechMs}ms`
);
log(
  `uplink: opus ${config.deviceRate} Hz mono, ${config.frameMs}ms frames — ` +
    `the utterance is decoded at this rate and uploaded trimmed (6.1)`
);
