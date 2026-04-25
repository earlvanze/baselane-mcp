#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const OPENCLAW_ROOT = process.env.OPENCLAW_ROOT || path.join(process.env.HOME || '', '.openclaw');
const ROOT = process.env.WORKSPACE_ROOT || path.join(OPENCLAW_ROOT, 'workspace');
const REPORTS = path.join(ROOT, 'reports');
const TRACKER = path.join(ROOT, 'Dropbox/Projects/transaction_tracker');
const OUT_PATH = path.join(TRACKER, 'ECO Systems General Ledger.csv');
const versionUrl = process.env.BASELANE_CDP_VERSION_URL || 'http://[::1]:9222/json/version';
const forceLogin = process.env.BASELANE_FORCE_LOGIN === '1';
const timeoutMs = Number(process.env.BASELANE_LOGIN_EXPORT_TIMEOUT_MS || 180000);
const maxPages = Number(process.env.BASELANE_MAX_PAGES || 200);
const pageLimit = Number(process.env.BASELANE_PAGE_LIMIT || 200);
const EXPECTED_SELECTED = Number(process.env.BASELANE_EXPECTED_SELECTED || 0);
const MIN_ROWS = Number(process.env.BASELANE_MIN_ROWS || 6000);
const MAX_ROWS = Number(process.env.BASELANE_MAX_ROWS || 25000);

const EXCLUDE_RAW = [
  '1 Coolwood Dr',
  '3880 Dover St.',
  '3880 Dover St',
  'Crypto Investments',
  'Dome',
  'EVCO Holdings',
  'Mining, Sales, Consulting, and PM',
  'Mining, Sales, Consulting, & PM',
  'NARWALL Holdings',
  'Personal',
  'Vehicles',
];

