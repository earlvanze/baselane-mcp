#!/usr/bin/env node
/**
 * Single-shot Baselane split executor.
 * Re-auths, captures appcheck, fires createOrUpdateSplitTx mutation.
 * Usage: node baselane_do_split.js <parentTxnId> <splitsJson>
 * 
 * splitsJson: JSON array of {amount, tagId, propertyId, merchantName, date}
 * Example: '[{"amount":-138.37,"tagId":"20","propertyId":31525,"merchantName":"P+I","date":"2026-01-07"}]'
 */
const FS = require('fs');
const PATH = require('path');

const VERSION_URL = 'http://127.0.0.1:9222/json/version';
const GRAPHQL_URL = 'https://orchestration.baselane.com/graphql';

const parentTxnId = process.argv[2];
const splitsRaw = process.argv[3] || '[]';
const splits = JSON.parse(splitsRaw);

if (!parentTxnId) {
  console.error('Usage: node baselane_do_split.js <parentTxnId> <splitsJson>');
  console.error('Example: node baselane_do_split.js 251858224 \'[{"amount":-138.37,"tagId":"20","propertyId":31525,"merchantName":"P","date":"2026-03-10"}]\'');
  process.exit(1);
}
if (!splits.length) {
  console.error('No splits provided');
  process.exit(1);
}

async function main() {
  const version = await (await fetch(VERSION_URL)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); } }
  };

  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  function send(method, params = {}, sessionId) {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { pending.delete(id); rej(new Error(`timeout: ${method}`)); }, 45000);
      pending.set(id, { resolve: v => { clearTimeout(t); res(v); }, reject: e => { clearTimeout(t); rej(e); } });
    });
  }

  // 1. Find Baselane tab
  const targets = await send('Target.getTargets');
  const tab = targets.targetInfos.find(t => t.type === 'page' && t.url.includes('app.baselane.com'));
  if (!tab) throw new Error('No Baselane tab found');

  const attached = await send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);

  // 2. Capture appcheck token from network traffic
  let appCheckToken = null;
  const origOnMsg = ws.onmessage;
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); } return; }
    // Capture appcheck from ExtraInfo
    if (msg.method === 'Network.requestWillBeSentExtraInfo') {
      const headers = msg.params.headers || {};
      const host = headers[':authority'] || headers['host'] || '';
      if (host.includes('orchestration.baselane.com')) {
        const v = headers['x-firebase-appcheck'] || headers['X-Firebase-AppCheck'];
        if (v) { appCheckToken = v; }
      }
    }
  };

  // 3. Trigger network traffic to capture appcheck
  console.error('[1] Capturing appcheck token...');
  await send('Runtime.evaluate', {
    expression: `fetch('${GRAPHQL_URL}', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({query:'{ __typename }'})}).catch(()=>{})`,
    awaitPromise: false
  }, sessionId);

  // Wait up to 20s for token
  for (let i = 0; i < 40 && !appCheckToken; i++) {
    await new Promise(r => setTimeout(r, 500));
  }
  if (!appCheckToken) throw new Error('Could not capture appcheck token');
  console.error(`[2] Got token: ${appCheckToken.substring(0, 15)}...`);

  // 4. Build and execute the mutation
  const mutation = `mutation createOrUpdateSplitTx($parentTransactionId: ID!, $splitType: SplitType!, $transactionSplitInputs: [TransactionSplitInput!]!) {
    createOrUpdateSplitTx(
      input: {parentTransactionId: $parentTransactionId, transactionSplitInputs: $transactionSplitInputs, splitType: $splitType}
    ) {
      id
      splitTransactions {
        id
        tagId
        amount
        merchantName
        date
      }
    }
  }`;

  const variables = {
    parentTransactionId: String(parentTxnId),
    splitType: 'AMOUNT',
    transactionSplitInputs: splits.map(s => ({
      tagId: String(s.tagId),
      propertyId: String(s.propertyId),
      date: String(s.date),
      amount: parseFloat(s.amount),
      merchantName: String(s.merchantName),
      propertyUnitId: null
    }))
  };

  console.error(`[3] Executing split on txn ${parentTxnId} with ${splits.length} components...`);
  
  // 5. Execute mutation via fetch inside page context
  const gqlScript = `
    (async () => {
      const resp = await fetch('${GRAPHQL_URL}', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-firebase-appcheck': '${appCheckToken}'
        },
        body: JSON.stringify(${JSON.stringify({query: mutation, variables})})
      });
      return await resp.text();
    })()
  `;

  const gqlResult = await send('Runtime.evaluate', {
    expression: gqlScript,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);

  const gqlText = gqlResult.result?.value || gqlResult.result;
  console.error(`[4] Response: ${gqlText.substring(0, 500)}`);

  ws.close();

  // Parse and report
  try {
    const parsed = JSON.parse(gqlText);
    if (parsed.data?.createOrUpdateSplitTx) {
      const result = parsed.data.createOrUpdateSplitTx;
      console.log(JSON.stringify({
        success: true,
        parentId: result.id,
        children: result.splitTransactions.map(t => ({
          id: t.id,
          tagId: t.tagId,
          amount: t.amount,
          merchantName: t.merchantName
        }))
      }, null, 2));
    } else if (parsed.errors) {
      console.error('GraphQL Errors:', JSON.stringify(parsed.errors, null, 2));
      process.exit(1);
    }
  } catch(e) {
    console.error('Parse error:', e.message, gqlText.substring(0, 200));
    process.exit(1);
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
