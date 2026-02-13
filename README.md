<p align="center">
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/Node.js-18%2B-brightgreen" alt="Node.js Version">
  </a>
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
  </a>
</p>

# 📡 Carrier Outage

**Carrier Outage** is a [**MeshMonitor**](https://github.com/Yeraze/MeshMonitor) script that detects **major provider outages** across mobile carriers, ISP / landline providers, and core cloud/CDN/DNS infrastructure using conservative public reachability signals over [**Meshstatic**](https://meshtastic.org/).

The intent is operational and practical:

> “Is the problem local to my node or ISP, or is there a wider provider-level event?”

---

## What it monitors

Providers are grouped into three classes:

- **Mobile**  
  Examples: AT&T, Verizon, T-Mobile

- **ISP / Landline**  
  Examples: Comcast/Xfinity, Spectrum, AT&T Fiber, Verizon Fios  
  (optionally including transit/backbone providers)

- **Cloud / Core Internet**  
  Examples: Cloudflare, AWS, Google, Microsoft Azure

Providers can be added, removed, or customized by editing the JSON files in the `providers/` directory.

---

## How detection works

Each provider is evaluated using multiple **signals**:

- HTTP GET probes to public endpoints  
- Optional DNS resolution checks  
- **Control probes** (known-good endpoints) used to determine whether the local host’s Internet is the problem

The script applies conservative logic to avoid false positives:

- A provider outage is **not** declared if control probes are failing.
- Multiple failed signals are required before transitioning to DEGRADED or MAJOR_OUTAGE.
- **Persistence** (consecutive runs) is required to change states, preventing flapping.

---

## Outputs

The script supports multiple output methods:

- **Console summary** (always enabled)
- **Structured JSON event** to stdout (optional)
- **MQTT publish** (optional; requires the mqtt package)

---

## Quick start

1. Copy the project folder to the system running MeshMonitor (or wherever you execute scripts).

2. Create and edit the configuration file:

   cp config.example.json config.json  
   nano config.json

3. Run once to verify:

   node index.js

4. Schedule execution (recommended):

- Run every **1–5 minutes** using your preferred scheduler:
  - cron
  - systemd timer
  - MeshMonitor’s scheduler
  - or another task runner

---

## MQTT (optional)

If MQTT publishing is enabled in config.json, install the dependency:

   npm install mqtt

If mqtt.enabled is set to true but the module is not installed, the script will log a warning and continue running without MQTT output.

---

## Configuration

Key fields in config.json:

- region – label included in output (e.g., mia, us-east)
- timeoutMs – per-request timeout in milliseconds
- consecutiveFailForMajor – runs required before MAJOR_OUTAGE
- consecutiveOkForRecovery – runs required before RECOVERED
- controlProbes – endpoints used to confirm local Internet health
- providers – paths to provider definition JSON files
- mqtt – optional MQTT configuration

---

## Provider lists

Provider definitions live in:

- providers/mobile.json
- providers/isp.json
- providers/cloud.json

Each provider supports the following structure:

    {
      "name": "cloudflare",
      "type": "cloud",
      "probes": [
        "https://www.cloudflare.com/",
        "https://1.1.1.1/"
      ],
      "dns": [
        "cloudflare.com",
        "one.one.one.one"
      ]
    }

---

## Event schema

When emitJson is enabled, the script outputs a structured event:

    {
      "type": "carrier_outage",
      "provider": "cloudflare",
      "providerType": "cloud",
      "state": "MAJOR_OUTAGE",
      "confidence": 0.88,
      "region": "us-east",
      "signals": [
        {"name": "control:https://example.com", "ok": true, "ms": 123},
        {"name": "probe:https://www.cloudflare.com/", "ok": false, "detail": "timeout"}
      ],
      "firstSeen": "2026-01-16T03:10:00Z",
      "lastSeen": "2026-01-16T03:14:00Z"
    }

States:

- OK
- DEGRADED
- MAJOR_OUTAGE
- RECOVERED

---

## Operational notes

- This script cannot prove **tower-level** or **neighborhood-level** cellular failures.
- For higher confidence, run it from **two or more locations** and correlate results.

---

## License

This project is licensed under the MIT License.

See the [LICENSE](LICENSE) file for details.  
Full license text: https://opensource.org/licenses/MIT

---

## Contributing

Pull requests are welcome. Open an issue first to discuss ideas or report bugs.</p>

---

## Acknowledgments

- MeshMonitor built by Yeraze (https://github.com/Yeraze)  
- Discover other community-contributed Auto Responder scripts for MeshMonitor at https://meshmonitor.org/user-scripts.html