function normalizeName(v) {
  return String(v || '').trim().toLowerCase().replaceAll('&', ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const EXCLUDE_NORM = new Set(EXCLUDE_RAW.map(normalizeName));
const EXCLUDE_TOKEN_RULES = new Map([
  [normalizeName('1 Coolwood Dr'), ['1', 'coolwood']],
  [normalizeName('3880 Dover St.'), ['3880', 'dover']],
  [normalizeName('Crypto Investments'), ['crypto', 'investments']],
  [normalizeName('Dome'), ['dome']],
  [normalizeName('EVCO Holdings'), ['evco', 'holdings']],
  [normalizeName('Mining, Sales, Consulting, and PM'), ['mining', 'sales', 'consulting', 'pm']],
  [normalizeName('NARWALL Holdings'), ['narwall', 'holdings']],
  [normalizeName('Personal'), ['personal']],
  [normalizeName('Vehicles'), ['vehicles']],
]);

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
  const item = JSON.parse(execFileSync('bash', ['-c', 'bw get item ' + itemId], {encoding: 'utf8'}));
  const login = item.login || {};
  const email = String(login.username || '').trim();
  const password = String(login.password || '').trim();
  if (!email || !password) throw new Error('Bitwarden item missing username/password');
  return {email, password};
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function main() {
  fs.mkdirSync(REPORTS, {recursive: true});
  fs.mkdirSync(TRACKER, {recursive: true});
  const {email, password} = ensureCreds();
  const version = await (await fetch(versionUrl)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const sessions = new Map();
  const requestIdToHeaders = new Map();
  let lastAppCheck = null;
  let lastCookie = null;

  function send(method, params = {}, sessionId) {
    const msg = {id: ++id, method, params};
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => pending.set(id, {resolve, reject, method}));
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
      return;
    }
    if (msg.sessionId && msg.method === 'Network.requestWillBeSentExtraInfo') {
      const h = msg.params.headers || {};
      const authority = h[':authority'] || h.host || h.Host || '';
      if (String(authority).includes('orchestration.baselane.com')) {
        const appCheck = h['x-firebase-appcheck'] || h['X-Firebase-AppCheck'];
        const cookie = h.cookie || h.Cookie;
        if (appCheck) lastAppCheck = appCheck;
        if (cookie) lastCookie = cookie;
      }
    }
  };

  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
  const targets = await send('Target.getTargets', {});
  const candidate = (targets.targetInfos || []).find(t => t.type === 'page' && t.url && t.url.includes('app.baselane.com') && !t.url.includes('/login'));

  let sessionId = null;
  if (candidate) {
    const attached = await send('Target.attachToTarget', {targetId: candidate.targetId, flatten: true});
    sessionId = attached.sessionId;
  } else {
    const {targetId} = await send('Target.createTarget', {url: 'https://app.baselane.com/login'});
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
      try {
        v = await Promise.resolve(pred());
      } catch (_e) {
        v = null;
      }
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

  if (forceLogin) {
    await send('Page.navigate', {url: 'https://app.baselane.com/login'}, sessionId).catch(() => {});
  } else {
    await send('Page.navigate', {url: 'https://app.baselane.com/transactions'}, sessionId).catch(() => {});
  }
  await waitFor(() => evalExpr(`document.readyState === 'complete' || document.readyState === 'interactive'`), 'initial dom ready', 30000);

  let currentHref = await evalExpr('location.href');
  let loginResult = 'existing_authenticated_session';
  const loginInputsPresent = await evalExpr(`Boolean(document.querySelector('input[name="email"], input#email, input[type="email"], input[autocomplete="email"]')) && Boolean(document.querySelector('input[name="password"], input#password, input[type="password"], input[autocomplete="current-password"]'))`);

  if (forceLogin || String(currentHref).includes('/login') || loginInputsPresent) {
    await evalExpr(`(() => {
      const hide = s => document.querySelectorAll(s).forEach(el => { el.disabled = true; el.style.pointerEvents='none'; el.style.display='none'; });
      hide('#signInButtonAppleSSO, #signInButtonSSO, button[id*="Apple"], button[id*="SSO"], button[id*="Google"]');
      return true;
    })()`);

    const inputsOk = await waitFor(() => evalExpr(`Boolean(document.querySelector('input[name="email"], input#email, input[type="email"], input[autocomplete="email"]')) && Boolean(document.querySelector('input[name="password"], input#password, input[type="password"], input[autocomplete="current-password"]'))`), 'login inputs', 30000).catch(() => false);

    if (inputsOk) {
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

  await send('Page.navigate', {url: 'https://app.baselane.com/transactions'}, sessionId).catch(() => {});
  await waitFor(async () => {
    const href = await evalExpr('location.href');
    return String(href).includes('/transactions') ? href : false;
  }, 'transactions page', 60000);

  for (let i = 0; i < 4 && !lastAppCheck; i++) {

    await send('Page.reload', {ignoreCache: i === 0}, sessionId).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));
  }
  await waitFor(() => lastAppCheck, 'x-firebase-appcheck', 60000);
  const allCookies = await send('Network.getAllCookies', {}, sessionId);
  const cookiePairs = (allCookies.cookies || []).filter(c => String(c.domain || '').includes('baselane.com')).map(c => `${c.name}=${c.value}`);
  if (cookiePairs.length) lastCookie = cookiePairs.join('; ');
  if (!lastCookie) throw new Error('missing_cookie_after_getAllCookies');

  async function gql(operationName, query, variables = {}) {
    const payload = {operationName, variables, query};
    const outer = await evalExpr(`(async () => {
      try {
        const resp = await fetch('https://orchestration.baselane.com/graphql', {
          method: 'POST', credentials: 'include', headers: {
            'accept': '*/*',
            'content-type': 'application/json',
            'x-firebase-appcheck': ${JSON.stringify(lastAppCheck)},
            ...(${JSON.stringify(lastCookie)} ? {'cookie': ${JSON.stringify(lastCookie)}} : {})
          }, body: JSON.stringify(${JSON.stringify(payload)})
        });
        const text = await resp.text();
        return {
          ok: resp.ok,
          status: resp.status,
          statusText: resp.statusText || '',
          url: resp.url || '',
          redirected: !!resp.redirected,
          text,
          textPreview: text.slice(0, 1200),
          hasAppCheck: ${JSON.stringify(Boolean(lastAppCheck))},
          hasCookie: ${JSON.stringify(Boolean(lastCookie))},
          cookieLength: ${JSON.stringify(lastCookie ? lastCookie.length : 0)}
        };
      } catch (err) {
        return {
          fetchError: true,
          errorName: err?.name || '',
          errorMessage: err?.message || String(err),
          errorStack: err?.stack || '',
          hasAppCheck: ${JSON.stringify(Boolean(lastAppCheck))},
          hasCookie: ${JSON.stringify(Boolean(lastCookie))},
          cookieLength: ${JSON.stringify(lastCookie ? lastCookie.length : 0)}
        };
      }
    })()`);
    if (!outer || outer.fetchError || outer.status !== 200) throw new Error(`GraphQL ${operationName} failed: ` + JSON.stringify(outer));
    let parsed;
    try {
      parsed = JSON.parse(outer.text);
    } catch (err) {
      throw new Error(`GraphQL ${operationName} invalid JSON: ` + JSON.stringify({
        status: outer.status,
        statusText: outer.statusText,
        textPreview: outer.textPreview,
        parseError: err?.message || String(err)
      }));
    }
    if (parsed.errors) throw new Error(`GraphQL ${operationName} errors: ${JSON.stringify(parsed.errors)}`);
    return parsed.data || {};
  }

  const props = (await gql('PropertyList', 'query PropertyList { property { id name address } }')).property || [];
  const propMap = Object.fromEntries(props.map(p => [String(p.id), p.name || '']));
  const excludedIds = new Set();
  for (const p of props) {
    if (EXCLUDE_NORM.has(normalizeName(p.name || ''))) excludedIds.add(String(p.id));
  }
  let selectedCount = props.length - excludedIds.size;
  const autocorrectAdded = [];
  if (EXPECTED_SELECTED > 0 && selectedCount !== EXPECTED_SELECTED) {
    for (const p of props) {
      const pid = String(p.id);
      if (excludedIds.has(pid)) continue;
      const pn = normalizeName(p.name || '');
      for (const [rule, tokens] of EXCLUDE_TOKEN_RULES.entries()) {
        if (tokens.every(tok => pn.includes(tok))) {
          excludedIds.add(pid);
          autocorrectAdded.push({property_id: pid, property_name: p.name || '', matched_rule: rule, tokens});
          break;
        }
      }
    }
    selectedCount = props.length - excludedIds.size;
  }
  const selectedPropertyIds = new Set(props.filter(p => !excludedIds.has(String(p.id))).map(p => String(p.id)));

  const tags = (await gql('TagList', 'query TagList { tag { type subType { id name } } }')).tag || [];
  const tagMap = {};
  for (const t of tags) for (const st of (t.subType || [])) tagMap[String(st.id)] = [t.type || '', st.name || ''];

  const bankCache = new Map();
  async function bank(bid) {
    if (bid === null || bid === undefined) return null;
    const key = String(bid);
    if (bankCache.has(key)) return bankCache.get(key);
    const data = await gql('BankAccount', 'query BankAccount($id: ID!) { bankAccount(id: $id) { id accountName nickName accountNumber institutionName } }', {id: key});
    bankCache.set(key, data.bankAccount || null);
    return bankCache.get(key);
  }

  const txQuery = `query Transactions($input: SortsAndFilters) {
    transactions(input: $input) {
      total
      data {
        description bankAccountId amount merchantName name pending time hidden isDeleted isExternal isManual isSplit parentId isReviewedByUser tagIdSource propertyTagIdSource tagRuleId propertyRuleId originalTransaction isDocumentUploaded linkedAssetId linkedLoanId id tagId date propertyId unitId note
      }
    }
  }`;

  const fields = ['Account','Date','Merchant','Description','Amount','Type','Category','Sub-category','Property','Unit','Notes'];
  const allRows = [];
  const filteredRows = [];
  let fetchedTotal = 0;
  let droppedNoPropertyRows = 0;
  let droppedExcludedPropertyRows = 0;
  let droppedNonSelectedRows = 0;
  let droppedUnknownPropertyRows = 0;
  let unknownPropertyNameRows = 0;

  for (let page = 1; page <= maxPages; page++) {
    const data = await gql('Transactions', txQuery, {input: {sort:{field:'date', direction:'DESC'}, filter:{isHidden:false, search:'', isCategorized:null, tagId:null, bankAccountId:null, propertyId:null, unitId:null, isDeleted:false, isDocumentUploaded:null}, page, pageLimit}});
    const txs = (((data || {}).transactions) || {}).data || [];
    if (!txs.length) break;
    fetchedTotal += txs.length;
    for (const tx of txs) {
      const pid = tx.propertyId === null || tx.propertyId === undefined ? null : String(tx.propertyId);
      let prop = pid ? (propMap[pid] || '') : '';
      const tagId = tx.tagId === null || tx.tagId === undefined ? null : String(tx.tagId);
      const [ttype, tsub] = tagMap[tagId] || ['', ''];
      const ba = await bank(tx.bankAccountId);
      const account = ba ? `${ba.accountName || ''}-${ba.nickName || ''}-${ba.accountNumber || ''}` : '';
      const dateStr = tx.date ? new Date(tx.date + 'T00:00:00').toLocaleDateString('en-US', {month:'long', day:'2-digit', year:'numeric'}) : '';
      const merchant = tx.merchantName || '';
      const desc = tx.description || tx.name || merchant;
      const notes = tx.note && typeof tx.note === 'object' ? (tx.note.text || '') : (tx.note || '');
      const row = {Account: account, Date: dateStr, Merchant: merchant, Description: desc, Amount: tx.amount, Type: ttype, Category: tsub, 'Sub-category': '', Property: prop || '', Unit: '', Notes: notes};
      allRows.push(row);
      if (pid === null) { droppedNoPropertyRows++; continue; }
      if (excludedIds.has(pid) || EXCLUDE_NORM.has(normalizeName(prop))) { droppedExcludedPropertyRows++; continue; }
      if (!selectedPropertyIds.has(pid)) { droppedNonSelectedRows++; continue; }
      if (!prop) { droppedUnknownPropertyRows++; prop = `UNKNOWN_PROPERTY_${pid}`; unknownPropertyNameRows++; }
      const outRow = {...row, Property: prop};
      filteredRows.push(outRow);
    }
  }

  const uniqueProps = new Set(filteredRows.map(r => String(r.Property || '').trim()).filter(Boolean)).size;
  const blankPropertyRows = filteredRows.filter(r => !String(r.Property || '').trim()).length;
  const excludedPropertyRowsInOutput = filteredRows.filter(r => EXCLUDE_NORM.has(normalizeName(r.Property || ''))).length;
  const violations = [];
  if (filteredRows.length < MIN_ROWS) violations.push(`row_count_below_min:${filteredRows.length}<${MIN_ROWS}`);
  if (filteredRows.length > MAX_ROWS) violations.push(`row_count_above_max:${filteredRows.length}>${MAX_ROWS}`);
  if (blankPropertyRows > 0) violations.push(`blank_property_rows:${blankPropertyRows}`);
  if (excludedPropertyRowsInOutput > 0) violations.push(`excluded_property_rows_in_output:${excludedPropertyRowsInOutput}`);
  if (unknownPropertyNameRows > 0) violations.push(`unknown_property_name_rows:${unknownPropertyNameRows}`);

  const ts = new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'').replace('T','-');
  const allSnapshot = path.join(REPORTS, `baselane_export_all_transactions.${ts}.csv`);
  const filteredPreview = path.join(REPORTS, `baselane_export_filtered_preview.${ts}.csv`);
  const filteredSnapshot = path.join(TRACKER, `ECO Systems General Ledger.filtered.${ts}.csv`);
  const backupPath = path.join(TRACKER, `ECO Systems General Ledger.${ts}.bak.csv`);
  const tmpPath = path.join(TRACKER, `ECO Systems General Ledger.tmp.${ts}.csv`);
  const guardPath = path.join(REPORTS, 'baselane_export_guard_last.json');
  const loginReportPath = path.join(REPORTS, 'baselane_login_export_report.json');

  function writeCsv(outPath, rows) {
    const lines = [fields.join(',')];
    for (const row of rows) lines.push(fields.map(f => csvEscape(row[f])).join(','));
    fs.writeFileSync(outPath, lines.join('\n') + '\n');
  }

  writeCsv(allSnapshot, allRows);
  writeCsv(filteredPreview, filteredRows);

  const guardPayload = {
    ok: violations.length === 0,
    timestamp: new Date().toISOString(),
    expected_selected: EXPECTED_SELECTED > 0 ? EXPECTED_SELECTED : null,
    actual_selected: selectedCount,
    property_count_warning: EXPECTED_SELECTED > 0 && selectedCount !== EXPECTED_SELECTED ? `selected_property_count_mismatch expected=${EXPECTED_SELECTED} actual=${selectedCount}` : null,
    total_properties: props.length,
    excluded_properties_matched: excludedIds.size,
    fetched_total_rows: fetchedTotal,
    all_rows_exported_local: allRows.length,
    dropped_excluded_property_rows: droppedExcludedPropertyRows,
    dropped_no_property_rows: droppedNoPropertyRows,
    dropped_non_selected_rows: droppedNonSelectedRows,
    dropped_unknown_property_rows: droppedUnknownPropertyRows,
    output_rows: filteredRows.length,
    unique_output_properties: uniqueProps,
    blank_property_rows: blankPropertyRows,
    excluded_property_rows_in_output: excludedPropertyRowsInOutput,
    unknown_property_name_rows: unknownPropertyNameRows,
    autocorrect_added: autocorrectAdded,
    all_export_snapshot: allSnapshot,
    filtered_preview_snapshot: filteredPreview,
    filtered_snapshot: filteredSnapshot,
    canonical_path: OUT_PATH,
    violations,
  };
  fs.writeFileSync(guardPath, JSON.stringify(guardPayload, null, 2));

  if (violations.length) throw new Error('Guard failed: ' + violations.join('; '));

  writeCsv(tmpPath, filteredRows);
  writeCsv(filteredSnapshot, filteredRows);
  if (fs.existsSync(OUT_PATH)) fs.copyFileSync(OUT_PATH, backupPath);
  fs.renameSync(tmpPath, OUT_PATH);

  const loginReport = {
    ok: true,
    login_submit_mode: loginResult,
    browser: version.Browser || '',
    version_url: versionUrl,
    last_appcheck_present: Boolean(lastAppCheck),
    last_cookie_present: Boolean(lastCookie),
    canonical_path: OUT_PATH,
    all_snapshot: allSnapshot,
    filtered_preview: filteredPreview,
    filtered_snapshot: filteredSnapshot,
    backup_path: fs.existsSync(backupPath) ? backupPath : null,
    rows: filteredRows.length,
    unique_props: uniqueProps,
  };
  fs.writeFileSync(loginReportPath, JSON.stringify(loginReport, null, 2));
  console.log(JSON.stringify(loginReport, null, 2));
  // Cleanup: close any tabs opened during export (except Baselane auth)
  try {
    const pages = await (await fetch(versionUrl + "/../json")).json();
    const toClose = pages.filter(p => p.type === "page" && !p.url.includes("baselane"));
    for (const p of toClose) await fetch(versionUrl + "/../json/close/" + p.id, {method: "POST"}).catch(() => {});
    if (toClose.length) console.log(`Cleaned up ${toClose.length} tabs`);
  } catch (e) {}

  process.exit(0);
}

main().catch(err => {
  fs.mkdirSync(REPORTS, {recursive: true});
  fs.writeFileSync(path.join(REPORTS, 'baselane_login_export_report.json'), JSON.stringify({ok:false, error:String(err && err.stack || err)}, null, 2));
  console.error(err && err.stack || String(err));
  process.exit(1);
});
