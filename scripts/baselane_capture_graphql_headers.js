#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = '/home/umbrel/.openclaw/workspace';
const OUT = path.join(ROOT, 'reports', 'baselane_graphql_headers.json');
const versionUrl = process.env.BASELANE_CDP_VERSION_URL || 'http://localhost:9222/json/version';
const targetUrl = 'https://app.baselane.com/transactions';
const timeoutMs = Number(process.env.BASELANE_CAPTURE_TIMEOUT_MS || 30000);

function getJson(url) {
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

async function main() {
  const version = await getJson(versionUrl);
  const browserWs = version.webSocketDebuggerUrl;
  if (!browserWs) throw new Error(`No webSocketDebuggerUrl from ${versionUrl}`);

  const ws = new WebSocket(browserWs);
  let id = 0;
  const pending = new Map();
  const sessions = new Map();
  let done = false;

  function send(method, params = {}, sessionId) {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
  }

  function finish(payload, exitCode = 0) {
    if (done) return;
    done = true;
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
    console.log(`WROTE ${OUT}`);
    setTimeout(() => process.exit(exitCode), 50);
  }

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(msg.error);
        else p.resolve(msg.result);
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
      if (!String(authority).includes('orchestration.baselane.com')) return;
      const appCheck = h['x-firebase-appcheck'] || h['X-Firebase-AppCheck'] || '';
      if (!appCheck) return;
      const cookie = h['cookie'] || '';
      if (!cookie) return;
      const payload = {
        captured_at: new Date().toISOString(),
        source: 'raw_cdp_new_target',
        version_url: versionUrl,
        browser: version.Browser || '',
        headers: {
          'accept': h['accept'] || '*/*',
          'content-type': h['content-type'] || 'application/json',
          'origin': h['origin'] || 'https://app.baselane.com',
          'referer': h['referer'] || 'https://app.baselane.com/',
          'user-agent': h['user-agent'] || '',
          'sec-ch-ua': h['sec-ch-ua'] || '',
          'sec-ch-ua-mobile': h['sec-ch-ua-mobile'] || '',
          'sec-ch-ua-platform': h['sec-ch-ua-platform'] || '',
          'sec-fetch-site': h['sec-fetch-site'] || '',
          'sec-fetch-mode': h['sec-fetch-mode'] || '',
          'sec-fetch-dest': h['sec-fetch-dest'] || '',
          'sec-gpc': h['sec-gpc'] || '',
          'accept-language': h['accept-language'] || '',
          'accept-encoding': h['accept-encoding'] || '',
          'x-firebase-appcheck': appCheck,
          'cookie': cookie
        }
      };
      finish(payload, 0);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const created = await send('Target.createTarget', { url: targetUrl });
  const targetId = created.targetId;

  let sessionId = null;
  for (let i = 0; i < 200; i++) {
    sessionId = sessions.get(targetId);
    if (sessionId) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!sessionId) throw new Error(`No attached session for target ${targetId}`);

  await send('Network.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.reload', { ignoreCache: true }, sessionId).catch(() => {});

  setTimeout(() => finish({ ok: false, reason: 'timeout_waiting_for_graphql_headers', captured_at: new Date().toISOString() }, 2), timeoutMs);
}

main().catch(err => {
  const payload = { ok: false, reason: String(err && err.message || err), captured_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.error(err);
  process.exit(1);
});
