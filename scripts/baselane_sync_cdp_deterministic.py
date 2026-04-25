#!/usr/bin/env python3
import json
import os
import subprocess
import urllib.request
import time
from pathlib import Path

from baselane_brave_utils import cdp_diagnostics, load_env, resolve_brave_cdp_version

ROOT = Path(os.environ.get('WORKSPACE_ROOT', str(Path.home() / '.openclaw' / 'workspace')))
SECRETS = ROOT / '.secrets' / 'bw.env'
REPORT = ROOT / 'reports' / 'baselane_sync_cdp_report.json'
EXPORT_SCRIPT = ROOT / 'scripts' / 'baselane_login_and_export_via_cdp.js'
LOGIN_WAIT = ROOT / 'scripts' / 'baselane_login_and_wait_via_cdp.js'
SPLIT_SCRIPT = ROOT / 'scripts' / 'split_ledger_public_financials.py'


def ensure_cdp_running():
    try:
        resolve_brave_cdp_version(timeout=2)
        return True
    except Exception:
        pass

    cdp_port = os.environ.get('BASELANE_CDP_PORT', '9222')
    subprocess.Popen([
        '/usr/bin/brave-browser',
        f'--remote-debugging-port={cdp_port}',
        '--user-data-dir=/home/umbrel/.openclaw/brave-cdp',
        '--no-first-run',
        '--no-default-browser-check'
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    for _ in range(10):
        try:
            resolve_brave_cdp_version(timeout=2)
            return True
        except Exception:
            time.sleep(1)
    return False



def run():
    load_env(SECRETS)
    report = {'started_at': time.time(), 'status': 'running', 'steps': []}

    if not ensure_cdp_running():
        report['status'] = 'failed'
        report['reason'] = 'cdp_not_running'
        REPORT.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print('FAILED: CDP not running')
        return 4

    resolved_cdp = resolve_brave_cdp_version(timeout=5)
    report['cdp_version_url'] = resolved_cdp.get('version_url')
    report['cdp_browser'] = resolved_cdp.get('browser')

    skip_login_wait = os.environ.get('BASELANE_SKIP_LOGIN_WAIT', '1') == '1'
    report['skip_login_wait'] = skip_login_wait
    if not skip_login_wait:
        login_env = os.environ.copy()
        login_env['BASELANE_CDP_VERSION_URL'] = resolved_cdp['version_url']
        login_env.setdefault('BASELANE_FORCE_LOGIN', '0')
        login_env.setdefault('BASELANE_LOGIN_WAIT_URL', 'https://app.baselane.com/transactions')
        login_env.setdefault('BASELANE_LOGIN_WAIT_TIMEOUT_MS', '180000')
        login_env.setdefault('BASELANE_LOGIN_WAIT_MS', '15000')
        login = subprocess.run(['node', str(LOGIN_WAIT)], text=True, capture_output=True, env=login_env, timeout=300)
        report['steps'].append('cdp_login_wait')
        report['login_exit'] = login.returncode
        report['login_stdout_tail'] = (login.stdout or '')[-4000:]
        report['login_stderr_tail'] = (login.stderr or '')[-4000:]
        if login.returncode != 0:
            report['login_warning'] = 'cdp_login_wait_failed_but_continuing_to_export'

    exported = subprocess.run(
        ['node', str(EXPORT_SCRIPT)],
        text=True,
        capture_output=True,
        env={
            **os.environ.copy(),
            'BASELANE_FORCE_LOGIN': os.environ.get('BASELANE_FORCE_LOGIN', '0'),
            'BASELANE_CDP_VERSION_URL': resolved_cdp['version_url'],
        },
        timeout=1800,
    )
    report['steps'].append('raw_cdp_login_and_export')
    report['export_exit'] = exported.returncode
    report['export_stdout_tail'] = (exported.stdout or '')[-4000:]
    report['export_stderr_tail'] = (exported.stderr or '')[-4000:]

    if exported.returncode != 0:
        report['status'] = 'failed'
        report['reason'] = 'raw_cdp_export_failed'
        REPORT.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print('FAILED: raw CDP export failed')
        return 4

    rs = subprocess.run(['python3', str(SPLIT_SCRIPT)], text=True, capture_output=True, timeout=1800)
    report['split_exit'] = rs.returncode
    report['split_stdout_tail'] = (rs.stdout or '')[-2000:]
    report['split_stderr_tail'] = (rs.stderr or '')[-2000:]
    report['status'] = 'ok' if rs.returncode == 0 else 'failed'
    report['finished_at'] = time.time()
    REPORT.write_text(json.dumps(report, indent=2), encoding='utf-8')

    if rs.returncode == 0:
        print('OK: baselane sync via raw CDP login/export complete')
        return 0
    print('FAILED: split script failed')
    return 5


def main():
    try:
        code = run()
    except Exception as e:
        REPORT.write_text(json.dumps({'status': 'failed', 'reason': str(e), 'cdp_diagnostics': cdp_diagnostics()}, indent=2), encoding='utf-8')
        print(f'FAILED: {e}')
        raise SystemExit(1)
    raise SystemExit(code)


if __name__ == '__main__':
    main()
