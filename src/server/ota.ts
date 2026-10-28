import http from "node:http";
import type { BridgeConfig } from "../config.js";
import { deriveToken, normalizeDeviceId } from "../credentials.js";
import { log, warn } from "../log.js";
import { hardwareReport } from "../protocol/hardware.js";
import { RegistryError, type Registry } from "../registry.js";

/**
 * The OTA endpoint — where a device is told to connect, and where it is given
 * the credential it will connect with.
 *
 * This is the only way a device learns the WebSocket address, and it is asked
 * before anything else can work: a bridge that does not answer here is
 * indistinguishable, from the device's side, from one that is not running, and
 * the device reports it as a network failure rather than as our absence.
 *
 * It is **not** the gate any more. A gadget nobody owns has to reach this
 * endpoint to receive its activation code, so every identifier with a valid shape
 * is answered — with a token derived from that gadget's own secret. What decides
 * whether the device is served is the socket and the console.
 *
 * The firmware's own activation flow is used as it is: an `activation` block in
 * this answer makes the gadget show and speak the code, and poll
 * `POST /xiaozhi/ota/activate` until it answers 200.
 */
export function createOtaServer(config: BridgeConfig, registry: Registry): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://bridge");

      if (url.pathname === "/xiaozhi/ota/" || url.pathname === "/xiaozhi/ota") {
        await answerOta(req, res, config, registry);
        return;
      }

      if (url.pathname === "/xiaozhi/ota/activate") {
        await answerActivation(req, res, registry);
        return;
      }

      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(
          `gadget-bridge\n` +
            `ota      http://${config.publicHost}:${config.otaPort}/xiaozhi/ota/\n` +
            `ws       ws://${config.publicHost}:${config.wsPort}/xiaozhi/v1/\n` +
            `framing  v${config.framing}\n` +
            `downlink ${config.serverRate} Hz / ${config.frameMs} ms\n` +
            `console  ${config.consoleUrl}\n`
        );
        return;
      }

      // A device asking for something this bridge does not serve is the beginning
      // of a firmware difference, and a silent 404 leaves no trace of which path it
      // wanted. The rig that preceded this service learned that the hard way.
      warn(`OTA 404 ${req.method} ${url.pathname}`);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found\n");
    } catch (error) {
      warn(`OTA crashed answering ${req.method} ${req.url}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("internal error\n");
      }
    }
  });

  server.on("error", (e) => warn(`ota server: ${e.message}`));
  server.listen(config.otaPort, "0.0.0.0", () =>
    log(`OTA  listening on http://${config.publicHost}:${config.otaPort}/xiaozhi/ota/`)
  );
  return server;
}

