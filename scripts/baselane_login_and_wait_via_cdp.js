#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const OPENCLAW_ROOT = process.env.OPENCLAW_ROOT || path.join(process.env.HOME || '', '.openclaw');
const ROOT = process.env.WORKSPACE_ROOT || path.join(OPENCLAW_ROOT, 'workspace');
const REPORTS = path.join(ROOT, 'reports');
const versionUrl = process.env.BASELANE_CDP_VERSION_URL || 'http://127.0.0.1:9222/json/version';
const targetUrl = process.env.BASELANE_LOGIN_WAIT_URL || 'https://app.baselane.com/transactions';
const forceLogin = process.env.BASELANE_FORCE_LOGIN === '1';
const timeoutMs = Number(process.env.BASELANE_LOGIN_WAIT_TIMEOUT_MS || 180000);
const waitMs = Number(process.env.BASELANE_LOGIN_WAIT_MS || 900000);
const reportPath = path.join(REPORTS, 'baselane_login_wait_report.json');

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function ensureCreds() {
  const envFile = path.join(ROOT, '.secrets', 'bw.env');
  // execFileSync(path.join(ROOT, 'scripts', 'bw_ensure_session.sh'), {env: {...process.env, BW_ENV: envFile}, stdio: ['ignore','pipe','pipe']});
  const merged = {...process.env, ...parseEnvFile(envFile)};
  const session = String(merged.BW_SESSION || '').trim();
  const itemId = String(merged.BASELANE_ITEM_ID || '').trim();
  if (!itemId) throw new Error('Missing BASELANE_ITEM_ID');
  const item = JSON.parse(execFileSync('bash', ['-c', 'BW_SESSION=' + session + ' bw get item ' + itemId], {encoding: 'utf8', env: {...process.env, BW_SESSION: session}}));
  const login = item.login || {};
  const email = String(login.username || '').trim();
  const password = String(login.password || '').trim();
  if (!email || !password) throw new Error('Bitwarden item missing username/password');
  return {email, password};
}

console.log("[baselane-cdp] VERSION_URL=", typeof VERSION_URL !== "undefined" ? VERSION_URL : "n/a");

