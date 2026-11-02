import http from "node:http";
import type { BridgeConfig } from "../config.js";
import { err, log } from "../log.js";
import { metrics } from "../metrics.js";

/**
 * The metrics endpoint, bound to loopback and off unless a deployment names a port.
 *
 * Loopback only, because these counters are operational detail: a session count and
 * a frame count are not a credential, but they are also not something the public
 * front should expose. A deployment that wants them reaches them from the host.
 */
export function createMetricsServer(config: BridgeConfig): http.Server {
  const port = config.metricsPort;
  if (port === null || port === undefined) {
    throw new Error("metrics server asked for without BRIDGE_METRICS_PORT");
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "/") !== "/metrics") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(metrics.snapshot()));
  });

  server.listen(port, "127.0.0.1", () =>
    log(`metrics  http://127.0.0.1:${port}/metrics (loopback only)`)
  );
  server.on("error", (e) => err(`metrics server: ${e.message}`));
  return server;
}
