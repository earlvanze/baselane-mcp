#!/usr/bin/env node
/**
 * Execute a GraphQL query against Baselane with automatic appcheck token capture.
 * Navigates to transactions page first to generate traffic, captures x-firebase-appcheck,
 * then fires the GraphQL query with both cookies and appcheck.
 */
const fs = require('fs');
const versionUrl = 'http://localhost:9222/json/version';
const targetUrl = 'https://app.baselane.com/transactions';
const timeoutMs = 60000;
const inputPath = process.argv[2];

if (!inputPath) {
  console.error('usage: baselane_gql_authed.js <input.json>');
  process.exit(2);
}
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

async function main() {
  const version = await (await fetch(versionUrl)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const sessions = new Map();
  let lastAppCheck = null;

  function send(method, params = {}, sessionId) {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    });
  }

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
      return;
    }
    if (msg.method === 'Target.attachedToTarget') {
      sessions.set(msg.params.targetInfo.targetId, msg.params.sessionId);
      return;
    }
    // Capture appcheck from any Baselane orchestration request
    if (msg.sessionId && msg.method === 'Network.requestWillBeSentExtraInfo') {
      const h = msg.params.headers || {};
      const authority = h[':authority'] || h['host'] || h['Host'] || '';
      if (String(authority).includes('orchestration.baselane.com')) {
        const v = h['x-firebase-appcheck'] || h['X-Firebase-AppCheck'];
        if (v) lastAppCheck = v;
      }
    }
  };

  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const targets = await send('Target.getTargets', {});
  const tab = (targets.targetInfos || []).find(t => t.type === 'page' && t.url && t.url.includes('app.baselane.com') && !t.url.includes('/login'));
  if (!tab) throw new Error('No authenticated Baselane tab found');

  const attached = await send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  const sessionId = attached.sessionId;

  await send('Network.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);

  // Force a page reload to generate network traffic and capture appcheck
  console.error('[GQL] Reloading page to capture appcheck token...');
  await send('Page.reload', {}, sessionId);
  
  const start = Date.now();
  while (!lastAppCheck && (Date.now() - start) < timeoutMs) {
    await new Promise(r => setTimeout(r, 250));
  }
  if (!lastAppCheck) throw new Error('timed out waiting for x-firebase-appcheck');
  console.error('[GQL] Got appcheck token');

  // Execute the GraphQL query using fetch inside the page context
  const expression = `
    (async () => {
      const payload = ${JSON.stringify(input)};
      const resp = await fetch('https://orchestration.baselane.com/graphql', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'accept': '*/*',
          'content-type': 'application/json',
          'x-firebase-appcheck': '${lastAppCheck}'
        },
        body: JSON.stringify(payload)
      });
      const text = await resp.text();
      return JSON.stringify({ status: resp.status, text });
    })()
  `;
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  const outer = JSON.parse(result.result.value);
  console.log(outer.text);
  ws.close();
  process.exit(outer.status === 200 ? 0 : 1);
}

main().catch(err => { console.error('ERROR:', err.message || String(err)); process.exit(1); });
