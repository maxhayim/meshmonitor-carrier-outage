#!/usr/bin/env node
/*
  meshmonitor-carrier-outage

  - Runs once by default (best for cron/schedulers)
  - Uses control probes to avoid false positives
  - Scores providers conservatively and emits a summary + optional JSON + optional MQTT

  Requirements:
    - Node.js 18+ (built-in fetch)

  Optional:
    - MQTT publishing: npm install mqtt
*/

'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const SCRIPT_NAME = 'meshmonitor-carrier-outage';

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const obj = safeJsonParse(raw, null);
  if (!obj) throw new Error(`Invalid JSON: ${filePath}`);
  return obj;
}

function resolvePath(baseDir, maybeRelativePath) {
  if (!maybeRelativePath) return null;
  return path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.join(baseDir, maybeRelativePath);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    // Use GET (HEAD is often blocked/misconfigured). Keep payload minimal.
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': `${SCRIPT_NAME}/1.0 (+https://github.com/maxhayim/${SCRIPT_NAME})`,
        'accept': 'text/html,application/json;q=0.9,*/*;q=0.8'
      }
    });

    // Read a small amount to force connection completion but avoid large downloads.
    // Some servers never complete unless body is read.
    const reader = res.body?.getReader?.();
    if (reader) {
      // Pull at most ~8KB.
      let remaining = 8192;
      while (remaining > 0) {
        const { done, value } = await reader.read();
        if (done) break;
        remaining -= (value?.length || 0);
      }
      try { reader.cancel(); } catch { /* ignore */ }
    }

    const ms = Date.now() - start;
    // Treat 200-399 as OK.
    const ok = res.status >= 200 && res.status < 400;
    return { ok, status: res.status, ms };
  } catch (e) {
    const ms = Date.now() - start;
    const detail = (e && typeof e === 'object' && 'name' in e)
      ? String(e.name)
      : String(e);
    return { ok: false, status: null, ms, detail: detail.includes('AbortError') ? 'timeout' : detail };
  } finally {
    clearTimeout(t);
  }
}

async function dnsCheck(hostname, timeoutMs) {
  const start = Date.now();
  try {
    // dns.promises.resolve4 has no built-in timeout; implement a race.
    const result = await Promise.race([
      dns.resolve4(hostname),
      (async () => { await sleep(timeoutMs); throw new Error('timeout'); })()
    ]);
    const ms = Date.now() - start;
    const ok = Array.isArray(result) && result.length > 0;
    return { ok, ms, detail: ok ? `A=${result[0]}` : 'no_records' };
  } catch (e) {
    const ms = Date.now() - start;
    return { ok: false, ms, detail: String(e.message || e) };
  }
}

function clamp01(n) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function scoreToState(score) {
  // score = fraction of signals failing (0 = perfect, 1 = all failed)
  if (score === 0) return 'OK';
  if (score <= 0.34) return 'DEGRADED';
  return 'MAJOR_OUTAGE';
}

function confidenceFromSignals(total, failed, controlOk) {
  // Conservative: if control is questionable, confidence is near zero.
  if (!controlOk) return 0;
  if (total <= 0) return 0;
  // More failed signals => higher confidence, but cap at 0.95.
  const frac = failed / total;
  return clamp01(Math.min(0.95, 0.2 + frac * 0.9));
}

function summarizeGroup(results) {
  // results: [{provider, state}]
  const counts = results.reduce((acc, r) => {
    acc[r.state] = (acc[r.state] || 0) + 1;
    return acc;
  }, {});
  if ((counts.MAJOR_OUTAGE || 0) > 0) return 'MAJOR_OUTAGE';
  if ((counts.DEGRADED || 0) > 0) return 'DEGRADED';
  return 'OK';
}

function stateFilePath(baseDir) {
  return path.join(baseDir, '.state.json');
}

function loadState(baseDir) {
  const p = stateFilePath(baseDir);
  if (!fs.existsSync(p)) return { providers: {} };
  try {
    return loadJson(p);
  } catch {
    return { providers: {} };
  }
}

