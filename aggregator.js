#!/usr/bin/env node
'use strict';

const mqtt = require('mqtt');

const cfg = {
  url: 'mqtt://127.0.0.1:1883',
  presenceBase: 'meshmonitor/carrier/presence',
  localBase: 'meshmonitor/carrier/local',
  scopeBase: 'meshmonitor/carrier/scope',
  summaryTopic: 'meshmonitor/carrier/summary',
  windowMs: 10 * 60 * 1000
};

const nodes = new Map();
const providerState = new Map();

function nowISO() {
  return new Date().toISOString();
}

function withinWindow(ts) {
  return ts && (Date.now() - Date.parse(ts)) <= cfg.windowMs;
}

function scopeRank(scope) {
  return scope === 'NATIONWIDE' ? 3 : scope === 'STATE' ? 2 : 1;
}

function classify(nodes) {
  const states = new Map();
  nodes.forEach(n => {
    states.set(n.state, (states.get(n.state) || 0) + 1);
  });

  if (states.size >= 3 || nodes.length >= 5) return 'NATIONWIDE';
  if ([...states.values()].some(c => c >= 2)) return 'STATE';
  return 'LOCAL';
}

function confidence(nodes) {
  const states = new Set(nodes.map(n => n.state).filter(Boolean));
  const weightSum = nodes.reduce(
    (s, n) => s + (typeof n.regionWeight === 'number' ? n.regionWeight : 1.0),
    0
  );
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
});

client.on('message', (topic, payload) => {
  const msg = JSON.parse(payload.toString());
  const nodeId = topic.split('/').pop();
  nodes.set(nodeId, { ...nodes.get(nodeId), ...msg });

  const providers = {};

  for (const n of nodes.values()) {
    if (!withinWindow(n.ts)) continue;
    if (n.presence === 'OFFLINE' || n.controlOk === false) {
      const p = n.providerHint || 'unknown';
      providers[p] = providers[p] || [];
      providers[p].push(n);
    }
  }

  const summary = {
    type: 'carrier_outage_summary',
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
      impactedCount: impacted.length
    };

    client.publish(
      `${cfg.scopeBase}/${provider}`,
      JSON.stringify({
        type: 'carrier_outage_scope',
        provider,
        scope,
        severity: sev,
        confidence: conf,
        impactedCount: impacted.length,
        affectedStates: [...new Set(impacted.map(n => n.state))],
        ts: nowISO()
      }),
      { retain: true }
    );
  }

  client.publish(cfg.summaryTopic, JSON.stringify(summary), { retain: true });
});
  const states = new Map();
  nodes.forEach(n => {
    states.set(n.state, (states.get(n.state) || 0) + 1);
  });

  if (
    states.size >= cfg.nationwideStatesMin ||
    nodes.length >= cfg.nationwideNodesMin
  ) return 'NATIONWIDE';

  if ([...states.values()].some(c => c >= cfg.stateMin))
    return 'STATE';

  return 'LOCAL';
}

function confidence(nodes) {
  const states = new Set(nodes.map(n => n.state));
  const score = nodes.length * 0.6 + states.size * 0.8;
  return Math.min(0.95, 1 - Math.exp(-score / 4));
}

const client = mqtt.connect(cfg.url);

client.on('connect', () => {
  client.subscribe(`${cfg.presenceBase}/+`);
  client.subscribe(`${cfg.localBase}/+`);
  console.log(`[${SCRIPT}] running`);
});

client.on('message', (topic, payload) => {
  const msg = JSON.parse(payload.toString());
  const nodeId = topic.split('/').pop();

  nodes.set(nodeId, { ...nodes.get(nodeId), ...msg });

  const providers = {};

  for (const n of nodes.values()) {
    if (!withinWindow(n.ts)) continue;
    if (n.presence === 'OFFLINE' || n.controlOk === false) {
      const p = n.providerHint || 'unknown';
      providers[p] = providers[p] || [];
      providers[p].push(n);
    }
  }

  for (const [provider, impacted] of Object.entries(providers)) {
    const rawScope = classify(impacted);
    const prev = providerState.get(provider) || {
      scope: 'LOCAL',
      since: Date.now()
    };

    let finalScope = prev.scope;

    if (scopeRank(rawScope) > scopeRank(prev.scope)) {
      if (Date.now() - prev.since >= cfg.debounceMs)
        finalScope = rawScope;
    } else {
      finalScope = rawScope;
    }

    providerState.set(provider, {
      scope: finalScope,
      since: finalScope === prev.scope ? prev.since : Date.now()
    });

    client.publish(
      `${cfg.scopeBase}/${provider}`,
      JSON.stringify({
        type: 'carrier_outage_scope',
        provider,
        scope: finalScope,
        confidence: confidence(impacted),
        impactedCount: impacted.length,
        affectedStates: [...new Set(impacted.map(n => n.state))],
        ts: nowISO()
      }),
      { retain: true }
    );
  }
});
