#!/usr/bin/env node
'use strict';

const mqtt = require('mqtt');

const SCRIPT = 'carrier-outage-aggregator';

const cfg = {
  url: process.env.MQTT_URL || 'mqtt://127.0.0.1:1883',
  presenceBase: 'meshmonitor/carrier/presence',
  localBase: 'meshmonitor/carrier/local',
  scopeBase: 'meshmonitor/carrier/scope',

  windowMs: 10 * 60 * 1000,
  debounceMs: 90 * 1000,
  stateMin: 2,
  nationwideStatesMin: 3,
  nationwideNodesMin: 5
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
