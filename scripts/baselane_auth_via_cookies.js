#!/usr/bin/env node
/**
 * baselane_auth_via_cookies.js
 * 
 * Anti-bot-detection strategy:
 * 1. Rely on existing authenticated cookies in Brave's profile (never re-login via script if already authenticated)
 * 2. Use CDP Page.navigate() only - no synthetic mouse/keyboard events
 * 3. Check authentication status via page content, not URL redirects
 * 4. If not authenticated, STOP and report - require Earl to log in manually once
 * 5. Store cookie validity state to avoid repeated auth checks
 */

const fs = require('fs');
const path = require('path');

const OPENCLAW_ROOT = process.env.OPENCLAW_ROOT || path.join(process.env.HOME || '', '.openclaw');
const ROOT = process.env.WORKSPACE_ROOT || path.join(OPENCLAW_ROOT, 'workspace');
const REPORTS = path.join(ROOT, 'reports');
const STATE_FILE = path.join(ROOT, 'scripts', '.baselane_auth_state.json');
const versionUrl = process.env.BASELANE_CDP_VERSION_URL || 'http://127.0.0.1:9222/json/version';
const targetUrl = process.env.BASELANE_TARGET_URL || 'https://app.baselane.com/transactions';
const waitMs = Number(process.env.BASELANE_WAIT_MS || 900000);
const reportPath = path.join(REPORTS, 'baselane_auth_report.json');

// State persistence for cookie validity
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return { lastAuthCheck: 0, authenticated: false }; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  fs.mkdirSync(REPORTS, { recursive: true });
  const state = loadState();
  
  // Connect to browser via CDP
  const version = await (await fetch(versionUrl)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const sessions = new Map();

  function send(method, params = {}, sessionId) {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'Target.attachedToTarget') {
      sessions.set(msg.params.targetInfo.targetId, msg.params.sessionId);
    }
  };

  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  
  // Find or create Baselane tab
  const targets = await send('Target.getTargets', {});
  
  // Close duplicate Baselane tabs
  const baselanePages = (targets.targetInfos || []).filter(t => 
    t.type === 'page' && t.url && t.url.includes('baselane.com')
  );
  if (baselanePages.length > 1) {
    console.log(`[CDP] Found ${baselanePages.length} Baselane tabs — closing ${baselanePages.length - 1} duplicates`);
    for (let i = 1; i < baselanePages.length; i++) {
      try { await send('Target.closeTarget', { targetId: baselanePages[i].targetId }); } catch (e) {}
    }
  }

  let sessionId = null;
  const candidate = baselanePages[0];
  
  if (candidate) {
    console.log('[CDP] Reusing existing Baselane tab:', candidate.url.substring(0, 60));
    const attached = await send('Target.attachToTarget', { targetId: candidate.targetId, flatten: true });
    sessionId = attached.sessionId;
  } else {
    console.log('[CDP] No existing Baselane tab — creating one');
    const { targetId } = await send('Target.createTarget', { url: targetUrl });
    for (let i = 0; i < 300; i++) {
      sessionId = sessions.get(targetId);
      if (sessionId) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!sessionId) throw new Error('no session attached');
  }

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  async function evalExpr(expression, awaitPromise = true) {
    const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
    return res.result ? res.result.value : undefined;
  }

  // Navigate directly (no synthetic events)
  console.log('[CDP] Navigating to:', targetUrl);
  await send('Page.navigate', { url: targetUrl }, sessionId);
  
  // Wait for page load
  await new Promise(r => setTimeout(r, 5000));
  
  // Check authentication status by inspecting page content
  const currentUrl = await evalExpr('location.href');
  const pageTitle = await evalExpr('document.title');
  const bodyText = await evalExpr(`(document.body?.innerText || '').slice(0, 2000)`);
  
  const isLoginPage = String(currentUrl).includes('/login') || 
                      bodyText.includes('Sign in') || 
                      bodyText.includes('Log in') ||
                      bodyText.includes('email') && bodyText.includes('password');
  
  const isMaintenancePage = bodyText.includes('maintenance') || 
                            bodyText.includes('temporarily unavailable') ||
                            bodyText.includes('be right back');
  
  const isAuthenticated = !isLoginPage && 
                          !isMaintenancePage && 
                          String(currentUrl).startsWith('https://app.baselane.com/') &&
                          (bodyText.includes('Transactions') || 
                           bodyText.includes('Dashboard') || 
                           bodyText.includes('Properties') ||
                           bodyText.includes('Banking'));

  if (isMaintenancePage) {
    const report = {
      ok: false,
      error: 'MAINTENANCE_PAGE',
      note: 'Baselane is showing a maintenance page. This is their bot detection. Wait 30+ min and try again, or have Earl log in manually.',
      url: currentUrl,
      title: pageTitle,
      body_excerpt: bodyText.slice(0, 500),
      checked_at: new Date().toISOString()
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.error('[CDP] MAINTENANCE/BOT-DETECTION PAGE DETECTED');
    console.error(JSON.stringify(report, null, 2));
    ws.close();
    process.exit(1);
  }

  if (isLoginPage || !isAuthenticated) {
    state.authenticated = false;
    state.lastAuthCheck = Date.now();
    saveState(state);
    
    const report = {
      ok: false,
      error: 'AUTH_REQUIRED',
      note: 'Baselane session expired. Earl must log in manually via browser once to refresh cookies. No automated login attempted (to avoid bot detection).',
      url: currentUrl,
      title: pageTitle,
      body_excerpt: bodyText.slice(0, 500),
      checked_at: new Date().toISOString()
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.error('[CDP] NOT AUTHENTICATED - Manual login required');
    console.error(JSON.stringify(report, null, 2));
    ws.close();
    process.exit(1);
  }

  // We're authenticated!
  state.authenticated = true;
  state.lastAuthCheck = Date.now();
  saveState(state);

  const report = {
    ok: true,
    status: 'AUTHENTICATED',
    url: currentUrl,
    title: pageTitle,
    waited_ms: waitMs,
    checked_at: new Date().toISOString(),
    note: 'Session authenticated via existing cookies. Ready for automation.',
    body_excerpt: bodyText.slice(0, 500)
  };
  
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log('[CDP] AUTHENTICATED');
  console.log(JSON.stringify(report, null, 2));

  // Keep session open for automation tasks
  console.log(`[CDP] Holding session open for ${waitMs / 1000}s...`);
  await new Promise(r => setTimeout(r, waitMs));
  
  ws.close();
}

main().catch(err => {
  fs.mkdirSync(REPORTS, { recursive: true });
  const report = { ok: false, error: String(err?.stack || err), checked_at: new Date().toISOString() };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.error(report.error);
  process.exit(1);
});
