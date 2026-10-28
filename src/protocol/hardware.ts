/**
 * What a gadget's firmware says about the board it runs on, narrowed to what the
 * console keeps.
 *
 * The firmware posts a system-info body with every OTA request
 * (`GetSystemInfoJson` in `main/boards/common/board.cc`). That body is shaped for
 * an OTA service, not for this console: it carries the partition table, the ELF
 * hash, the MAC address, the device UUID, and — on a Wi-Fi board — the SSID, the
 * RSSI, the channel and the IP. None of that belongs on this console's wire, so
 * the body is read here into a small report and the rest is dropped before
 * anything leaves the process.
 *
 * Three rules:
 *
 * **Only the allowlist crosses.** A field this file does not name is not forwarded
 * even if the firmware sends it, so a later firmware field waits for a decision
 * here rather than leaking by default.
 *
 * **Absence is not filled.** A field the firmware did not send is left out; a value
 * of the wrong type is left out too, because the console would refuse the whole
 * report over it and a board with one odd field is better reported than not.
 *
 * **Nothing is logged.** The body itself is never written to a log line — it holds
 * identifiers — and neither is the report. An operator reads the device id.
 *
 * The console validates again and owns the bounds; this is the first of two
 * filters, not the only one.
 */

export interface HardwareReport {
  board?: { type?: string; name?: string; manufacturer?: string };
  chip?: string;
  flashSize?: number;
  psramSize?: number;
  display?: { width?: number; height?: number; monochrome?: boolean };
  application?: { name?: string; version?: string };
  language?: string;
}

/** Reads one OTA body into a report, or `null` when nothing worth forwarding survived. */
export function hardwareReport(body: unknown): HardwareReport | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const source = body as Record<string, unknown>;

  const boardSource = objectOf(source.board);
  const board = {
    type: text(boardSource?.type),
    name: text(boardSource?.name),
    manufacturer: text(boardSource?.manufacturer),
  };

  const displaySource = objectOf(source.display);
  const display = {
    width: whole(displaySource?.width),
    height: whole(displaySource?.height),
    monochrome: boolean(displaySource?.monochrome),
  };

  const applicationSource = objectOf(source.application);
  const application = {
    name: text(applicationSource?.name),
    version: text(applicationSource?.version),
  };

  const report: HardwareReport = {};
  const keptBoard = defined(board);
  if (Object.keys(keptBoard).length > 0) report.board = keptBoard;
  const chip = text(source.chip_model_name);
  if (chip !== undefined) report.chip = chip;
  const flashSize = whole(source.flash_size);
  if (flashSize !== undefined) report.flashSize = flashSize;
  const psramSize = whole(source.psram_size);
  if (psramSize !== undefined) report.psramSize = psramSize;
  const keptDisplay = defined(display);
  if (Object.keys(keptDisplay).length > 0) report.display = keptDisplay;
  const keptApplication = defined(application);
  if (Object.keys(keptApplication).length > 0) report.application = keptApplication;
  const language = text(source.language);
  if (language !== undefined) report.language = language;

  return Object.keys(report).length === 0 ? null : report;
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
