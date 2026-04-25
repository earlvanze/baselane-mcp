#!/usr/bin/env python3
"""
baselane_sync_cdp_human_paced.py

Anti-bot-detection sync:
1. Login via CDP (baselane_login_and_wait_via_cdp.js)
2. Export with human pacing (baselane_export_human_paced.js)
3. Run split script
"""
import json
import os
import subprocess
import urllib.request
import time
from pathlib import Path

ROOT = Path(os.environ.get('WORKSPACE_ROOT', str(Path.home() / '.openclaw' / 'workspace')))
SECRETS = ROOT / '.secrets' / 'bw.env'
REPORT = ROOT / 'reports' / 'baselane_sync_cdp_report.json'
LOGIN_SCRIPT = ROOT / 'scripts' / 'baselane_login_and_wait_via_cdp.js'
EXPORT_SCRIPT = ROOT / 'scripts' / 'baselane_export_human_paced.js'
SPLIT_SCRIPT = ROOT / 'scripts' / 'split_ledger_public_financials.py'


def load_env(path: Path):
    if not path.exists():
        return
    for line in path.read_text(encoding='utf-8').splitlines():
        if '=' in line and not line.strip().startswith('#'):
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())


def ensure_cdp_running():
    targets = [
        ('127.0.0.1', 18800),
        ('127.0.0.1', 9222),
        ('127.0.0.1', 19222),
        ('::1', 18800),
        ('::1', 9222),
    ]
    for host, port in targets:
        try:
            brackets = f'[{host}]' if ':' in host else host
            url = f'http://{brackets}:{port}/json/version'
            with urllib.request.urlopen(url, timeout=2) as r:
                return True
        except Exception:
            pass
    return False


def run():
    load_env(SECRETS)
    report = {'started_at': time.time(), 'status': 'running', 'steps': [], 'mode': 'human_paced'}

    if not ensure_cdp_running():
        report['status'] = 'failed'
        report['reason'] = 'cdp_not_running'
        REPORT.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print('FAILED: CDP not running (neither 18800 nor 9222)')
        return 4

    # Step 1: Login and wait
    login_env = os.environ.copy()
    login_env.setdefault('BASELANE_FORCE_LOGIN', '1')
    login_env.setdefault('BASELANE_LOGIN_WAIT_URL', 'https://app.baselane.com/transactions')
    login_env.setdefault('BASELANE_LOGIN_WAIT_TIMEOUT_MS', '180000')
    login_env.setdefault('BASELANE_LOGIN_WAIT_MS', '15000')
    # Brave CDP only binds [::1]:9222 (IPv6), not 127.0.0.1 (IPv4)
    login_env.setdefault('BASELANE_CDP_VERSION_URL', 'http://127.0.0.1:18800/json/version')
    
    login = subprocess.run(
        ['node', str(LOGIN_SCRIPT)],
        text=True, capture_output=True, env=login_env, timeout=300
    )
    report['steps'].append('cdp_login_wait')
    report['login_exit'] = login.returncode
    report['login_stdout_tail'] = (login.stdout or '')[-4000:]
    report['login_stderr_tail'] = (login.stderr or '')[-4000:]
    
    if login.returncode != 0:
        report['status'] = 'failed'
        report['reason'] = 'cdp_login_failed'
        REPORT.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print('FAILED: CDP login wait failed')
        return 4

    # Human-like pause after login
    print('[SYNC] Login successful, waiting 3s before export...')
    time.sleep(3)

    # Step 2: Human-paced export
    export = subprocess.run(
        ['node', str(EXPORT_SCRIPT)],
        text=True, capture_output=True, env=os.environ.copy(), timeout=1800
    )
    report['steps'].append('human_paced_export')
    report['export_exit'] = export.returncode
    report['export_stdout_tail'] = (export.stdout or '')[-4000:]
    report['export_stderr_tail'] = (export.stderr or '')[-4000:]

    if export.returncode != 0:
        report['status'] = 'failed'
        report['reason'] = 'human_paced_export_failed'
        REPORT.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print('FAILED: human-paced export failed')
        return 4

    # Step 3: Split ledger
    rs = subprocess.run(
        ['python3', str(SPLIT_SCRIPT)],
        text=True, capture_output=True, timeout=1800
    )
    report['steps'].append('split_ledger')
    report['split_exit'] = rs.returncode
    report['split_stdout_tail'] = (rs.stdout or '')[-2000:]
    report['split_stderr_tail'] = (rs.stderr or '')[-2000:]
    
    report['status'] = 'ok' if rs.returncode == 0 else 'failed'
    report['finished_at'] = time.time()
    REPORT.write_text(json.dumps(report, indent=2), encoding='utf-8')

    if rs.returncode == 0:
        print('OK: baselane sync via human-paced export complete')
        return 0
    print('FAILED: split script failed')
    return 5


def main():
    try:
        code = run()
    except Exception as e:
        REPORT.write_text(json.dumps({
            'status': 'failed', 
            'reason': str(e), 
            'mode': 'human_paced'
        }, indent=2), encoding='utf-8')
        print(f'FAILED: {e}')
        raise SystemExit(1)
    raise SystemExit(code)


if __name__ == '__main__':
    main()
