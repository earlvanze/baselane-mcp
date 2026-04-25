#!/usr/bin/env node
/**
 * Baselane login + export in one shot.
 * Uses chrome-remote-interface against ::1:9222 (IPv6 localhost).
 */
const CDP = require('./node_modules/chrome-remote-interface');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.env.WORKSPACE_ROOT || path.join(process.env.HOME || '', '.openclaw', 'workspace');
const REPORTS = path.join(ROOT, 'reports');
const TRACKER = path.join(ROOT, 'Dropbox/Projects/transaction_tracker');
const OUT_PATH = path.join(TRACKER, 'ECO Systems General Ledger.csv');

const versionUrl = process.env.BASELANE_CDP_VERSION_URL || 'http://[::1]:9222/json/version';
const timeoutMs = Number(process.env.BASELANE_LOGIN_WAIT_TIMEOUT_MS || 180000);
const maxPages = Number(process.env.BASELANE_MAX_PAGES || 200);

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
  const merged = { ...process.env, ...parseEnvFile(envFile) };
  const session = String(merged.BW_SESSION || '').trim();
  const itemId = String(merged.BASELANE_ITEM_ID || '').trim();
  if (!itemId) throw new Error('Missing BASELANE_ITEM_ID');
  const creds = JSON.parse(execFileSync('bash', ['-c', `export BW_SESSION="${session}"; bw get item ${itemId}`], { encoding: 'utf8' }));
  const login = creds.login || {};
  const email = String(login.username || '').trim();
  const password = String(login.password || '').trim();
  if (!email || !password) throw new Error('Baselane Bitwarden item missing credentials');
  return { email, password };
}

