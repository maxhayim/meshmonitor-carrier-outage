#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const SCRIPT = 'carrier-outage';

function nowISO() {
  return new Date().toISOString();
}

const cfg = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')
);

const node = cfg.node;
const mqttCfg = cfg.mqtt;

async function run() {
  let controlPassed = 0;

  for (const url of cfg.controlProbes || []) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      const r = await fetch(url, { signal: ctrl.signal });
      if (r.ok) controlPassed++;
    } catch {}
  }

  const required = Math.max(1, Math.ceil((cfg.controlProbes || []).length * 0.67));
  const controlOk = controlPassed >= required;

  if (!mqttCfg || !mqttCfg.enabled) {
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
