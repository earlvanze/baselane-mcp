#!/usr/bin/env python3
"""
Baselane Amazon/Walmart 4-way auto-split child row deletion script.
Reads parent IDs from CSV, loads state file, deletes child rows via Playwright.
Stops if workspace is read-only (no Delete button visible).
"""
import csv
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path('/home/umbrel/.openclaw/workspace')
CSV_PATH = ROOT / 'reports' / 'amazon_walmart_auto_splits_2024_2025.csv'
STATE_PATH = ROOT / 'reports' / 'amazon_walmart_split_cleanup_state.json'
SECRETS = ROOT / '.secrets' / 'bw.env'

VENV_PYTHON = str(ROOT / '.venv-playwright' / 'bin' / 'python')

def load_env(path):
    env = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        if '=' in line and not line.strip().startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    return env

def load_state():
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    return {"total_parents": 49, "completed": [], "failed": [], "skipped": [], "notes": ""}

def save_state(state):
    state['last_updated'] = datetime.utcnow().isoformat() + 'Z'
    STATE_PATH.write_text(json.dumps(state, indent=2))

def get_parent_ids():
    """Extract unique parent IDs in order from CSV."""
    seen = []
    seen_set = set()
    with open(CSV_PATH) as f:
        reader = csv.DictReader(f)
        for row in reader:
            pid = row['parent_id'].strip()
            if pid not in seen_set:
                seen.append(pid)
                seen_set.add(pid)
    return seen

