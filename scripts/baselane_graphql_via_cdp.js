#!/usr/bin/env node
const fs = require('fs');

const versionUrl = process.env.BASELANE_CDP_VERSION_URL || 'http://localhost:9222/json/version';
const targetUrl = 'https://app.baselane.com/transactions';
const timeoutMs = Number(process.env.BASELANE_GQL_TIMEOUT_MS || 60000);
const inputPath = process.argv[2];
if (!inputPath) {
  console.error('usage: baselane_graphql_via_cdp.js <input.json>');
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
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
  }

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'Target.attachedToTarget') {
      sessions.set(msg.params.targetInfo.targetId, msg.params.sessionId);
      return;
    }
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

  // Reuse existing Baselane tab (already authenticated by login-and-wait script)
  const targets = await send('Target.getTargets', {});
  const existing = (targets.targetInfos || []).find(t => t.type === 'page' && t.url && t.url.includes('app.baselane.com') && !t.url.includes('/login'));

  let targetId, sessionId = null;
  if (existing) {
    console.error('[CDP] Reusing existing Baselane tab: ' + existing.url.substring(0, 60));
    targetId = existing.targetId;
    const attached = await send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = attached.sessionId;
  } else {
    console.error('[CDP] No existing Baselane tab — creating new one');
    const result = await send('Target.createTarget', { url: targetUrl });
    targetId = result.targetId;
    for (let i = 0; i < 200; i++) {
      sessionId = sessions.get(targetId);
      if (sessionId) break;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (!sessionId) throw new Error('no session attached');

  await send('Network.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: targetUrl }, sessionId).catch(() => {});

  const navStart = Date.now();
  while ((Date.now() - navStart) < timeoutMs) {
    const href = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId).catch(() => null);
    const current = href && href.result && href.result.value || '';
    if (String(current).startsWith('https://app.baselane.com/')) break;
    await new Promise(r => setTimeout(r, 250));
  }

  const start = Date.now();
  while (!lastAppCheck && (Date.now() - start) < timeoutMs) {
    await new Promise(r => setTimeout(r, 250));
  }
  if (!lastAppCheck) throw new Error('timed out waiting for x-firebase-appcheck');

  const expression = `
    (async () => {
      const payload = ${JSON.stringify(input)};
      const resp = await fetch('https://orchestration.baselane.com/graphql', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'accept': '*/*',
          'content-type': 'application/json',
          'x-firebase-appcheck': ${JSON.stringify(lastAppCheck)}
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
  process.exit(outer.status === 200 ? 0 : 1);
}

main().catch(err => {
  console.error(String(err && err.message || err));
  process.exit(1);
});
