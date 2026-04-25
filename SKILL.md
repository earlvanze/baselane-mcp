---
name: baselane-mcp
description: MCP server for Baselane property finance automation (statements, splits, P&L, exports). Requires authenticated Brave CDP session.
---

# Baselane MCP

MCP server wrapping Baselane automation scripts for property finance operations.

## Quick Start

### 1. Install

```bash
cd /home/umbrel/.openclaw/workspace/skills/baselane-mcp
pip install -e .
```

### 2. Prerequisites

- **Brave browser** running with CDP port 9222
- **Authenticated Baselane session** (see `baselane_attached_login_and_tokens.py`)
- **Env vars** (optional): `BASELANE_PROPERTY_MAP`, `BASELANE_OUTPUT_DIR`

### 3. Start Server

```bash
baselane-mcp
# Or via Python:
python3 -m baselane_mcp.server
```

## Tools

| Tool | Description | Auth Required |
|------|-------------|---------------|
| `export_statements` | Download statements via CDP | ✅ CDP session |
| `split_mortgage` | Split mortgage payments | ✅ CDP session |
| `export_ledger` | Export general ledger | ✅ CDP session |
| `batch_split` | Batch transaction splitting | ✅ CDP session |
| `get_auth_status` | Check auth health | ✅ CDP session |
| `weekly_unprocessed_report` | Weekly unprocessed txns report | ✅ CDP session |
| `get_pl_entry` | Get P&L entry (placeholder) | ⚠️ API needed |
| `create_pl_entry` | Create P&L entry (placeholder) | ⚠️ API needed |
| `update_pl_entry` | Update P&L entry (placeholder) | ⚠️ API needed |

## Usage Examples

```bash
# Check auth status first
mcporter call baselane.get_auth_status

# Export statements (dry run)
mcporter call baselane.export_statements property_address="123 Main St" start_date="2026-04-01" dry_run=true

# Split mortgage
mcporter call baselane.split_mortgage property_address="123 Main St" dry_run=true

# Weekly report
mcporter call baselane.weekly_unprocessed_report
```

## Scripts Directory

Core automation lives in `/workspace/scripts/`:
- `baselane_mortgage_split_automation.py` — Mortgage split logic
- `baselane_export_ledger_cdp.py` — Ledger export via CDP
- `baselane_batch_split.py` — Batch splitting
- `baselane_weekly_unprocessed_report.py` — Weekly reports
- `baselane_attached_login_and_tokens.py` — Auth management

## Auth Notes

- Uses **CDP (Chrome DevTools Protocol)** for browser automation
- Requires **Brave browser** on port 9222
- Session cookies stored in workspace secure/ directory
- P&L write operations need Baselane API access (not yet implemented)

## Configuration

Edit `config/property_map.json` for property address → entity ID mappings.
