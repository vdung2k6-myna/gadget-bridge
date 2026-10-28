import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hardwareReport } from "../src/protocol/hardware.js";

/** The body the firmware posts, as `GetSystemInfoJson` builds it. */
const SYSTEM_INFO = {
  version: 2,
  language: "vi",
  flash_size: 16_777_216,
  mac_address: "b8:1f:3f:4a:9b:01",
  uuid: "00000000-0000-4000-8000-000000000000",
  chip_model_name: "esp32s3",
  chip_info: { model: 1, cores: 2, revision: 0, features: 0 },
  application: {
    name: "xiaozhi",
    version: "1.2.3",
    compile_time: "2026-10-01T00:00:00Z",
    idf_version: "v5.4",
    elf_sha256: "deadbeef",
  },
  partition_table: [{ label: "app", type: 1, subtype: 2 }],
  ota: { label: "ota_0" },
  display: { monochrome: false, width: 320, height: 240 },
  board: {
    type: "esp-box-3",
    name: "ESP32-S3-BOX-3",
    manufacturer: "espressif",
    ssid: "home",
    rssi: -40,
    channel: 6,
    ip: "192.168.1.20",
    mac: "b8:1f:3f:4a:9b:01",
  },
};

describe("reading the OTA body", () => {
  it("keeps the board facts and the console's names for them", () => {
    assert.deepEqual(hardwareReport(SYSTEM_INFO), {
      board: { type: "esp-box-3", name: "ESP32-S3-BOX-3", manufacturer: "espressif" },
      chip: "esp32s3",
      flashSize: 16_777_216,
      display: { width: 320, height: 240, monochrome: false },
      application: { name: "xiaozhi", version: "1.2.3" },
      language: "vi",
    });
  });

  it("never forwards an identifier or internal detail", () => {
    const forwarded = JSON.stringify(hardwareReport(SYSTEM_INFO));
    for (const identifier of [
      "mac_address",
      "b8:1f",
      "uuid",
      "192.168",
      "ssid",
      "rssi",
      "channel",
      "imei",
      "iccid",
      "partition_table",
      "elf_sha256",
      "chip_info",
      "ota_0",
    ]) {
      assert.ok(!forwarded.includes(identifier), `${identifier} must not be forwarded`);
    }
  });

  it("leaves out a field the firmware did not send", () => {
    const report = hardwareReport({
      board: { type: "bread-compact-wifi-lcd" },
      chip_model_name: "esp32s3",
    });
    assert.deepEqual(report, {
      board: { type: "bread-compact-wifi-lcd" },
      chip: "esp32s3",
    });
    assert.equal("display" in (report ?? {}), false);
    assert.equal("psramSize" in (report ?? {}), false);
  });

  it("leaves out a value of the wrong shape instead of refusing the whole report", () => {
    assert.deepEqual(
      hardwareReport({
        board: { type: 42, name: "  ", manufacturer: "espressif" },
        chip_model_name: null,
        flash_size: -1,
        display: { width: "320", height: 240.5, monochrome: "no" },
        application: "not an object",
      }),
      { board: { manufacturer: "espressif" } }
    );
  });

  it("answers null when nothing survives", () => {
    assert.equal(hardwareReport(null), null);
    assert.equal(hardwareReport("a body"), null);
    assert.equal(hardwareReport([]), null);
    assert.equal(hardwareReport({}), null);
    assert.equal(hardwareReport({ mac_address: "b8:1f" }), null);
  });
});
