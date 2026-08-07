<p align="center">
  <img src="docs/assets/logo.png" alt="Carrier Outage Logo" width="200"/>
</p>


<p align="center">
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/Node.js-18%2B-brightgreen" alt="Node.js Version">
  </a>
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
  </a>
</p>

# 📡 Carrier Outage

**Carrier Outage** is a [**MeshMonitor**](https://github.com/Yeraze/MeshMonitor) script that detects **provider-level outages** — mobile carriers, ISP/landline, or core cloud/CDN infrastructure — by correlating simple connectivity checks across multiple nodes, for delivery over [**Meshtastic**](https://meshtastic.org/), [**MeshCore**](https://meshcore.co.uk/), or any other mesh network MeshMonitor supports.

The intent is operational and practical:

> "Is the problem local to my node or ISP, or is there a wider provider-level event?"

---

## Architecture

Carrier Outage has two parts that work together:

- **`index.js`** — a short-lived **probe**, run on a schedule (cron, systemd timer, etc.) on each node/vantage point you want to monitor. Each run checks whether *that* node's Internet is reachable and publishes the result.
- **`aggregator.js`** — a single long-running **collector**, subscribed over MQTT to every node's probe results. It correlates results across nodes that share the same `providerHint` (e.g. all your `att` nodes) and publishes a scope/severity verdict per provider.

A single probe run only tells you about one node. The aggregator is what turns "my node's Internet is down" into "AT&T looks down across 3 states" — you need both pieces running for outage detection to actually work, not just `index.js` alone.

---

## How detection works

**Per node (`index.js`):**

1. Hits a small list of **control probes** (known-good, high-availability endpoints you configure) with a timeout.
2. If at least 67% of control probes succeed, the node considers its own connectivity `controlOk: true`; otherwise `false`.
3. Publishes an `ONLINE` presence message and a local-status message (nodeId, `providerHint`, state, region, `controlOk`) — either over MQTT (retained, with a Last Will offline message) or as JSON on stdout if MQTT is disabled.

**Aggregation (`aggregator.js`):**

1. Subscribes to every node's presence and local-status topics.
2. Treats a node as *impacted* if it's `OFFLINE` (via presence/LWT) or reported `controlOk: false`, within a 10-minute rolling window.
3. Groups impacted nodes by `providerHint` and classifies scope:
   - **NATIONWIDE** — impacted nodes span ≥3 distinct states, or ≥5 nodes total
   - **STATE** — ≥2 impacted nodes share the same state
   - **LOCAL** — otherwise
4. Computes a **confidence** score (0–0.95) from how spread out and how heavily-weighted the impacted nodes are, and a **severity** (`critical` / `major` / `minor`) from scope + confidence + node count.
5. Publishes a per-provider scope event and an overall summary, retained, over MQTT.

This is a **stateless, single-snapshot** classifier — each incoming message immediately recomputes and republishes scope for the affected provider. There's no run-to-run persistence or debounce window beyond the 10-minute freshness cutoff, so a provider can flip between scopes quickly if node status is flapping. Run probes from **multiple independent vantage points** for a meaningful signal — a single node's control-probe failure just means that node's Internet is down, not a provider outage.

---

## Outputs

- **`index.js`**: console/stdout (JSON, always when MQTT is disabled), or MQTT presence + local-status topics (retained) when enabled.
- **`aggregator.js`**: MQTT scope topics (one per provider) and a summary topic (retained), continuously as messages arrive.

---

## Quick start

1. Copy the project folder to the system(s) running MeshMonitor (or wherever you execute scripts). `index.js` runs on each monitored node/vantage point; `aggregator.js` runs once, anywhere that can reach your MQTT broker and all the nodes' publishes.

2. Create and edit the configuration file (used by `index.js` only — see [MQTT](#mqtt-optional-for-indexjs-required-for-aggregatorjs) below for `aggregator.js`):

   ```
   cp config.example.json config.json
   nano config.json
   ```

3. Run a probe once to verify:

   ```
   node index.js
   ```

4. Schedule `index.js` execution on every monitored node (recommended: every **1–5 minutes**) using cron, a systemd timer, MeshMonitor's scheduler, or another task runner.

5. If you want provider-level correlation across nodes (not just a single node's local status), also run `aggregator.js` as a **long-running process** (e.g. under systemd or pm2) somewhere with access to your MQTT broker.

---

## MQTT (optional for `index.js`, required for `aggregator.js`)

`index.js` can run standalone (MQTT disabled, JSON on stdout) or publish to MQTT. If `mqtt.enabled` is `true` in `config.json` but the `mqtt` package isn't installed, it logs a warning and falls back to stdout output rather than crashing.

`aggregator.js` only does anything useful when nodes are publishing to MQTT, so it always requires the dependency:

```
npm install mqtt
```

**Note:** `aggregator.js` does not read `config.json`. Its broker URL (`mqtt://127.0.0.1:1883`), topic names, and 10-minute window are currently hardcoded at the top of the file — edit `aggregator.js` directly if your broker isn't on localhost or you need different topics.

---

## Configuration

Key fields in `config.json` (all consumed by `index.js`):

- `timeoutMs` — per-control-probe timeout in milliseconds
- `emitJson` — emit compact single-line JSON on stdout instead of pretty-printed
- `controlProbes` — endpoints used to confirm the node's own Internet is healthy
- `node.nodeId` — unique identifier for this node (required)
- `node.providerHint` — the carrier/ISP/cloud provider this node is meant to represent (required) — used by the aggregator to group nodes
- `node.state`, `node.region` — optional labels used for scope classification and output
- `node.regionWeight` — optional weighting factor fed into the aggregator's confidence score
- `mqtt.enabled`, `mqtt.url`, `mqtt.presenceBaseTopic`, `mqtt.localBaseTopic`, `mqtt.clientId`, `mqtt.lwt` — MQTT publish settings

---

## Provider naming

`providers/mobile.json`, `providers/isp.json`, and `providers/cloud.json` list the provider name strings (`att`, `verizon`, `comcast_xfinity`, `cloudflare`, etc.) this project was designed around — use them as a naming reference for `node.providerHint` so nodes monitoring the same provider group together correctly in the aggregator. These files aren't read by the code; per-provider probe URLs, DNS checks, and threshold tuning described in earlier versions of this project aren't implemented yet.

---

## Message schemas

**Local status** (from `index.js`, console or `local` MQTT topic):

```json
{
  "type": "node_local_status",
  "nodeId": "MeshMonitor Node 001",
  "providerHint": "att",
  "state": "FL",
  "region": "mia",
  "regionWeight": 1.0,
  "controlOk": true,
  "control": { "passed": 2, "total": 2 },
  "ts": "2026-08-07T19:00:00.000Z"
}
```

**Presence** (from `index.js`, `presence` MQTT topic, retained; LWT publishes an `OFFLINE` variant on unclean disconnect):

```json
{
  "type": "node_presence",
  "nodeId": "MeshMonitor Node 001",
  "presence": "ONLINE",
  "providerHint": "att",
  "ts": "2026-08-07T19:00:00.000Z"
}
```

**Provider scope** (from `aggregator.js`, `scope/<provider>` MQTT topic, retained):

```json
{
  "type": "carrier_outage_scope",
  "detector": "carrier-outage-aggregator",
  "provider": "att",
  "scope": "STATE",
  "severity": "major",
  "confidence": 0.71,
  "impactedCount": 2,
  "affectedStates": ["FL"],
  "ts": "2026-08-07T19:00:05.000Z"
}
```

Scope: `LOCAL` / `STATE` / `NATIONWIDE`. Severity: `minor` / `major` / `critical`.

**Summary** (from `aggregator.js`, `summary` MQTT topic, retained) — same per-provider shape as scope events, keyed by provider, under `{ "type": "carrier_outage_summary", "providers": { ... } }`.

---

## Operational notes

- This script cannot prove **tower-level** or **neighborhood-level** cellular failures.
- Detection quality depends entirely on running `index.js` from **multiple independent nodes** per provider — a single node tells you nothing about scope.
- Scope/severity is recomputed on every incoming message with no debounce beyond the 10-minute freshness window, so treat rapid scope changes as a sign of flapping connectivity, not necessarily a changing outage.

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

Discover other community-contributed scripts for MeshMonitor: https://meshmonitor.org/user-scripts.html
