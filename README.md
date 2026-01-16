<p align="center">
  <a href="https://www.python.org/">
    <img src="https://img.shields.io/badge/Python-3.8%2B-blue" alt="Python Version">
  </a>
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
  </a>
</p>

# 📡 Carrier Outage

Carrier Outage is a [**MeshMonitor**](https://github.com/Yeraze/MeshMonitor) Script script that detects **major provider outages** (mobile carriers, ISPs/landline providers, and core cloud/CDN/DNS infrastructure) using conservative public reachability signals.

The intent is operational: quickly answer **“Is the problem local to my node/ISP, or is there a wider provider event?”**

## What it monitors

Providers are grouped into three classes:

- **Mobile** (e.g., AT&T, Verizon, T-Mobile)
- **ISP / Landline** (e.g., Comcast/Xfinity, Spectrum, AT&T Fiber, Verizon Fios, plus optional transit/backbone)
- **Cloud / Core Internet** (e.g., Cloudflare, AWS, Google, Microsoft Azure)

You can add/remove providers by editing the JSON files in `providers/`.

## How detection works

Each provider has multiple **signals**:

- HTTP probes (GET) to public endpoints
- Optional DNS resolution checks
- A set of **control probes** (known-good endpoints) to detect when *your host’s Internet* is the problem

The script uses conservative rules:

- It will **not** declare a provider outage if control probes are failing.
- It requires **multiple failed signals** to move a provider to `DEGRADED` or `MAJOR_OUTAGE`.
- It uses **persistence** (consecutive runs) to prevent false positives and flapping.

## Outputs

- **Console summary** (always)
- **JSON event** to stdout (optional)
- **MQTT publish** (optional; requires `mqtt` package)

## Quick start

1) Copy the folder to the machine running MeshMonitor (or wherever you run scripts).

2) Create config:

```bash
cp config.example.json config.json
nano config.json
```

3) Run once:

```bash
node index.js
```

4) Schedule it (recommended): run every **1–5 minutes** using your preferred scheduler (cron, systemd timer, MeshMonitor’s scheduler, etc.).

## MQTT (optional)

If you enable MQTT in `config.json`, install the dependency:

```bash
npm install mqtt
```

If `mqtt.enabled` is true but the module is not installed, the script will log a warning and continue.

## Configuration

Edit `config.json`:

- `region`: label included in outputs (e.g., `mia`, `us-east`)
- `timeoutMs`: per-request timeout
- `consecutiveFailForMajor`: consecutive failing runs before `MAJOR_OUTAGE`
- `consecutiveOkForRecovery`: consecutive healthy runs before `RECOVERED`
- `controlProbes`: endpoints used to validate that your host has Internet
- `providers`: paths to provider list JSON files
- `mqtt`: optional emitter

## Provider lists

Provider lists live in:

- `providers/mobile.json`
- `providers/isp.json`
- `providers/cloud.json`

Each provider supports:

```json
{
  "name": "cloudflare",
  "type": "cloud",
  "probes": ["https://www.cloudflare.com/", "https://1.1.1.1/"],
  "dns": ["cloudflare.com", "one.one.one.one"]
}
```

## Event schema

When `emitJson` is enabled, the script prints a structured event:

```json
{
  "type": "carrier_outage",
  "provider": "cloudflare",
  "providerType": "cloud",
  "state": "MAJOR_OUTAGE",
  "confidence": 0.88,
  "region": "us-east",
  "signals": [
    {"name":"control:https://example.com","ok":true,"ms":123},
    {"name":"probe:https://www.cloudflare.com/","ok":false,"detail":"timeout"}
  ],
  "firstSeen": "2026-01-16T03:10:00Z",
  "lastSeen": "2026-01-16T03:14:00Z"
}
```

States:

- `OK`
- `DEGRADED`
- `MAJOR_OUTAGE`
- `RECOVERED`

## Operational notes

- This script cannot prove **tower-level** or **neighborhood-level** cellular failures.
- For higher confidence, run it from **two or more locations** and correlate results.

---

## License

MIT License

## Acknowledgments

* MeshMonitor built by [Yeraze](https://github.com/Yeraze) 

Discover other community-contributed Auto Responder scripts for MeshMonitor [here](https://meshmonitor.org/user-scripts.html).