async function main() {
  fs.mkdirSync(REPORTS, {recursive: true});
  const {email, password} = ensureCreds();
  const version = await (await fetch(versionUrl)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const sessions = new Map();

  function send(method, params = {}, sessionId) {
    const msg = {id: ++id, method, params};
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
  }

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'Target.attachedToTarget') {
      sessions.set(msg.params.targetInfo.targetId, msg.params.sessionId);
    }
  };

  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
  const targets = await send('Target.getTargets', {});
  // Close duplicate Baselane tabs to prevent tab buildup from cron retries
  const baselanePages = (targets.targetInfos || []).filter(t => t.type === 'page' && t.url && t.url.includes('app.baselane.com'));
  if (baselanePages.length > 1) {
    console.log(`[CDP] Found ${baselanePages.length} Baselane tabs — closing ${baselanePages.length - 1} duplicates`);
    for (let i = 1; i < baselanePages.length; i++) {
      try { await send('Target.closeTarget', {targetId: baselanePages[i].targetId}); } catch(e) {}
    }
  }
  // Reuse ANY existing Baselane tab (including login pages) — never create duplicates
  const candidate = (targets.targetInfos || []).find(t => t.type === 'page' && t.url && t.url.includes('app.baselane.com'));

  let sessionId = null;
  if (candidate) {
    console.log('[CDP] Reusing existing Baselane tab:', candidate.url.substring(0, 60));
    const attached = await send('Target.attachToTarget', {targetId: candidate.targetId, flatten: true});
    sessionId = attached.sessionId;
    // If it's a login page, navigate to the target URL
    if (candidate.url.includes('/login')) {
      console.log('[CDP] Tab is on login page — navigating to', targetUrl);
      await send('Page.navigate', {url: targetUrl}, sessionId);
      await new Promise(r => setTimeout(r, 3000));
    }
  } else {
    console.log('[CDP] No existing Baselane tab — creating one');
    const {targetId} = await send('Target.createTarget', {url: targetUrl});
    for (let i = 0; i < 300; i++) {
      sessionId = sessions.get(targetId);
      if (sessionId) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!sessionId) throw new Error('no session attached');
  }

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);

  async function evalExpr(expression, awaitPromise = true) {
    const res = await send('Runtime.evaluate', {expression, awaitPromise, returnByValue: true}, sessionId);
    return res.result ? res.result.value : undefined;
  }

  async function waitFor(pred, label, ms = timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      let v = null;
      try { v = await Promise.resolve(pred()); } catch (_e) { v = null; }
      if (v) return v;
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  async function getRect(selector) {
    return await evalExpr(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {x:r.left + r.width/2, y:r.top + r.height/2, width:r.width, height:r.height};
    })()`);
  }

  async function clickAt(x, y) {
    await send('Input.dispatchMouseEvent', {type:'mouseMoved', x, y, button:'none', buttons:1}, sessionId);
    await send('Input.dispatchMouseEvent', {type:'mousePressed', x, y, button:'left', buttons:1, clickCount:1}, sessionId);
    await send('Input.dispatchMouseEvent', {type:'mouseReleased', x, y, button:'left', buttons:0, clickCount:1}, sessionId);
  }

  async function clearAndType(selector, text) {
    const rect = await getRect(selector);
    if (!rect) throw new Error(`missing rect for ${selector}`);
    await clickAt(rect.x, rect.y);
    await evalExpr(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) { el.focus(); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } return true; })()`);
    await send('Input.insertText', {text}, sessionId);
  }

  await send('Page.navigate', {url: targetUrl}, sessionId).catch(() => {});
  await waitFor(() => evalExpr(`document.readyState === 'complete' || document.readyState === 'interactive'`), 'initial dom ready', 30000);

  let currentHref = await evalExpr('location.href');
  const loginInputsPresent = await evalExpr(`Boolean(document.querySelector('input[name="email"], input#email, input[type="email"], input[autocomplete="email"]')) && Boolean(document.querySelector('input[name="password"], input#password, input[type="password"], input[autocomplete="current-password"]'))`);
  let loginResult = 'existing_authenticated_session';
    if (forceLogin || String(currentHref).includes('/login') || loginInputsPresent) {
    await evalExpr(`(() => {
      const hide = s => document.querySelectorAll(s).forEach(el => { el.disabled = true; el.style.pointerEvents='none'; el.style.display='none'; });
      hide('#signInButtonAppleSSO, #signInButtonSSO, button[id*="Apple"], button[id*="SSO"], button[id*="Google"]');
      return true;
    })()`);

    const inputsOk = await waitFor(() => evalExpr(`Boolean(document.querySelector('input[name="email"], input#email, input[type="email"], input[autocomplete="email"]')) && Boolean(document.querySelector('input[name="password"], input#password, input[type="password"], input[autocomplete="current-password"]'))`), 'login inputs', 30000).catch(()=>false);
    if (!inputsOk) {
      // assume already authenticated or redirected; skip login
    } else {
    await clearAndType('input[name="email"], input#email, input[type="email"], input[autocomplete="email"]', email);
    await clearAndType('input[name="password"], input#password, input[type="password"], input[autocomplete="current-password"]', password);
    const signInRect = await getRect('#signInButton, button[type="submit"]');
    if (!signInRect) throw new Error('missing sign in button');
    await clickAt(signInRect.x, signInRect.y);
    loginResult = 'real_click_and_insertText';

    await waitFor(async () => {
      const href = await evalExpr('location.href');
      if (!href) return false;
      return !String(href).includes('/login') && String(href).startsWith('https://app.baselane.com/') ? href : false;
    }, 'post-login navigation', 90000);
    }
  }

  await send('Page.navigate', {url: targetUrl}, sessionId).catch(() => {});
  await waitFor(async () => {
    const href = await evalExpr('location.href');
    return String(href).startsWith('https://app.baselane.com/') && !String(href).includes('/login') ? href : false;
  }, 'target page', 60000);

  const finalUrl = await evalExpr('location.href');
  const title = await evalExpr('document.title');
  const bodyText = await evalExpr(`(document.body && document.body.innerText ? document.body.innerText.slice(0, 1000) : '')`);

  const report = {
    ok: true,
    login_result: loginResult,
    targetUrl: targetUrl,
    final_url: finalUrl,
    title,
    waited_ms: waitMs,
    checked_at: new Date().toISOString(),
    note: 'Logged in (if needed) and held authenticated Baselane UI target open for model-execution tasks.',
    body_excerpt: bodyText,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  await new Promise(r => setTimeout(r, waitMs));
  ws.close();
}

main().catch(err => {
  fs.mkdirSync(REPORTS, {recursive: true});
  const report = {ok:false, error:String(err && err.stack || err), checked_at:new Date().toISOString(), targetUrl};
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.error(report.error || String(err));
  process.exit(1);
});
