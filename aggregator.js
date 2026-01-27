#!/usr/bin/env node
// mm_meta:
//   name: Carrier Outage (Aggregator)
//   emoji: 🧠
//   language: JavaScript
'use strict';

const mqtt = require('mqtt');

const SCRIPT = 'carrier-outage-aggregator';

const cfg = {
  url: 'mqtt://127.0.0.1:1883',
  presenceBase: 'meshmonitor/carrier/presence',
  localBase: 'meshmonitor/carrier/local',
  scopeBase: 'meshmonitor/carrier/scope',
  summaryTopic: 'meshmonitor/carrier/summary',
  windowMs: 10 * 60 * 1000
};

const nodes = new Map();
// kept for future debounce/state handling if you expand; currently unused
const providerState = new Map();

function nowISO() {
  return new Date().toISOString();
}

function withinWindow(ts) {
  return ts && (Date.now() - Date.parse(ts)) <= cfg.windowMs;
}

function classify(impactedNodes) {
  const states = new Map();
  impactedNodes.forEach(n => {
    const st = n.state || 'UNKNOWN';
    states.set(st, (states.get(st) || 0) + 1);
  });

  // Basic scope heuristics (conservative defaults)
  // - NATIONWIDE: >=3 states (known) OR >=5 nodes
  // - STATE: >=2 nodes in the same known state
  const knownStatesCount = [...states.keys()].filter(s => s !== 'UNKNOWN').length;

  if (knownStatesCount >= 3 || impactedNodes.length >= 5) return 'NATIONWIDE';
  if ([...states.entries()].some(([st, c]) => st !== 'UNKNOWN' && c >= 2)) return 'STATE';
  return 'LOCAL';
}

function confidence(impactedNodes) {
  const states = new Set(impactedNodes.map(n => n.state).filter(Boolean));
  const weightSum = impactedNodes.reduce(
    (s, n) => s + (typeof n.regionWeight === 'number' ? n.regionWeight : 1.0),
    0
  );

  // Simple spread + weight confidence curve
  const score = Math.log1p(weightSum) + Math.log1p(states.size);
  return Math.min(0.95, 1 - Math.exp(-score));
}

function severity(scope, conf, count) {
  if (scope === 'NATIONWIDE' && conf >= 0.7) return 'critical';
  if (scope === 'STATE' && conf >= 0.55) return 'major';
  if (count >= 4 && conf >= 0.5) return 'major';
  return 'minor';
}

const client = mqtt.connect(cfg.url);

client.on('connect', () => {
  client.subscribe(`${cfg.presenceBase}/+`);
  client.subscribe(`${cfg.localBase}/+`);
  console.log(`[${SCRIPT}] running`);
});

client.on('error', (err) => {
  console.error(`[${SCRIPT}] mqtt error`, err);
});

client.on('message', (topic, payload) => {
  let msg;
  try {
    msg = JSON.parse(payload.toString());
  } catch {
    return;
  }

  const nodeId = topic.split('/').pop();
  nodes.set(nodeId, { ...nodes.get(nodeId), ...msg, nodeId });

  // providerHint -> impacted nodes
  const providers = {};

  for (const n of nodes.values()) {
    if (!withinWindow(n.ts)) continue;

    // Treat OFFLINE or controlOk=false as "impacted"
    if (n.presence === 'OFFLINE' || n.controlOk === false) {
      const p = n.providerHint || 'unknown';
      providers[p] = providers[p] || [];
      providers[p].push(n);
    }
  }

  const summary = {
    type: 'carrier_outage_summary',
    detector: SCRIPT,
    ts: nowISO(),
    providers: {}
  };

  for (const [provider, impacted] of Object.entries(providers)) {
    const scope = classify(impacted);
    const conf = confidence(impacted);
    const sev = severity(scope, conf, impacted.length);

    summary.providers[provider] = {
      scope,
      severity: sev,
      confidence: conf,
      impactedCount: impacted.length,
      affectedStates: [...new Set(impacted.map(n => n.state).filter(Boolean))]
    };

    client.publish(
      `${cfg.scopeBase}/${provider}`,
      JSON.stringify({
        type: 'carrier_outage_scope',
        detector: SCRIPT,
        provider,
        scope,
        severity: sev,
        confidence: conf,
        impactedCount: impacted.length,
        affectedStates: summary.providers[provider].affectedStates,
        ts: nowISO()
      }),
      { retain: true }
    );
  }

  client.publish(cfg.summaryTopic, JSON.stringify(summary), { retain: true });
});
