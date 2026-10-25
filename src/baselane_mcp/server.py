#!/usr/bin/env python3
"""Baselane MCP Server - Property finance automation"""

from __future__ import annotations
from typing import Annotated, Any
from pydantic import Field
import subprocess
import json
import os
import sys
from pathlib import Path

try:
    from mcp.server.fastmcp import FastMCP
except Exception as exc:
    FastMCP = None
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None

SCRIPTS_DIR = Path(
    os.environ.get(
        "BASELANE_SCRIPTS_DIR",
        str(Path(__file__).resolve().parent.parent.parent / "scripts"),
    )
)
PYTHON_BIN = sys.executable if sys.platform == "win32" else "python3"
NODE_BIN = "node"

if FastMCP is not None:
    _P = {
        "entity_id": "Baselane entity ID (property, account, or transaction)",
        "property_address": "Property address for lookup",
        "start_date": "Start date (YYYY-MM-DD)",
        "end_date": "End date (YYYY-MM-DD)",
        "split_type": "Split type: mortgage, expense, income",
        "dry_run": "Preview changes without applying",
        "force": "Force operation even if preconditions not met",
        "output_dir": "Output directory for exports",
        "include_pdfs": "Include PDF statements in export",
        "account_type": "Account type: checking, savings, credit_card, loan",
    }
    
    def _F(name: str, default=None, **field_kwargs):
        desc = _P.get(name, name)
        if default is not None:
            return Field(default=default, description=desc, **field_kwargs)
        return Field(description=desc, **field_kwargs)
    
    mcp = FastMCP(
        "baselane",
        instructions=(
            "Baselane MCP server for property finance automation. "
            "Use CDP-based tools for auth-heavy operations (exports, splits). "
            "Always dry_run=true first before applying changes."
        ),
    )
    
    @mcp.tool()
    def export_statements(
        property_address: Annotated[str | None, _F("property_address")] = None,
        start_date: Annotated[str | None, _F("start_date")] = None,
        end_date: Annotated[str | None, _F("end_date")] = None,
        include_pdfs: Annotated[bool, _F("include_pdfs")] = False,
        dry_run: Annotated[bool, _F("dry_run")] = True,
    ) -> dict[str, Any]:
        """Export Baselane statements via CDP. Requires authenticated browser session."""
        cmd = [
            NODE_BIN, str(SCRIPTS_DIR / "baselane_download_statements_cdp.js"),
        ]
        if property_address:
            cmd.extend(["--property", property_address])
        if start_date:
            cmd.extend(["--start", start_date])
        if end_date:
            cmd.extend(["--end", end_date])
        if dry_run:
            return {"status": "dry_run", "command": " ".join(cmd)}
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        return {"status": "success" if result.returncode == 0 else "error", "output": result.stdout, "error": result.stderr}
    
    @mcp.tool()
    def split_mortgage(
        property_address: Annotated[str, _F("property_address")],
        split_type: Annotated[str, _F("split_type")] = "mortgage",
        dry_run: Annotated[bool, _F("dry_run")] = True,
    ) -> dict[str, Any]:
        """Split mortgage payments across properties using automation script."""
        cmd = [
            PYTHON_BIN, str(SCRIPTS_DIR / "baselane_mortgage_split_automation.py"),
            "--property", property_address,
            "--type", split_type,
        ]
        if dry_run:
            return {"status": "dry_run", "command": " ".join(cmd)}
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        return {"status": "success" if result.returncode == 0 else "error", "output": result.stdout, "error": result.stderr}
    
    @mcp.tool()
    def export_ledger(
        entity_id: Annotated[str | None, _F("entity_id")] = None,
        start_date: Annotated[str | None, _F("start_date")] = None,
        end_date: Annotated[str | None, _F("end_date")] = None,
        output_dir: Annotated[str | None, _F("output_dir")] = None,
        dry_run: Annotated[bool, _F("dry_run")] = True,
    ) -> dict[str, Any]:
        """Export general ledger from Baselane."""
        cmd = [PYTHON_BIN, str(SCRIPTS_DIR / "baselane_export_ledger_cdp.py")]
        if entity_id:
            cmd.extend(["--entity", entity_id])
        if start_date:
            cmd.extend(["--start", start_date])
        if end_date:
            cmd.extend(["--end", end_date])
        if output_dir:
            cmd.extend(["--output", output_dir])
        if dry_run:
            return {"status": "dry_run", "command": " ".join(cmd)}
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        return {"status": "success" if result.returncode == 0 else "error", "output": result.stdout, "error": result.stderr}
    
    @mcp.tool()
    def batch_split(
        start_date: Annotated[str | None, _F("start_date")] = None,
        end_date: Annotated[str | None, _F("end_date")] = None,
        dry_run: Annotated[bool, _F("dry_run")] = True,
    ) -> dict[str, Any]:
        """Batch split multiple transactions."""
        cmd = [PYTHON_BIN, str(SCRIPTS_DIR / "baselane_batch_split.py")]
        if start_date:
            cmd.extend(["--start", start_date])
        if end_date:
            cmd.extend(["--end", end_date])
        if dry_run:
            return {"status": "dry_run", "command": " ".join(cmd)}
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        return {"status": "success" if result.returncode == 0 else "error", "output": result.stdout, "error": result.stderr}
    
    @mcp.tool()
    def get_auth_status() -> dict[str, Any]:
        """Check Baselane authentication status via CDP (browser session)."""
        import urllib.request
        import urllib.error

        cdp_host = os.environ.get("BASELANE_CDP_HOST", "127.0.0.1")
        cdp_port = os.environ.get("BASELANE_CDP_PORT", "9222")
        base = f"http://{cdp_host}:{cdp_port}"

        def _http_json(url: str, timeout: int = 3):
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))

        try:
            version = _http_json(f"{base}/json/version")
        except Exception as exc:
            return {"status": "error", "cdp_reachable": False, "error": str(exc)}

        browser = version.get("Browser", "")

        try:
            targets = _http_json(f"{base}/json/list")
        except Exception as exc:
            return {"status": "error", "cdp_reachable": True, "browser": browser, "error": str(exc)}

        pages = [
            t for t in targets
            if t.get("type") == "page" and "app.baselane.com" in (t.get("url") or "")
        ]
        if not pages:
            return {
                "status": "not_authenticated",
                "cdp_reachable": True,
                "browser": browser,
                "reason": "no_baselane_tab",
            }

        page = pages[0]
        url = page.get("url", "")
        title = page.get("title", "")

        if "/login" in url or "/signin" in url:
            return {
                "status": "not_authenticated",
                "cdp_reachable": True,
                "browser": browser,
                "url": url,
                "title": title,
                "reason": "on_login_page",
            }

        return {
            "status": "authenticated",
            "cdp_reachable": True,
            "browser": browser,
            "url": url,
            "title": title,
        }
    
    @mcp.tool()
    def weekly_unprocessed_report(
        start_date: Annotated[str | None, _F("start_date")] = None,
        end_date: Annotated[str | None, _F("end_date")] = None,
    ) -> dict[str, Any]:
        """Generate weekly unprocessed transactions report."""
        cmd = [PYTHON_BIN, str(SCRIPTS_DIR / "baselane_weekly_unprocessed_report.py")]
        if start_date:
            cmd.extend(["--start", start_date])
        if end_date:
            cmd.extend(["--end", end_date])
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return {"status": "success" if result.returncode == 0 else "error", "output": result.stdout, "error": result.stderr}
    
    @mcp.tool()
    def get_pl_entry(
        entity_id: Annotated[str, _F("entity_id")],
        year: Annotated[int | None, _F("year")] = None,
        month: Annotated[int | None, _F("month")] = None,
    ) -> dict[str, Any]:
        """Get P&L entry for entity."""
        # Placeholder - would wrap actual P&L query logic
        return {"status": "not_implemented", "note": "P&L tools need Baselane API integration"}
    
    @mcp.tool()
    def create_pl_entry(
        entity_id: Annotated[str, _F("entity_id")],
        year: Annotated[int | None, _F("year")] = None,
        month: Annotated[int | None, _F("month")] = None,
        pl_entry: Annotated[dict[str, Any] | None, "P&L entry fields"] = None,
        dry_run: Annotated[bool, _F("dry_run")] = True,
    ) -> dict[str, Any]:
        """Create P&L entry."""
        return {"status": "dry_run", "note": "P&L write operations require Baselane API access"}
    
    @mcp.tool()
    def update_pl_entry(
        entity_id: Annotated[str, _F("entity_id")],
        year: Annotated[int | None, _F("year")] = None,
        month: Annotated[int | None, _F("month")] = None,
        pl_entry: Annotated[dict[str, Any] | None, "P&L entry fields to update"] = None,
        dry_run: Annotated[bool, _F("dry_run")] = True,
    ) -> dict[str, Any]:
        """Update P&L entry."""
        return {"status": "dry_run", "note": "P&L write operations require Baselane API access"}


def main() -> None:
    if FastMCP is None:
        raise SystemExit("MCP package not installed. Run: pip install mcp") from _IMPORT_ERROR
    mcp.run()


if __name__ == "__main__":
    main()
