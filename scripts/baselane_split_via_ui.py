#!/usr/bin/env python3
"""
Baselane mortgage split automation via CDP UI interaction.
Uses browser tool with chrome-relay profile for reliable selector targeting.
"""
import sys
import json
from pathlib import Path

def load_split_queue():
    """Load pending splits from checklist CSV."""
    csv_path = Path.home() / '.openclaw/workspace/reports/mortgage_split_checklist.csv'
    if not csv_path.exists():
        print(f"ERROR: {csv_path} not found", file=sys.stderr)
        sys.exit(1)
    
    import csv
    splits = []
    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get('status') == 'pending':
                splits.append({
                    'property': row['property'],
                    'month': row['month'],
                    'txn_id': row['transaction_id'],
                    'principal': float(row['principal']),
                    'interest': float(row['interest']),
                    'escrow': float(row['escrow']),
                    'taxes': float(row.get('taxes', 0) or 0),
                    'insurance': float(row.get('insurance', 0) or 0),
                    'water': float(row.get('water', 0) or 0),
                    'other': float(row.get('other', 0) or 0),
                })
    return splits

def build_ui_automation_plan(splits):
    """
    Build Playwright-style automation steps for batch splits.
    
    Per MEMORY.md:
    - P&I → Mining, Sales, Consulting, & PM
    - Escrow components → property entity
    - Remainder → General Escrow
    """
    plan = []
    for s in splits:
        plan.append({
            'action': 'navigate',
            'url': f"https://app.baselane.com/transactions?search={s['txn_id']}"
        })
        plan.append({
            'action': 'wait_for_selector',
            'selector': f"[data-transaction-id='{s['txn_id']}']"
        })
        plan.append({
            'action': 'click',
            'selector': f"[data-transaction-id='{s['txn_id']}'] button[aria-label='Split']"
        })
        plan.append({
            'action': 'wait_for_selector',
            'selector': "[data-testid='split-dialog']"
        })
        
        # Add split rows
        components = []
        if s['principal'] != 0:
            components.append(('Principal', s['principal'], 'Mortgage Principal Payments'))
        if s['interest'] != 0:
            components.append(('Interest', s['interest'], 'Mortgage Interest Payments'))
        if s['taxes'] != 0:
            components.append(('Taxes', s['taxes'], 'Taxes'))
        if s['insurance'] != 0:
            components.append(('Insurance', s['insurance'], 'Insurance'))
        if s['water'] != 0:
            components.append(('Water/Sewer', s['water'], 'Water & Sewer'))
        if s['other'] != 0:
            components.append(('Other Escrow', s['other'], 'Escrow Payments'))
        
        for label, amount, category in components:
            plan.append({
                'action': 'fill_split_row',
                'label': label,
                'amount': amount,
                'category': category
            })
        
        plan.append({
            'action': 'click',
            'selector': "[data-testid='split-dialog'] button[type='submit']"
        })
        plan.append({
            'action': 'wait_for_navigation',
            'timeout': 5000
        })
    
    return plan

if __name__ == '__main__':
    splits = load_split_queue()
    print(f"Loaded {len(splits)} pending splits", file=sys.stderr)
    
    plan = build_ui_automation_plan(splits)
    print(json.dumps(plan, indent=2))