async function answerOta(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: BridgeConfig,
  registry: Registry
): Promise<void> {
  const rawDeviceId = req.headers["device-id"];
  log(
    `OTA ${req.method} /xiaozhi/ota/ device=${rawDeviceId ?? "?"} ` +
      `client=${req.headers["client-id"] ?? "?"} activation=${req.headers["activation-version"] ?? "?"}`
  );

  // The body is the firmware's account of its own board. It is read here, but
  // never logged and never allowed to decide the answer: a timeout, an oversized
  // body or a body that is not JSON all leave this endpoint behaving as it did
  // before the report existed.
  const body = await readOtaBody(req);

  if (typeof rawDeviceId !== "string" || rawDeviceId.trim() === "") {
    warn("OTA refused: no Device-Id header, and a token is issued per device");
    refuse(res, "Device-Id header is required", 400);
    return;
  }

  let gadget;
  try {
    gadget = await registry.resolve(rawDeviceId);
  } catch (error) {
    if (error instanceof RegistryError && error.status === 429) {
      warn(`OTA refused ${rawDeviceId}: the console is rate-limiting claim requests for it`);
      refuse(res, "too many claim requests; try again later", 429);
      return;
    }
    warn(
      `OTA refused ${rawDeviceId}: the console could not answer — ` +
        `${error instanceof Error ? error.message : String(error)}. Nothing is issued, because a ` +
        `gadget the console has not resolved must not be served.`
    );
    refuse(res, "the registry is unreachable", 503);
    return;
  }

  // The console created or found this device while resolving it, so a report has
  // a row to land on. Fire-and-forget: a console that is slow, down or refusing a
  // report must not change the address or the token this device is given.
  const report = body === null ? null : hardwareReport(parseJson(body));
  if (report !== null) {
    try {
      registry.reportHardware(rawDeviceId, report);
    } catch (error) {
      warn(
        `the board report for ${rawDeviceId} could not be handed over — ` +
          `${error instanceof Error ? error.message : String(error)}. The OTA answer is unchanged.`
      );
    }
  }

  const now = new Date();
  const activation = gadget.activation;
  const payload = {
    websocket: {
      url: `ws://${config.publicHost}:${config.wsPort}/xiaozhi/v1/`,
      token: deriveToken(gadget.secret, normalizeDeviceId(rawDeviceId)),
      version: config.framing,
    },
    server_time: {
      timestamp: Date.now(),
      timezone_offset: -now.getTimezoneOffset(),
    },
    // Only an owned device is offered firmware: an unclaimed gadget must receive
    // its code and nothing else. The firmware reads `force` as a number — 1
    // installs regardless of version order, 0 lets its own comparison decide —
    // and the console's boolean is translated here rather than sent as one.
    ...(gadget.owned && gadget.firmware !== null
      ? {
          firmware: {
            version: gadget.firmware.version,
            url: gadget.firmware.url,
            force: gadget.firmware.force ? 1 : 0,
          },
        }
      : {}),
    ...(activation === undefined
      ? {}
      : {
          activation: {
            code: activation.code,
            message: "Open the console, sign in, and enter this code to claim this gadget.",
            timeout_ms: 10 * 60 * 1000,
          },
        }),
  };

  // The token is not logged. It is recoverable from the secret and the
  // identifier, so a log line is one more place a credential lives for no gain —
  // the identifier is what an operator reads.
  log(
    gadget.owned
      ? `-> 200 websocket ws://${config.publicHost}:${config.wsPort}/xiaozhi/v1/ (token issued to ${rawDeviceId})`
      : `-> 200 websocket + activation for ${rawDeviceId} (unclaimed, code shown on the gadget)`
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function answerActivation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registry: Registry
): Promise<void> {
  const rawDeviceId = req.headers["device-id"];
  if (typeof rawDeviceId !== "string" || rawDeviceId.trim() === "") {
    refuse(res, "Device-Id header is required", 400);
    return;
  }

  try {
    const state = await registry.activate(rawDeviceId);
    if (state === "owned") {
      log(`-> 200 activate ${rawDeviceId} (complete)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ activated: true }));
      return;
    }
    if (state === "pending") {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ activated: false }));
      return;
    }
    warn(`activate ${rawDeviceId}: the console knows no claim for it`);
    refuse(res, "no claim for this device", 404);
  } catch (error) {
    warn(
      `activate ${rawDeviceId}: the console could not answer — ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
    refuse(res, "the registry is unreachable", 503);
  }
}

function refuse(res: http.ServerResponse, message: string, status: number): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`${message}\n`);
}

/** Comfortably above a real system-info body, partition table included. */
const OTA_BODY_LIMIT_BYTES = 32 * 1024;
/** A body the client never finishes must not hold the address it is waiting for. */
const OTA_BODY_TIMEOUT_MS = 1_000;

/**
 * Reads the request body, bounded in size and in time, and returns `null` when it
 * is not worth reading. The remainder of an oversized or late body is drained so
 * the response can still be written; nothing about the body is logged, because it
 * carries identifiers (MAC, UUID, IP) that have no business in a log line.
 */
async function readOtaBody(req: http.IncomingMessage): Promise<Buffer | null> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > OTA_BODY_LIMIT_BYTES) {
    req.resume();
    return null;
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => {
      req.resume();
      finish(null);
    }, OTA_BODY_TIMEOUT_MS);

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > OTA_BODY_LIMIT_BYTES) {
        req.resume();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks)));
    req.on("error", () => finish(null));
  });
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}
