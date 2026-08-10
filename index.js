#!/usr/bin/env node
// mm_meta:
//   name: Carrier Outage (Node Probe)
//   emoji: 📡
//   language: JavaScript
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = 'carrier-outage';
const STATE_PATH = path.join(__dirname, '.state.json');

function nowISO() {
  return new Date().toISOString();
}

function loadConfig() {
  const p = path.join(__dirname, 'config.json');
  if (!fs.existsSync(p)) {
    throw new Error('Missing config.json (copy config.example.json to config.json)');
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function classifyError(err) {
  if (err && err.name === 'AbortError') return 'timeout';
  const code = err && err.cause && err.cause.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
  if (typeof code === 'string' && (code.includes('CERT') || code.startsWith('ERR_TLS'))) return 'tls';
  return 'network';
}

async function probeUrl(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const ms = Date.now() - start;
    return r.ok ? { ok: true, ms, error: null } : { ok: false, ms, error: 'http_error' };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: classifyError(err) };
  } finally {
    clearTimeout(t);
  }
}

function normalizeTargets(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => (typeof t === 'string' ? { name: t, url: t } : { name: t.name || t.url, url: t.url }))
    .filter((t) => t.url);
}

// Best-effort local flood/anomaly signal: counts established TCP connections
// via `ss` (Linux only) and compares against a rolling baseline persisted
// between runs. Returns null wherever `ss` isn't available (non-Linux hosts,
// containers without iproute2, etc.) rather than guessing.
function countEstablishedConnections() {
  try {
    const out = execFileSync('ss', ['-Htn', 'state', 'established'], { timeout: 3000, encoding: 'utf8' });
    return out.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return null;
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch {
    // best-effort; a missed baseline update just means the next run compares
    // against a slightly stale EMA, not a correctness problem
  }
}

function checkLocalAnomaly(cfg) {
  const laCfg = cfg.localAnomaly || {};
  if (laCfg.enabled === false) return null;

  const count = countEstablishedConnections();
  if (count === null) return null;

  const minConnections = typeof laCfg.minConnections === 'number' ? laCfg.minConnections : 20;
  const ratioThreshold = typeof laCfg.ratio === 'number' ? laCfg.ratio : 3;
  const alpha = typeof laCfg.emaAlpha === 'number' ? laCfg.emaAlpha : 0.3;

  const state = loadState();
  const baseline = typeof state.connBaselineEma === 'number' ? state.connBaselineEma : count;
  const ratio = baseline > 0 ? count / baseline : 1;
  const suspected = count >= minConnections && ratio >= ratioThreshold;

  // Don't fold a suspected flood into the baseline — otherwise a sustained
  // attack would slowly become the new "normal" and stop triggering.
  state.connBaselineEma = suspected ? baseline : baseline * (1 - alpha) + count * alpha;
  saveState(state);

  return {
    connEstablished: count,
    baseline: Math.round(baseline),
    ratio: Math.round(ratio * 100) / 100,
    suspected
  };
}

(async () => {
  const cfg = loadConfig();
  const node = cfg.node || {};
  const mqttCfg = cfg.mqtt || {};
  const timeoutMs = cfg.timeoutMs || 7000;

  if (!node.nodeId) throw new Error('config.node.nodeId is required');
  if (!node.providerHint) throw new Error('config.node.providerHint is required');

  const probes = Array.isArray(cfg.controlProbes) ? cfg.controlProbes : [];
  const controlResults = [];
  for (const url of probes) {
    controlResults.push(await probeUrl(url, timeoutMs));
  }

  const passed = controlResults.filter((r) => r.ok).length;
  const errorCounts = { timeout: 0, dns: 0, refused: 0, reset: 0, tls: 0, http_error: 0, network: 0 };
  for (const r of controlResults) {
    if (!r.ok && r.error) errorCounts[r.error] = (errorCounts[r.error] || 0) + 1;
  }

  let controlOk = true;
  if (probes.length > 0) {
    const required = Math.max(1, Math.ceil(probes.length * 0.67));
    controlOk = passed >= required;
  }

  const localAnomaly = checkLocalAnomaly(cfg);

  const localMsg = {
    type: 'node_local_status',
    nodeId: node.nodeId,
    providerHint: node.providerHint,
    state: node.state || null,
    region: node.region || null,
    regionWeight: typeof node.regionWeight === 'number' ? node.regionWeight : 1.0,
    controlOk,
    control: {
      passed,
      total: probes.length,
      timeoutCount: errorCounts.timeout,
      dnsCount: errorCounts.dns,
      refusedCount: errorCounts.refused,
      otherErrorCount: errorCounts.reset + errorCounts.tls + errorCounts.http_error + errorCounts.network
    },
    localAnomaly,
    ts: nowISO()
  };

  // Target probes are independent of control probes: control probes answer
  // "is my own connection OK", target probes answer "is this other specific
  // thing reachable" (a third-party server/service you want to watch for
  // outages or attacks, not a known-good anchor for your own connectivity).
  const targets = normalizeTargets(cfg.targetProbes);
  let targetMsg = null;
  if (targets.length > 0) {
    const results = [];
    for (const t of targets) {
      const r = await probeUrl(t.url, timeoutMs);
      results.push({ name: t.name, ok: r.ok, ms: r.ms, error: r.error });
    }
    targetMsg = {
      type: 'target_status',
      nodeId: node.nodeId,
      providerHint: node.providerHint,
      controlOk,
      targets: results,
      ts: nowISO()
    };
  }

  function printMessages(emitJson) {
    if (emitJson) {
      console.log(JSON.stringify(localMsg));
      if (targetMsg) console.log(JSON.stringify(targetMsg));
    } else {
      console.log(JSON.stringify(localMsg, null, 2));
      if (targetMsg) console.log(JSON.stringify(targetMsg, null, 2));
    }
  }

  // If MQTT is disabled, emit JSON (optional) and exit cleanly
  if (!mqttCfg.enabled) {
    printMessages(cfg.emitJson);
    process.exit(0);
  }

  let mqtt;
  try {
    mqtt = require('mqtt');
  } catch {
    console.warn(`[${SCRIPT}] mqtt.enabled is true but the "mqtt" package is not installed; run "npm install mqtt". Continuing without MQTT output.`);
    printMessages(cfg.emitJson);
    process.exit(0);
  }

  const presenceTopic = `${mqttCfg.presenceBaseTopic}/${node.nodeId}`;
  const localTopic = `${mqttCfg.localBaseTopic}/${node.nodeId}`;
  const targetTopic = targetMsg ? `${mqttCfg.targetBaseTopic}/${node.nodeId}` : null;

  const client = mqtt.connect(mqttCfg.url, {
    clientId: mqttCfg.clientId,
    will: mqttCfg.lwt ? {
      topic: presenceTopic,
      payload: JSON.stringify({
        type: 'node_presence',
        nodeId: node.nodeId,
        presence: 'OFFLINE',
        ts: nowISO()
      }),
      retain: true
    } : undefined
  });

  client.on('connect', () => {
    let pending = targetMsg ? 3 : 2;
    const done = () => {
      if (--pending === 0) {
        if (cfg.emitJson) {
          console.log(JSON.stringify(localMsg));
          if (targetMsg) console.log(JSON.stringify(targetMsg));
        }
        client.end();
      }
    };

    client.publish(
      presenceTopic,
      JSON.stringify({
        type: 'node_presence',
        nodeId: node.nodeId,
        presence: 'ONLINE',
        providerHint: node.providerHint,
        state: node.state || null,
        region: node.region || null,
        regionWeight: typeof node.regionWeight === 'number' ? node.regionWeight : 1.0,
        ts: nowISO()
      }),
      { retain: true },
      done
    );

    client.publish(localTopic, JSON.stringify(localMsg), { retain: true }, done);

    if (targetMsg) {
      client.publish(targetTopic, JSON.stringify(targetMsg), { retain: true }, done);
    }
  });

  client.on('error', (err) => {
    console.error(`[${SCRIPT}] MQTT error`, err);
    try { client.end(true); } catch {}
    process.exit(1);
  });
})().catch((err) => {
  console.error(`[${SCRIPT}] error`, err);
  process.exit(1);
});
