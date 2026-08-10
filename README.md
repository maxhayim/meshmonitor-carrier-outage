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

> "Is the problem local to my node or ISP, or is there a wider provider-level event — and does it look like a routine outage or an attack?"

It also carries a lightweight, best-effort **attack/DDoS likelihood heuristic**: when an outage looks like it is, it flags that alongside the outage itself. This is inference from connectivity patterns, not packet-level detection — see [Attack/DDoS heuristics](#attackddos-heuristics) for exactly what it can and can't tell you.

---

## Architecture

Carrier Outage has two parts that work together:

- **`index.js`** — a short-lived **probe**, run on a schedule (cron, systemd timer, etc.) on each node/vantage point you want to monitor. Each run checks whether *that* node's Internet is reachable and publishes the result.
- **`aggregator.js`** — a single long-running **collector**, subscribed over MQTT to every node's probe results. It correlates results across nodes that share the same `providerHint` (e.g. all your `att` nodes) and publishes a scope/severity verdict per provider.

A single probe run only tells you about one node. The aggregator is what turns "my node's Internet is down" into "AT&T looks down across 3 states" — you need both pieces running for outage detection to actually work, not just `index.js` alone.

---

## How detection works

**Per node (`index.js`):**

1. Hits a small list of **control probes** (known-good, high-availability endpoints you configure) with a timeout, recording pass/fail, response time, and an error class (`timeout` / `dns` / `refused` / `tls` / `http_error` / `network`) for each.
2. If at least 67% of control probes succeed, the node considers its own connectivity `controlOk: true`; otherwise `false`.
3. Optionally hits a separate list of **target probes** — specific third-party servers/services you want to watch (not "known-good" anchors, things you actually care about) — the same way, and reports their per-target results independently of its own `controlOk`.
4. Optionally checks its own **established TCP connection count** (Linux `ss`, best-effort) against a rolling local baseline, flagging a sudden multi-x spike as a possible local flood/attack signal.
5. Publishes an `ONLINE` presence message, a local-status message (nodeId, `providerHint`, state, region, `controlOk`, control diagnostics, local-anomaly signal), and — if target probes are configured — a target-status message. Either over MQTT (retained, with a Last Will offline message) or as JSON on stdout if MQTT is disabled.

**Aggregation (`aggregator.js`):**

1. Subscribes to every node's presence, local-status, and target-status topics.
2. Treats a node as *impacted* if it's `OFFLINE` (via presence/LWT) or reported `controlOk: false`, within a 10-minute rolling window.
3. Groups impacted nodes by `providerHint` and classifies scope:
   - **NATIONWIDE** — impacted nodes span ≥3 distinct states, or ≥5 nodes total
   - **STATE** — ≥2 impacted nodes share the same state
   - **LOCAL** — otherwise
4. Computes a **confidence** score (0–0.95) from how spread out and how heavily-weighted the impacted nodes are, a **severity** (`critical` / `major` / `minor`) from scope + confidence + node count, and an **attack-likelihood** score/label (see below).
5. Separately, correlates target-probe reports across nodes: if ≥2 independent nodes with their *own* connection healthy (`controlOk: true`) all report the same target unreachable, that's treated as a target-level incident (the target's problem, not yours) — with its own attack-likelihood score.
6. Publishes a per-provider scope event, per-target incident events, an overall summary, and (when the attack-likelihood score crosses a threshold) a dedicated attack-alert event — all retained over MQTT. Recovered providers/targets/alerts are explicitly republished as cleared rather than left stuck at their last retained state.

This is a **stateless, single-snapshot** classifier — each incoming message immediately recomputes and republishes scope for the affected provider/target. There's no run-to-run persistence or debounce window beyond the 10-minute freshness cutoff, so a provider can flip between scopes quickly if node status is flapping. Run probes from **multiple independent vantage points** for a meaningful signal — a single node's control-probe failure just means that node's Internet is down, not a provider outage.

---

## Attack/DDoS heuristics

Carrier Outage does **not** do packet inspection, traffic capture, or anything that could reliably confirm a DDoS. What it does is score how much an outage's *shape* looks like a flood/attack versus a routine failure, using three signals it already has:

1. **Onset clustering** — how tightly clustered in time independent nodes' failures started (tracked via the aggregator's own receive-time, not each node's self-reported clock, since node clocks may be skewed). Near-simultaneous failures across nodes score higher than a failure that spreads out gradually.
2. **Timeout dominance** — what fraction of failed control probes were timeouts specifically, versus DNS failures, connection-refused, etc. Widespread timeouts are more consistent with saturation/flood conditions than a clean "service is down" signature.
3. **Local anomaly corroboration** — for providers only, whether any impacted node also flagged a local connection-count spike (see `localAnomaly` below).

These combine into an `attackLikelihood` score (0–0.95) and a label:

- `possible-ddos` — score ≥ 0.65
- `uncertain` — score ≥ 0.35
- `routine` — below that, or fewer than 2 independent nodes involved (a single node's failure can't say anything about clustering)

This score rides along on the normal scope/summary/target-incident events, and — when it crosses the `possible-ddos` threshold — also triggers a dedicated, retained alert on `meshmonitor/carrier/attack/<provider|target>/<name>`, cleared automatically once the score drops back down. Treat this as a prioritization signal for a human to look closer, not a verdict.

### Local connection-flood signal (`localAnomaly`)

Best-effort and Linux-only: `index.js` counts established TCP connections via `ss` and compares against a rolling exponential-moving-average baseline persisted in `.state.json` next to the script. A sudden multi-x spike relative to that baseline is flagged as `suspected: true`. The baseline deliberately does **not** update while a spike is active, so a sustained flood doesn't get absorbed into the new "normal" and stop triggering. On non-Linux hosts, or if `ss` isn't available, this just reports `null` — no error, no crash.

