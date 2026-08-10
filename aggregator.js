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
  targetBase: 'meshmonitor/carrier/target',
  scopeBase: 'meshmonitor/carrier/scope',
  summaryTopic: 'meshmonitor/carrier/summary',
  targetIncidentBase: 'meshmonitor/carrier/target-incident',
  attackBase: 'meshmonitor/carrier/attack',
  windowMs: 10 * 60 * 1000,
  minNodesForTargetIncident: 2,
  attackLikelihoodThreshold: 0.65
};

// Per-node presence/local-status records, keyed by nodeId.
const nodes = new Map();
// Per-node target-probe records, keyed by nodeId.
const targetNodes = new Map();
// Providers/targets/attack-alerts currently published as impacted, so we
// know when to publish a "cleared" message instead of leaving a stale
// retained incident on the broker forever.
const activeProviderIncidents = new Set();
const activeTargetIncidents = new Set();
const activeAttackAlerts = new Set();

function nowISO() {
  return new Date().toISOString();
}

function withinWindow(ts) {
  return ts && (Date.now() - Date.parse(ts)) <= cfg.windowMs;
}

function pruneStale(map) {
  for (const [id, n] of map) {
    if (!withinWindow(n.ts)) map.delete(id);
  }
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

// How tightly clustered in time the impacted nodes' failures started.
// A near-simultaneous onset across independent nodes looks more like a
// sudden flood/attack than a gradual, organically-spreading outage.
function onsetSpreadMs(impactedRecords) {
  const times = impactedRecords
    .map((n) => n.firstImpactedAt && Date.parse(n.firstImpactedAt))
    .filter((t) => !Number.isNaN(t));
  if (times.length < 2) return null;
  return Math.max(...times) - Math.min(...times);
}

// Fraction of failed control probes across impacted nodes that were
// timeouts specifically (as opposed to DNS failures, connection refused,
// etc). Widespread timeouts are more consistent with saturation/flood
// conditions than a clean service-down signature.
function errorSignature(impactedNodes) {
  let timeoutSum = 0;
  let failedSum = 0;
  for (const n of impactedNodes) {
    const c = n.control || {};
    failedSum += Math.max(0, (c.total || 0) - (c.passed || 0));
    timeoutSum += c.timeoutCount || 0;
  }
  return { timeoutFraction: failedSum > 0 ? timeoutSum / failedSum : 0 };
}

// Heuristic, not a confirmed detection: combines onset clustering, timeout
// dominance, and (for providers) local flood corroboration into a 0-0.95
// score. Needs at least 2 independent vantage points to say anything at all
// about clustering -- a single node's outage tells you nothing about scope.
function attackLikelihood({ spreadMs, timeoutFraction, anyLocalAnomaly, nodeCount }) {
  if (nodeCount < 2) return { score: 0, label: 'routine' };

  let clusterScore = 0;
  if (spreadMs !== null) {
    if (spreadMs <= 60 * 1000) clusterScore = 1;
    else if (spreadMs <= 5 * 60 * 1000) clusterScore = 0.6;
    else if (spreadMs <= 15 * 60 * 1000) clusterScore = 0.3;
  }

  const timeoutScore = Math.max(0, Math.min(1, timeoutFraction));
  const localBoost = anyLocalAnomaly ? 1 : 0;
  const score = Math.min(0.95, 0.5 * clusterScore + 0.35 * timeoutScore + 0.15 * localBoost);
  const label = score >= cfg.attackLikelihoodThreshold ? 'possible-ddos' : score >= 0.35 ? 'uncertain' : 'routine';
  return { score: Math.round(score * 100) / 100, label };
}

function publishAttackAlert(subjectType, subject, attack, cleared) {
  client.publish(
    `${cfg.attackBase}/${subjectType}/${subject}`,
    JSON.stringify({
      type: 'carrier_attack_alert',
      detector: SCRIPT,
      subjectType,
      subject,
      attackLikelihood: attack.score,
      attackLabel: cleared ? 'cleared' : attack.label,
      ts: nowISO()
    }),
    { retain: true }
  );
}

// Publishes (or clears) a standing "possible-ddos" alert for a provider or
// target, independent of its outage/incident topic, so downstream consumers
// can subscribe to just the attack topic for high-signal alerts.
function updateAttackAlert(subjectType, subject, attack) {
  const key = `${subjectType}:${subject}`;
  const isAlerting = attack.score >= cfg.attackLikelihoodThreshold;

  if (isAlerting) {
    publishAttackAlert(subjectType, subject, attack, false);
    activeAttackAlerts.add(key);
  } else if (activeAttackAlerts.has(key)) {
    publishAttackAlert(subjectType, subject, attack, true);
    activeAttackAlerts.delete(key);
  }
}

function publishScope(provider, data) {
  client.publish(
    `${cfg.scopeBase}/${provider}`,
    JSON.stringify({
      type: 'carrier_outage_scope',
      detector: SCRIPT,
      provider,
      ...data,
      ts: nowISO()
    }),
    { retain: true }
  );
}

function publishScopeCleared(provider) {
  publishScope(provider, {
    scope: 'NONE',
    severity: null,
    confidence: 0,
    impactedCount: 0,
    affectedStates: [],
    attackLikelihood: 0,
    attackLabel: 'routine'
  });
}

function recomputeProviders() {
  const providers = {};

  for (const n of nodes.values()) {
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

    const spreadMs = onsetSpreadMs(impacted);
    const { timeoutFraction } = errorSignature(impacted);
    const anyLocalAnomaly = impacted.some((n) => n.localAnomaly && n.localAnomaly.suspected);
    const attack = attackLikelihood({ spreadMs, timeoutFraction, anyLocalAnomaly, nodeCount: impacted.length });

    summary.providers[provider] = {
      scope,
      severity: sev,
      confidence: conf,
      impactedCount: impacted.length,
      affectedStates: [...new Set(impacted.map(n => n.state).filter(Boolean))],
      attackLikelihood: attack.score,
      attackLabel: attack.label
    };

    publishScope(provider, summary.providers[provider]);
    activeProviderIncidents.add(provider);
    updateAttackAlert('provider', provider, attack);
  }

  const seenProviders = new Set(Object.keys(providers));
  for (const provider of [...activeProviderIncidents]) {
    if (!seenProviders.has(provider)) {
      publishScopeCleared(provider);
      updateAttackAlert('provider', provider, { score: 0, label: 'routine' });
      activeProviderIncidents.delete(provider);
    }
  }

  client.publish(cfg.summaryTopic, JSON.stringify(summary), { retain: true });
}

function handleNodeMessage(nodeId, msg) {
  const prev = nodes.get(nodeId);
  const merged = { ...prev, ...msg, nodeId };
  const isImpacted = merged.presence === 'OFFLINE' || merged.controlOk === false;
  merged.firstImpactedAt = isImpacted ? ((prev && prev.firstImpactedAt) || nowISO()) : null;

  nodes.set(nodeId, merged);
  pruneStale(nodes);
  recomputeProviders();
}

function publishTargetIncident(target, data) {
  client.publish(
    `${cfg.targetIncidentBase}/${target}`,
    JSON.stringify({
      type: 'carrier_target_incident',
      detector: SCRIPT,
      target,
      ...data,
      ts: nowISO()
    }),
    { retain: true }
  );
}

function recomputeTargets() {
  // targetName -> nodes currently reporting it unreachable while their own
  // connection is fine (controlOk === true) -- a node whose own connection
  // is down can't tell you anything trustworthy about a third-party target.
  const impactedByTarget = {};

  for (const n of targetNodes.values()) {
    if (n.controlOk !== true) continue;
    for (const t of n.targets || []) {
      if (t.ok) continue;
      impactedByTarget[t.name] = impactedByTarget[t.name] || [];
      impactedByTarget[t.name].push({ nodeId: n.nodeId, ...t });
    }
  }

  const seenTargets = new Set(
    Object.keys(impactedByTarget).filter((t) => impactedByTarget[t].length >= cfg.minNodesForTargetIncident)
  );

  for (const target of seenTargets) {
    const impacted = impactedByTarget[target];
    const timeoutCount = impacted.filter((r) => r.error === 'timeout').length;
    const timeoutFraction = timeoutCount / impacted.length;
    const times = impacted
      .map((r) => r.firstImpactedAt && Date.parse(r.firstImpactedAt))
      .filter((t) => !Number.isNaN(t));
    const spreadMs = times.length >= 2 ? Math.max(...times) - Math.min(...times) : null;

    const attack = attackLikelihood({ spreadMs, timeoutFraction, anyLocalAnomaly: false, nodeCount: impacted.length });

    publishTargetIncident(target, {
      impactedCount: impacted.length,
      reportingNodes: impacted.map((r) => r.nodeId),
      attackLikelihood: attack.score,
      attackLabel: attack.label
    });

    activeTargetIncidents.add(target);
    updateAttackAlert('target', target, attack);
  }

  for (const target of [...activeTargetIncidents]) {
    if (!seenTargets.has(target)) {
      publishTargetIncident(target, {
        impactedCount: 0,
        reportingNodes: [],
        attackLikelihood: 0,
        attackLabel: 'routine'
      });
      updateAttackAlert('target', target, { score: 0, label: 'routine' });
      activeTargetIncidents.delete(target);
    }
  }
}

function handleTargetMessage(nodeId, msg) {
  const prev = targetNodes.get(nodeId);
  const prevTargets = new Map(((prev && prev.targets) || []).map((t) => [t.name, t]));

  const targets = (Array.isArray(msg.targets) ? msg.targets : []).map((t) => {
    const prevT = prevTargets.get(t.name);
    const firstImpactedAt = !t.ok ? ((prevT && !prevT.ok && prevT.firstImpactedAt) || msg.ts) : null;
    return { ...t, firstImpactedAt };
  });

  targetNodes.set(nodeId, { ...msg, nodeId, targets });
  pruneStale(targetNodes);
  recomputeTargets();
}

const client = mqtt.connect(cfg.url);

client.on('connect', () => {
  client.subscribe(`${cfg.presenceBase}/+`);
  client.subscribe(`${cfg.localBase}/+`);
  client.subscribe(`${cfg.targetBase}/+`);
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

  if (topic.startsWith(`${cfg.targetBase}/`)) {
    handleTargetMessage(nodeId, msg);
  } else {
    handleNodeMessage(nodeId, msg);
  }
});
