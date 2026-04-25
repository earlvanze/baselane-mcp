#!/usr/bin/env python3
"""
Baselane mortgage split executor.
Uses createOrUpdateSplitTx mutation discovered from HAR traffic.
Requires: node, running Baselane tab at CDP port 9222
"""
import json, subprocess, sys, time
from pathlib import Path

CDP_URL = 'http://127.0.0.1:9222'
GRAPHQL_URL = 'https://orchestration.baselane.com/graphql'

# Property IDs
PROP_IDS = {
    '90 Madison': 31525,
    '86 Madison': 63162,
    '724 3rd': 33594,
    'Mining PM': 37648,
}

TAG_IDS = {
    'principal': '20',
    'interest': '11',
    'escrow': '130',
    'taxes': '95',
    'insurance': '65',
    'water': '104',
}

def cdp_eval(script):
    """Execute JS in Baselane tab via CDP, return result."""
    node_script = f'''
const http = require('http');

async function main() {{
    const version = await (await fetch('{CDP_URL}/json/version')).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    
    ws.onmessage = ev => {{
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {{
            const {{resolve, reject}} = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(msg.error); else resolve(msg.result);
        }}
    }};
    
    await new Promise((res, rej) => {{ ws.onopen = res; ws.onerror = rej; }});
    
    // Find Baselane tab
    const targets = await new Promise(res => {{
        ws.send(JSON.stringify({{id: ++id, method: 'Target.getTargets'}}));
        ws.onmessage = ev => {{
            const msg = JSON.parse(ev.data);
            if (msg.id) {{ pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }}
        }};
    }});
    
    const tab = targets.targetInfos.find(t => t.type === 'page' && t.url.includes('app.baselane.com'));
    if (!tab) {{ console.error('NO_TAB'); process.exit(1); }}
    
    const attached = await new Promise(res => {{
        ws.send(JSON.stringify({{id: ++id, method: 'Target.attachToTarget', params: {{targetId: tab.targetId, flatten: true}}}}));
        ws.onmessage = ev => {{
            const msg = JSON.parse(ev.data);
            if (msg.id) {{ pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }}
        }};
    }});
    const sessionId = attached.sessionId;
    
    // Enable Runtime
    await new Promise(res => {{
        ws.send(JSON.stringify({{id: ++id, method: 'Runtime.enable', sessionId}}));
        ws.onmessage = ev => {{
            const msg = JSON.parse(ev.data);
            if (msg.id) {{ pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }}
        }};
    }});
    
    // Evaluate
    const result = await new Promise((res, rej) => {{
        ws.send(JSON.stringify({{id: ++id, method: 'Runtime.evaluate', params: {{expression: `{script}`, awaitPromise: true, returnByValue: true}}, sessionId}}));
        ws.onmessage = ev => {{
            const msg = JSON.parse(ev.data);
            if (msg.id) {{ pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }}
        }};
    }});
    
    ws.close();
    console.log(JSON.stringify(result.result ? result.result.value : null));
}}

main().catch(e => {{ console.error('ERROR:', e.message); process.exit(1); }});
'''
    
    try:
        result = subprocess.run(
            ['node', '-e', node_script],
            capture_output=True, text=True, timeout=30
        )
        if result.stderr:
            for line in result.stderr.strip().split('\n'):
                if not line.startswith('(node:') and 'WARNING' not in line:
                    print(f"  [CDP] {line}", file=sys.stderr)
        output = result.stdout.strip()
        if output.startswith('ERROR:'):
            print(f"  [CDP ERROR] {output}", file=sys.stderr)
            return None
        try:
            return json.loads(output)
        except:
            return output
    except Exception as e:
        print(f"  [CDP EXEC ERROR] {e}", file=sys.stderr)
        return None

