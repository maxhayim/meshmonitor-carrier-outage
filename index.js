#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const SCRIPT = 'carrier-outage';

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

async function fetchOk(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return !!r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  const cfg = loadConfig();
  const node = cfg.node || {};
  const mqttCfg = cfg.mqtt || {};

  if (!node.nodeId) throw new Error('config.node.nodeId is required');
  if (!node.providerHint) throw new Error('config.node.providerHint is required');

  const probes = Array.isArray(cfg.controlProbes) ? cfg.controlProbes : [];
  let passed = 0;

  for (const url of probes) {
    if (await fetchOk(url, cfg.timeoutMs || 7000)) passed++;
  }

  let controlOk = true;
  if (probes.length > 0) {
    const required = Math.max(1, Math.ceil(probes.length * 0.67));
    controlOk = passed >= required;
  }

  const localMsg = {
    type: 'node_local_status',
    nodeId: node.nodeId,
    providerHint: node.providerHint,
    state: node.state || null,
    region: node.region || null,
    regionWeight: typeof node.regionWeight === 'number' ? node.regionWeight : 1.0,
    controlOk,
    control: { passed, total: probes.length },
    ts: nowISO()
  };

  if (!mqttCfg.enabled) {
    if (cfg.emitJson) console.log(JSON.stringify(localMsg));
    process.exit(0);
  }

  const presenceTopic = `${mqttCfg.presenceBaseTopic}/${node.nodeId}`;
  const localTopic = `${mqttCfg.localBaseTopic}/${node.nodeId}`;

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
      { retain: true }
    );

    client.publish(localTopic, JSON.stringify(localMsg), { retain: true });
    if (cfg.emitJson) console.log(JSON.stringify(localMsg));
    client.end(true);
  });
})();
    console.log(JSON.stringify({
      type: 'node_local_status',
      nodeId: node.nodeId,
      providerHint: node.providerHint,
      state: node.state,
      region: node.region,
      controlOk,
      ts: nowISO()
    }, null, 2));
    return;
  }

  const presenceTopic = `${mqttCfg.presenceBaseTopic}/${node.nodeId}`;
  const localTopic = `${mqttCfg.localBaseTopic}/${node.nodeId}`;

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
    client.publish(
      presenceTopic,
      JSON.stringify({
        type: 'node_presence',
        nodeId: node.nodeId,
        presence: 'ONLINE',
        providerHint: node.providerHint,
        state: node.state,
        region: node.region,
        ts: nowISO()
      }),
      { retain: true }
    );

    client.publish(
      localTopic,
      JSON.stringify({
        type: 'node_local_status',
        nodeId: node.nodeId,
        providerHint: node.providerHint,
        state: node.state,
        region: node.region,
        controlOk,
        ts: nowISO()
      }),
      { retain: true }
    );

    client.end();
  });
}

run().catch(err => {
  console.error(`[${SCRIPT}] error`, err);
  process.exit(1);
});