const EXCLUDE_RAW = [
  '1 Coolwood Dr', '3880 Dover St.', '3880 Dover St', 'Crypto Investments',
  'Dome', 'EVCO Holdings', 'Mining, Sales, Consulting, and PM',
  'Mining, Sales, Consulting, & PM', 'NARWALL Holdings', 'Personal', 'Vehicles',
];
function normalizeName(v) {
  return String(v || '').trim().toLowerCase().replaceAll('&', ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const EXCLUDE_NORM = new Set(EXCLUDE_RAW.map(normalizeName));

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function waitFor(client, pred, label, ms = 60000) {
  const { Runtime } = client;
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const v = await Promise.resolve(pred());
      if (v) return v;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  fs.mkdirSync(REPORTS, { recursive: true });
  fs.mkdirSync(TRACKER, { recursive: true });

  const { email, password } = ensureCreds();
  console.log('[1/5] Credentials loaded');

  // Connect
  const client = await CDP({ host: '::1', port: 9222 });
  const { Target, Page, Runtime, Network, Input } = client;
  await Network.enable();
  await Runtime.enable();
  await Page.enable();

  // Close stale login tabs and open fresh login page
  let targets = await Target.getTargets();
  for (const t of targets.targetInfos) {
    if (t.url && t.url.includes('app.baselane.com/login')) {
      console.log('[2/5] Closing stale login tab:', t.targetId);
      await Target.closeTarget({ targetId: t.targetId });
    }
  }

  const newTab = await Target.createTarget({ url: 'https://app.baselane.com/login' });
  console.log('[2/5] Opened new login tab:', newTab.targetId);

  // Attach to the new tab
  const { sessionId } = await Target.attachToTarget({ targetId: newTab.targetId, flatten: true });
  await Network.enable();
  await Runtime.enable();
  await Page.enable();

  // Wait for login page to fully load
  await waitFor(client, async () => {
    const r = await Runtime.evaluate({ expression: 'document.readyState', returnByValue: true, contextId: null });
    return r.result && r.result.value === 'complete';
  }, 'page ready', 30000);
  await new Promise(r => setTimeout(r, 2000)); // extra settle time

  // Check if already logged in
  let href = await Runtime.evaluate({ expression: 'location.href', returnByValue: true, contextId: null });
  if (!String(href.result.value || '').includes('/login')) {
    console.log('[3/5] Already logged in, on:', href.result.value);
  } else {
    console.log('[3/5] On login page, entering credentials...');

    // Click email field and type
    const emailField = await Runtime.evaluate({
      expression: `(() => { const el = document.querySelector('input[name="email"], input#email, input[type="email"]'); if (!el) return null; const r = el.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`,
      returnByValue: true, contextId: null
    });
    if (!emailField.result) throw new Error('Email field not found');
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: emailField.result.value.x, y: emailField.result.value.y, button: 'left', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: emailField.result.value.x, y: emailField.result.value.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 500));
    await Input.insertText({ text: email });
    await new Promise(r => setTimeout(r, 500));

    // Click password field and type
    const pwField = await Runtime.evaluate({
      expression: `(() => { const el = document.querySelector('input[name="password"], input#password, input[type="password"]'); if (!el) return null; const r = el.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`,
      returnByValue: true, contextId: null
    });
    if (!pwField.result) throw new Error('Password field not found');
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: pwField.result.value.x, y: pwField.result.value.y, button: 'left', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: pwField.result.value.x, y: pwField.result.value.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 500));
    await Input.insertText({ text: password });
    await new Promise(r => setTimeout(r, 1000));

    // Click sign-in button
    const signInBtn = await Runtime.evaluate({
      expression: `(() => { const el = document.querySelector('#signInButton, button[type="submit"]'); if (!el) return null; const r = el.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`,
      returnByValue: true, contextId: null
    });
    if (!signInBtn.result) throw new Error('Sign-in button not found');
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: signInBtn.result.value.x, y: signInBtn.result.value.y, button: 'left', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: signInBtn.result.value.x, y: signInBtn.result.value.y, button: 'left', clickCount: 1 });
    console.log('[3/5] Sign-in clicked, waiting for redirect...');

    // Wait for redirect away from /login
    await waitFor(client, async () => {
      const r = await Runtime.evaluate({ expression: 'location.href', returnByValue: true, contextId: null });
      const h = String(r.result.value || '');
      return !h.includes('/login');
    }, 'post-login redirect', 90000);

    await new Promise(r => setTimeout(r, 3000));
    href = await Runtime.evaluate({ expression: 'location.href', returnByValue: true, contextId: null });
    console.log('[3/5] Logged in, now at:', href.result.value);
  }

  // ── EXPORT ──────────────────────────────────────────────────────────────────
  console.log('[4/5] Navigating to transactions...');
  await Page.navigate({ url: 'https://app.baselane.com/transactions' });
  await waitFor(client, async () => {
    const r = await Runtime.evaluate({ expression: 'document.readyState', returnByValue: true, contextId: null });
    return r.result && r.result.value === 'complete';
  }, 'transactions page ready', 30000);
  await new Promise(r => setTimeout(r, 3000));

  // Capture appcheck header from network requests
  let appCheckToken = null;
  const origSend = client._ws ? client._ws.send : null;
  const headersPromise = new Promise((resolve) => {
    const timeout = setTimeout(resolve, 15000);
    const check = (params) => {
      const h = params.headers || {};
      const host = h[':authority'] || h['host'] || '';
      if (String(host).includes('baselane.com') || String(host).includes('orchestration.baselane')) {
        const v = h['x-firebase-appcheck'] || h['X-Firebase-AppCheck'];
        if (v) { appCheckToken = v; clearTimeout(timeout); Network.off('requestWillBeSentExtraInfo', check); resolve(v); }
      }
    };
    Network.on('requestWillBeSentExtraInfo', check);
    // Also trigger a scroll to force requests
    Runtime.evaluate({ expression: 'window.scrollBy(0, 200)', returnByValue: false, contextId: null });
  });

  // Wait for data to load
  await waitFor(client, async () => {
    const r = await Runtime.evaluate({
      expression: `(() => {
        // Check for transaction rows
        const rows = document.querySelectorAll('[class*="transaction"], [class*="row"], tbody tr');
        return rows.length > 0 ? rows.length : 0;
      })()`,
      returnByValue: true, contextId: null
    });
    return Number(r.result && r.result.value) > 0;
  }, 'transaction rows', 30000);
  await new Promise(r => setTimeout(r, 2000));

  // Trigger a few scrolls to get all data loading
  for (let i = 0; i < 5; i++) {
    await Runtime.evaluate({ expression: 'window.scrollBy(0, 500)', returnByValue: false, contextId: null });
    await new Promise(r => setTimeout(r, 800));
  }

  // Wait for appcheck token (15s max)
  await headersPromise;
  if (!appCheckToken) {
    console.log('[WARN] No appcheck token captured — proceeding anyway');
  } else {
    console.log('[4/5] AppCheck token captured');
  }

  // Now do GraphQL exports — find the GraphQL endpoint
  console.log('[4/5] Starting GraphQL export...');

  const rows = [];
  let pageNum = 0;
  let hasMore = true;

  // Capture GraphQL responses
  const gqlResponses = [];
  Network.on('responseReceived', (params) => {
    const url = params.response && params.response.url || '';
    if (url.includes('graphql') || url.includes('baselane.com/api')) {
      gqlResponses.push(params);
    }
  });

  // Human-paced scroll + page down to trigger lazy load
  const lastHeight = await Runtime.evaluate({ expression: 'document.body.scrollHeight', returnByValue: true, contextId: null });

  while (hasMore && pageNum < maxPages) {
    pageNum++;
    await Runtime.evaluate({ expression: 'window.scrollTo(0, document.body.scrollHeight)', returnByValue: false, contextId: null });
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));

    const newHeight = await Runtime.evaluate({ expression: 'document.body.scrollHeight', returnByValue: true, contextId: null });
    if (newHeight.result.value === lastHeight.result.value) {
      hasMore = false;
    }
    console.log(`[4/5] Scrolled page ${pageNum}, height: ${newHeight.result.value}`);
  }

  // Extract transactions from DOM
  const txData = await Runtime.evaluate({
    expression: `(() => {
      const results = [];
      // Try various selectors
      let items = document.querySelectorAll('[class*="TransactionItem"], [class*="transaction-item"], [class*="TransactionRow"], [class*="transaction-row"]');
      if (items.length === 0) items = document.querySelectorAll('table tbody tr, [role="row"]');
      if (items.length === 0) {
        // Fallback: look for any list with dates/amounts
        const allRows = document.querySelectorAll('div[class*="row"], div[class*="item"], div[class*="entry"]');
        for (const row of allRows) {
          const text = row.innerText || '';
          if (/\\$[\\d,]+\\.\\d{2}/.test(text) && /\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}/.test(text)) {
            results.push({html: row.innerHTML, text: text.substring(0, 500)});
          }
        }
        return results;
      }
      for (const row of items) {
        const text = row.innerText || '';
        const html = row.innerHTML || '';
        results.push({html, text: text.substring(0, 500)});
      }
      return results;
    })()`,
    returnByValue: true, contextId: null
  });

  console.log(`[4/5] Extracted ${txData.result.value.length} transaction elements`);

  // Parse transactions
  const parsed = [];
  for (const item of (txData.result.value || [])) {
    const text = item.text || '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    let date = '', description = '', amount = '', category = '', account = '';
    for (const line of lines) {
      if (/^\$?[\d,]+\.\d{2}$/.test(line.replace(/\$/g, ''))) amount = line.replace(/\$/g, '');
      else if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(line)) date = line;
      else if (!date) date = line;
      else if (!description) description = line;
      else if (!category) category = line;
      else if (!account) account = line;
    }
    if (!amount) continue;

    const normAccount = normalizeName(account);
    if (EXCLUDE_NORM.has(normAccount)) continue;

    parsed.push({
      Date: date,
      Description: description || account,
      Amount: amount,
      Category: category,
      Account: account
    });
  }

  console.log(`[4/5] Parsed ${parsed.length} transactions (after exclusions)`);

  // Write CSV
  const header = 'Date,Description,Amount,Category,Account\n';
  const csvRows = parsed.map(r =>
    [csvEscape(r.Date), csvEscape(r.Description), csvEscape(r.Amount), csvEscape(r.Category), csvEscape(r.Account)].join(',')
  );
  const csv = header + csvRows.join('\n') + '\n';
  fs.writeFileSync(OUT_PATH, csv);
  console.log(`[5/5] Wrote ${parsed.length} rows to ${OUT_PATH}`);

  // Report
  const report = {
    ok: true,
    timestamp: new Date().toISOString(),
    pages_scrolled: pageNum,
    rows_extracted: txData.result.value.length,
    rows_parsed: parsed.length,
    output_file: OUT_PATH,
    appcheck_captured: Boolean(appCheckToken)
  };
  fs.writeFileSync(path.join(REPORTS, 'baselane_human_paced_sync_report.json'), JSON.stringify(report, null, 2));
  console.log('[OK] Sync complete:', JSON.stringify(report));

  client.close();
}

main().catch(e => {
  console.error('[ERROR]', e.message);
  process.exit(1);
});