def get_appcheck_token():
    """Get fresh appcheck token from live Baselane tab."""
    script = '''
    (async () => {
        // Trigger a request to capture appcheck
        try {
            await fetch('https://orchestration.baselane.com/graphql', {
                method: 'POST',
                credentials: 'include',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({query: '{ __typename }'})
            });
        } catch(e) {}
        
        // Find appcheck in cookie or localStorage
        const cookies = document.cookie.split(';');
        for (const c of cookies) {
            if (c.trim().startsWith('firebase-app-check-token')) {
                return 'cookie:' + c.trim();
            }
        }
        
        // Try to find in a variable
        for (const key of Object.keys(window)) {
            if (key.includes('appcheck') || key.includes('firebase')) {
                try {
                    const v = window[key];
                    if (typeof v === 'object' && v && v.token) return 'var:' + v.token;
                } catch(e) {}
            }
        }
        
        return 'NO_TOKEN';
    })()
    '''
    result = cdp_eval(script)
    if result and isinstance(result, str) and result.startswith('cookie:'):
        return result.replace('cookie:', '')
    return None

def graphql_query(query, variables):
    """Execute GraphQL query via CDP fetch injection."""
    mutation = query  # For mutations
    script = f'''
    (async () => {{
        const resp = await fetch('https://orchestration.baselane.com/graphql', {{
            method: 'POST',
            credentials: 'include',
            headers: {{
                'content-type': 'application/json',
                'x-firebase-appcheck': '{get_appcheck_token() or "NONE"}'
            }},
            body: JSON.stringify({json.dumps({{'query': mutation, 'variables': variables}})}) 
        }});
        const text = await resp.text();
        return text;
    }})()
    '''
    
    result = cdp_eval(script)
    if result:
        try:
            return json.loads(result) if isinstance(result, str) else result
        except:
            return result
    return None

def query_unsplit_citadel():
    """Query for unsplit Citadel mortgage transactions."""
    query = '''
    query GetUnsplits($input: SortsAndFilters) {
      transaction(input: $input) {
        data {
          id
          amount
          date
          merchantName
          propertyId
          tagId
          isSplit
          parentId
        }
      }
    }
    '''
    variables = {
        'input': {
            'sort': {'direction': 'DESC', 'field': 'date'},
            'filter': {
                'search': 'CITADEL',
                'isHidden': False,
                'isDeleted': False,
            },
            'page': 1,
            'pageLimit': 50
        }
    }
    
    result = graphql_query(query, variables)
    if result and 'data' in result:
        txns = result['data'].get('transaction', {}).get('data', [])
        # Filter for unsplit parent transactions (isSplit=false, no parentId)
        unsplit = [t for t in txns if not t.get('isSplit') and not t.get('parentId')]
        return unsplit
    return []

def execute_split(parent_id, splits):
    """Execute a split for one transaction."""
    mutation = '''
    mutation createOrUpdateSplitTx($parentTransactionId: ID!, $splitType: SplitType!, $transactionSplitInputs: [TransactionSplitInput!]!) {
      createOrUpdateSplitTx(
        input: {parentTransactionId: $parentTransactionId, transactionSplitInputs: $transactionSplitInputs, splitType: $splitType}
      ) {
        id
        splitTransactions {
          id
          tagId
          amount
          merchantName
        }
      }
    }
    '''
    
    variables = {
        'parentTransactionId': str(parent_id),
        'splitType': 'AMOUNT',
        'transactionSplitInputs': splits
    }
    
    result = graphql_query(mutation, variables)
    return result

def main():
    print("Baselane Mortgage Split Executor")
    print("=" * 50)
    
    # Step 1: Get appcheck token
    print("\n[1] Getting appcheck token...")
    token = get_appcheck_token()
    if token:
        print(f"  ✓ Token: {token[:20]}...")
    else:
        print("  ✗ Could not get token")
        return
    
    # Step 2: Query unsplit transactions
    print("\n[2] Querying unsplit Citadel transactions...")
    unsplit = query_unsplit_citadel()
    print(f"  Found {len(unsplit)} unsplit transactions:")
    for t in unsplit:
        print(f"  {t['id']}  {t['date']}  ${t['amount']}  prop:{t.get('propertyId')}  {t.get('merchantName','')[:40]}")
    
    if not unsplit:
        print("  Nothing to split.")
        return
    
    print("\n[3] Ready to split. Press Enter to proceed, or Ctrl+C to abort.")
    input()

if __name__ == '__main__':
    main()