This tells you *your own host* saw an unusual number of connections, nothing more. It can't distinguish an actual attack from, say, a backup job or a burst of legitimate traffic — treat `suspected: true` as "worth a manual look," especially if it lines up with a control-probe failure.

---

## Outputs

- **`index.js`**: console/stdout (JSON, always when MQTT is disabled), or MQTT presence + local-status + target-status topics (retained) when enabled.
- **`aggregator.js`**: MQTT scope topics (one per provider), target-incident topics (one per target), an overall summary topic, and attack-alert topics — all retained, continuously as messages arrive.

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

- `timeoutMs` — per-probe timeout in milliseconds (applies to both control and target probes)
- `emitJson` — emit compact single-line JSON on stdout instead of pretty-printed
- `controlProbes` — endpoints used to confirm the node's own Internet is healthy
- `targetProbes` — optional list of third-party endpoints to watch, as `{ "name": "...", "url": "..." }` or plain URL strings. Independent of `controlProbes` — see [Architecture](#architecture)
- `localAnomaly.enabled` — set `false` to skip the local connection-count check entirely (default `true`)
- `localAnomaly.minConnections` — minimum established-connection count before a spike can be flagged (default `20`, avoids noise on quiet hosts)
- `localAnomaly.ratio` — how many times above baseline counts as a spike (default `3`)
- `localAnomaly.emaAlpha` — smoothing factor for the rolling baseline (default `0.3`)
- `node.nodeId` — unique identifier for this node (required)
- `node.providerHint` — the carrier/ISP/cloud provider this node is meant to represent (required) — used by the aggregator to group nodes
- `node.state`, `node.region` — optional labels used for scope classification and output
- `node.regionWeight` — optional weighting factor fed into the aggregator's confidence score
- `mqtt.enabled`, `mqtt.url`, `mqtt.presenceBaseTopic`, `mqtt.localBaseTopic`, `mqtt.targetBaseTopic`, `mqtt.clientId`, `mqtt.lwt` — MQTT publish settings (`targetBaseTopic` only needed if `targetProbes` is set)

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
  "control": { "passed": 2, "total": 2, "timeoutCount": 0, "dnsCount": 0, "refusedCount": 0, "otherErrorCount": 0 },
  "localAnomaly": { "connEstablished": 14, "baseline": 12, "ratio": 1.17, "suspected": false },
  "ts": "2026-08-07T19:00:00.000Z"
}
```

`localAnomaly` is `null` wherever the local connection-count check isn't available (non-Linux, `ss` missing, or `localAnomaly.enabled: false`).

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

**Target status** (from `index.js`, `target` MQTT topic, retained; only published if `targetProbes` is configured):

```json
{
  "type": "target_status",
  "nodeId": "MeshMonitor Node 001",
  "providerHint": "att",
  "controlOk": true,
  "targets": [
    { "name": "my-home-server", "ok": false, "ms": 7002, "error": "timeout" }
  ],
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
  "attackLikelihood": 0.85,
  "attackLabel": "possible-ddos",
  "ts": "2026-08-07T19:00:05.000Z"
}
```

Scope: `LOCAL` / `STATE` / `NATIONWIDE`, or `NONE` when republished after recovery (see below). Severity: `minor` / `major` / `critical`. `attackLabel`: `routine` / `uncertain` / `possible-ddos`.

**Target incident** (from `aggregator.js`, `target-incident/<name>` MQTT topic, retained; only published once ≥2 independent, otherwise-healthy nodes report the same target down):

```json
{
  "type": "carrier_target_incident",
  "detector": "carrier-outage-aggregator",
  "target": "my-home-server",
  "impactedCount": 2,
  "reportingNodes": ["nodeA", "nodeB"],
  "attackLikelihood": 0.35,
  "attackLabel": "uncertain",
  "ts": "2026-08-07T19:00:05.000Z"
}
```

**Attack alert** (from `aggregator.js`, `attack/<provider|target>/<name>` MQTT topic, retained; only published while `attackLikelihood` is at or above the `possible-ddos` threshold, then republished once with `attackLabel: "cleared"` when it drops back down):

```json
{
  "type": "carrier_attack_alert",
  "detector": "carrier-outage-aggregator",
  "subjectType": "provider",
  "subject": "att",
  "attackLikelihood": 0.85,
  "attackLabel": "possible-ddos",
  "ts": "2026-08-07T19:00:05.000Z"
}
```

**Summary** (from `aggregator.js`, `summary` MQTT topic, retained) — same per-provider shape as scope events, keyed by provider, under `{ "type": "carrier_outage_summary", "providers": { ... } }`.

**Recovery:** when a provider or target that previously had an incident stops being impacted, `aggregator.js` explicitly republishes its scope/incident topic (scope `NONE`, `impactedCount: 0`) and clears any standing attack alert, rather than leaving the last incident's retained message stuck on the broker forever.

---

## Operational notes

- This script cannot prove **tower-level** or **neighborhood-level** cellular failures.
- Detection quality depends entirely on running `index.js` from **multiple independent nodes** per provider — a single node tells you nothing about scope.
- Scope/severity is recomputed on every incoming message with no debounce beyond the 10-minute freshness window, so treat rapid scope changes as a sign of flapping connectivity, not necessarily a changing outage.
- `attackLikelihood`/`attackLabel` are a heuristic built from connectivity patterns this script already observes (onset timing, timeout rates, local connection spikes) — not a confirmed detection. Nothing here does packet capture or traffic analysis. Use it to prioritize what to look at, not as proof of an attack.

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