function saveState(baseDir, state) {
  const p = stateFilePath(baseDir);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function computePersistedState(prev, currentRawState, failForMajor, okForRecovery) {
  // prev: { state, failStreak, okStreak, firstSeen }
  const next = {
    state: prev?.state || 'OK',
    failStreak: prev?.failStreak || 0,
    okStreak: prev?.okStreak || 0,
    firstSeen: prev?.firstSeen || null
  };

  const isFail = currentRawState !== 'OK';

  if (isFail) {
    next.failStreak += 1;
    next.okStreak = 0;
    if (!next.firstSeen) next.firstSeen = nowIso();

    if (currentRawState === 'MAJOR_OUTAGE') {
      // Promote only after N consecutive runs.
      if (next.failStreak >= failForMajor) next.state = 'MAJOR_OUTAGE';
      else next.state = 'DEGRADED';
    } else {
      // DEGRADED stays DEGRADED immediately.
      next.state = 'DEGRADED';
    }
  } else {
    next.okStreak += 1;
    next.failStreak = 0;

    if (next.state !== 'OK' && next.okStreak >= okForRecovery) {
      next.state = 'RECOVERED';
      // Keep firstSeen for this cycle; it will be cleared after we emit RECOVERED once.
    } else if (next.state === 'RECOVERED') {
      // RECOVERED is a one-shot; after it's been stable OK for another run, settle to OK.
      next.state = 'OK';
      next.firstSeen = null;
    } else if (next.state === 'OK') {
      next.firstSeen = null;
    } else {
      // Still in outage/degraded, but seeing OKs not enough to recover.
      // Keep state as-is.
    }
  }

  return next;
}

async function maybePublishMqtt(cfg, event) {
  if (!cfg?.mqtt?.enabled) return { published: false };

  let mqtt;
  try {
    mqtt = require('mqtt');
  } catch {
    console.error(`[${SCRIPT_NAME}] MQTT enabled but 'mqtt' package not installed. Run: npm install mqtt`);
    return { published: false, error: 'mqtt_not_installed' };
  }

  const url = cfg.mqtt.url;
  const topic = cfg.mqtt.topic;
  const opts = {
    username: cfg.mqtt.username || undefined,
    password: cfg.mqtt.password || undefined,
    clientId: cfg.mqtt.clientId || `${SCRIPT_NAME}-${Math.random().toString(16).slice(2)}`
  };

  return new Promise((resolve) => {
    const client = mqtt.connect(url, opts);
    const payload = JSON.stringify(event);

    const done = (result) => {
      try { client.end(true); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => done({ published: false, error: 'mqtt_timeout' }), 5000);

    client.on('connect', () => {
      client.publish(topic, payload, { qos: 0, retain: false }, (err) => {
        clearTimeout(timer);
        if (err) done({ published: false, error: String(err) });
        else done({ published: true });
      });
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      done({ published: false, error: String(err) });
    });
  });
}

async function run() {
  const baseDir = __dirname;

  const configPath = fs.existsSync(path.join(baseDir, 'config.json'))
    ? path.join(baseDir, 'config.json')
    : path.join(baseDir, 'config.example.json');

  const cfg = loadJson(configPath);
  const region = cfg.region || 'default';
  const timeoutMs = Number(cfg.timeoutMs || 7000);
  const failForMajor = Number(cfg.consecutiveFailForMajor || 3);
  const okForRecovery = Number(cfg.consecutiveOkForRecovery || 5);

  const stateDb = loadState(baseDir);
  if (!stateDb.providers) stateDb.providers = {};

  // 1) Control probes
  const controlSignals = [];
  for (const url of (cfg.controlProbes || [])) {
    const r = await fetchWithTimeout(url, timeoutMs);
    controlSignals.push({ name: `control:${url}`, ok: r.ok, ms: r.ms, status: r.status ?? undefined, detail: r.detail });
  }
  const controlOk = controlSignals.length > 0
    ? controlSignals.filter(s => s.ok).length >= Math.max(1, Math.ceil(controlSignals.length * 0.67))
    : true;

  // 2) Load providers
  const providerFiles = cfg.providers || {};
  const allProviders = [];
  for (const key of Object.keys(providerFiles)) {
    const p = resolvePath(baseDir, providerFiles[key]);
    if (!p || !fs.existsSync(p)) continue;
    const list = loadJson(p);
    if (Array.isArray(list)) allProviders.push(...list);
  }

  // 3) Probe providers
  const providerResults = [];
  for (const provider of allProviders) {
    const signals = [];

    // DNS checks (optional)
    for (const host of (provider.dns || [])) {
      const r = await dnsCheck(host, Math.min(timeoutMs, 5000));
      signals.push({ name: `dns:${host}`, ok: r.ok, ms: r.ms, detail: r.detail });
    }

    // HTTP probes
    for (const url of (provider.probes || [])) {
      const r = await fetchWithTimeout(url, timeoutMs);
      signals.push({ name: `probe:${url}`, ok: r.ok, ms: r.ms, status: r.status ?? undefined, detail: r.detail });
    }

    const total = signals.length;
    const failed = signals.filter(s => !s.ok).length;
    const failFrac = total ? (failed / total) : 0;

    // Raw state from score (pre-persistence)
    let rawState = scoreToState(failFrac);

    // If control probes suggest local Internet issue, suppress provider outages.
    if (!controlOk) rawState = 'OK';

    const confidence = confidenceFromSignals(total, failed, controlOk);

    // Persistence / hysteresis per provider
    const prev = stateDb.providers[provider.name] || {};
    const persisted = computePersistedState(prev, rawState, failForMajor, okForRecovery);

    // RECOVERED should be emitted once, then settle to OK on next run.
    // We'll clear firstSeen after we emit RECOVERED in this run.

    const firstSeen = persisted.firstSeen;
    const lastSeen = nowIso();

    stateDb.providers[provider.name] = persisted;

    providerResults.push({
      provider: provider.name,
      providerType: provider.type,
      state: persisted.state,
      rawState,
      confidence,
      signals
    });

    if (persisted.state === 'RECOVERED') {
      // One-shot; clear firstSeen so next run can settle cleanly.
      stateDb.providers[provider.name].firstSeen = null;
    }

    // Attach timestamps after potential clearing logic
    providerResults[providerResults.length - 1].firstSeen = firstSeen;
    providerResults[providerResults.length - 1].lastSeen = lastSeen;
  }

  saveState(baseDir, stateDb);

  // 4) Group summary
  const mobile = providerResults.filter(r => r.providerType === 'mobile');
  const isp = providerResults.filter(r => r.providerType === 'isp');
  const cloud = providerResults.filter(r => r.providerType === 'cloud');

  const groupSummary = {
    mobile: summarizeGroup(mobile),
    isp: summarizeGroup(isp),
    cloud: summarizeGroup(cloud)
  };

  // 5) Console summary
  const controlOkCount = controlSignals.filter(s => s.ok).length;
  const controlTotal = controlSignals.length;

  console.log(`[${SCRIPT_NAME}] region=${region} ts=${nowIso()}`);
  console.log(`CONTROL: ${controlOk ? 'OK' : 'FAIL'} (${controlOkCount}/${controlTotal})`);

  const compactLine = (label, arr) => {
    if (arr.length === 0) {
      console.log(`${label}: (no providers)`);
      return;
    }
    const parts = arr.map(r => `${r.provider}=${r.state}`);
    console.log(`${label}: ${summarizeGroup(arr)} (${parts.join(', ')})`);
  };

  compactLine('MOBILE', mobile);
  compactLine('ISP', isp);
  compactLine('CLOUD', cloud);

  // 6) Emit events (per provider) when not OK or if RECOVERED.
  // Also emit DEGRADED/MAJOR only if controlOk.
  const events = [];
  for (const r of providerResults) {
    if (r.state === 'OK') continue;

    const event = {
      type: 'carrier_outage',
      detector: SCRIPT_NAME,
      region,
      provider: r.provider,
      providerType: r.providerType,
      state: r.state,
      confidence: r.confidence,
      signals: [
        ...controlSignals,
        ...r.signals
      ],
      firstSeen: r.firstSeen || null,
      lastSeen: r.lastSeen,
      groupSummary
    };

    events.push(event);

    if (cfg.emitJson) {
      // JSON line for log ingestion
      console.log(JSON.stringify(event));
    }

    await maybePublishMqtt(cfg, event);
  }

  // If nothing noteworthy happened, optionally emit a single OK heartbeat JSON.
  if (cfg.emitJson && events.length === 0) {
    const heartbeat = {
      type: 'carrier_outage_heartbeat',
      detector: SCRIPT_NAME,
      region,
      state: 'OK',
      ts: nowIso(),
      control: {
        ok: controlOk,
        passed: controlOkCount,
        total: controlTotal
      },
      groupSummary
    };
    console.log(JSON.stringify(heartbeat));
  }
}

run().catch((err) => {
  console.error(`[${SCRIPT_NAME}] fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