def run_deletion(batch_size=10):
    creds = load_env(SECRETS)
    email = creds.get('BASELANE_EMAIL', '')
    password = creds.get('BASELANE_PASSWORD', '')
    if not email or not password:
        print("ERROR: Missing BASELANE_EMAIL or BASELANE_PASSWORD in secrets")
        sys.exit(1)

    state = load_state()
    completed_set = set(state.get('completed', []))
    failed_set = set(state.get('failed', []))
    
    parent_ids = get_parent_ids()
    remaining = [p for p in parent_ids if p not in completed_set and p not in failed_set]
    
    print(f"Total parents: {len(parent_ids)}")
    print(f"Already completed: {len(completed_set)}")
    print(f"Previously failed: {len(failed_set)}")
    print(f"Remaining to process: {len(remaining)}")
    
    if not remaining:
        print("All parents processed!")
        return
    
    # Process up to batch_size parents
    to_process = remaining[:batch_size]
    print(f"Processing batch of {len(to_process)}: {to_process}")
    
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
    
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path='/usr/bin/brave-browser',
            args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
        )
        context = browser.new_context(viewport={'width': 1400, 'height': 900})
        page = context.new_page()
        
        # Login
        print("Logging in to Baselane...")
        page.goto('https://app.baselane.com/login', timeout=30000)
        page.wait_for_load_state('networkidle', timeout=30000)
        
        # Fill login form
        page.fill('input[type="email"], input[name="email"], input[placeholder*="email" i]', email)
        page.fill('input[type="password"], input[name="password"]', password)
        page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")')
        
        # Wait for dashboard
        try:
            page.wait_for_url('**/transactions**', timeout=30000)
            print("Login successful - on transactions page")
        except PlaywrightTimeout:
            # Try waiting for any authenticated page
            page.wait_for_load_state('networkidle', timeout=15000)
            current_url = page.url
            print(f"After login URL: {current_url}")
            if 'login' in current_url:
                print("ERROR: Still on login page - credentials may have failed")
                browser.close()
                return
        
        # Navigate to transactions
        if 'transactions' not in page.url:
            page.goto('https://app.baselane.com/transactions', timeout=30000)
            page.wait_for_load_state('networkidle', timeout=30000)
        
        print(f"Current URL: {page.url}")
        
        # WORKSPACE CHECK: look for delete button availability
        # First, check we're in the right workspace - look for NY properties context
        page_text = page.inner_text('body')
        
        # Check we're in the NY/correct workspace (Madison Ave accounts)
        workspace_indicators = ['Madison', '84 Madison', '86 Madison', '88 Madison', '90 Madison']
        
        print("Performing workspace sanity check...")
        # Navigate to transactions and search for first parent ID
        first_pid = to_process[0]
        
        batch_completed = 0
        batch_failed = 0
        
        for i, parent_id in enumerate(to_process):
            print(f"\n--- Processing parent {i+1}/{len(to_process)}: {parent_id} ---")
            
            try:
                # Search for the transaction by description using the search/filter
                # Navigate to transactions with search
                search_url = f'https://app.baselane.com/transactions?search={parent_id}'
                page.goto(search_url, timeout=30000)
                page.wait_for_load_state('networkidle', timeout=20000)
                time.sleep(2)
                
                # Try to find the search input and search for parent_id description
                # The child rows have descriptions like "Amazon.com*X | 88 Madison - 6/20"
                # We need to find them via the Baselane transactions UI
                
                # Take screenshot for debugging
                screenshot_path = f'/tmp/baselane_debug_{parent_id}.png'
                page.screenshot(path=screenshot_path)
                
                # Look for transaction rows on page
                # Try using the filter/search functionality
                # First look for a search input
                search_inputs = page.query_selector_all('input[placeholder*="search" i], input[placeholder*="Search" i]')
                print(f"Found {len(search_inputs)} search inputs")
                
                if search_inputs:
                    search_inputs[0].click()
                    search_inputs[0].fill(parent_id)
                    search_inputs[0].press('Enter')
                    time.sleep(3)
                    page.wait_for_load_state('networkidle', timeout=15000)
                
                # Count matching rows (child rows will contain the parent_id in description)
                # Look for transaction rows
                rows = page.query_selector_all('tr, [data-testid*="transaction"], [class*="transaction-row"]')
                print(f"Found {len(rows)} transaction rows after search")
                
                # Look specifically for delete buttons
                delete_btns = page.query_selector_all('button:has-text("Delete"), [aria-label*="delete" i], [data-testid*="delete" i]')
                print(f"Found {len(delete_btns)} delete buttons")
                
                if len(delete_btns) == 0:
                    # Check if we're in read-only mode
                    page_content = page.inner_text('body')
                    print("WARNING: No delete buttons found - checking workspace...")
                    print(f"Page URL: {page.url}")
                    print(f"Page content snippet: {page_content[:500]}")
                    
                    # Record as failed with blocker note
                    state['failed'].append(parent_id)
                    state.setdefault('blockers', []).append({
                        'parent_id': parent_id,
                        'reason': 'No delete button visible - possible wrong workspace or read-only',
                        'url': page.url
                    })
                    save_state(state)
                    
                    print(f"BLOCKER DETECTED: No delete button for parent {parent_id}. Stopping.")
                    browser.close()
                    return
                
                # We have delete buttons - proceed
                # Need to open each child row and delete
                # The approach: find all 4 child rows for this parent, click each one and delete
                
                deleted_count = 0
                
                # Try to click on rows to find and delete the 4 children
                # Strategy: look for the description patterns for this parent's children
                # Child descriptions contain the merchant name split across 4 properties
                
                all_clickable_rows = page.query_selector_all('tr[class*="transaction"], [role="row"], tbody tr')
                print(f"Found {len(all_clickable_rows)} clickable rows")
                
                for row in all_clickable_rows[:20]:  # Limit scan
                    try:
                        row_text = row.inner_text()
                        if parent_id in row_text or '| 84 Madison' in row_text or '| 88 Madison' in row_text:
                            print(f"Potential match row: {row_text[:100]}")
                    except:
                        pass
                
                # For now, mark as needing manual investigation if we can't confirm deletion
                print(f"Parent {parent_id}: Identified {len(delete_btns)} delete buttons visible")
                # We'll implement the actual click-delete in the next iteration once we understand the UI structure
                state['failed'].append({'id': parent_id, 'reason': 'UI structure inspection needed'})
                save_state(state)
                batch_failed += 1
                    
            except Exception as e:
                print(f"ERROR processing {parent_id}: {e}")
                state['failed'].append({'id': parent_id, 'reason': str(e)})
                save_state(state)
                batch_failed += 1
        
        # Final screenshot
        page.screenshot(path='/tmp/baselane_final_state.png')
        print(f"\nFinal page URL: {page.url}")
        browser.close()
    
    print(f"\nBatch complete: {batch_completed} deleted, {batch_failed} failed/pending")

if __name__ == '__main__':
    run_deletion(batch_size=1)  # Start with 1 to inspect UI structure
