#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path


def close_baselane_tabs():
    try:
        import json, urllib.request
        with urllib.request.urlopen('http://127.0.0.1:9222/json/list', timeout=3) as r:
            tabs = json.loads(r.read().decode('utf-8'))
        ids = [t.get('id') for t in tabs if 'baselane.com' in (t.get('url') or '')]
        for tid in ids:
            try:
                urllib.request.urlopen(f'http://127.0.0.1:9222/json/close/{tid}', timeout=3).read()
            except Exception:
                pass
    except Exception:
        pass

ROOT = Path('/home/umbrel/.openclaw/workspace')
REPORTS = ROOT / 'reports'
TRACKER = ROOT / 'Dropbox/Projects/transaction_tracker'
CANON = TRACKER / 'ECO Systems General Ledger.csv'
STATE = ROOT / 'scripts/.baselane_deterministic_state.json'
RUN_REPORT = REPORTS / 'baselane_deterministic_session_v1.json'

REFRESH_EXPORT = ROOT / 'scripts/baselane_sync_cdp_human_paced.py'
SPLIT_SCRIPT = ROOT / 'scripts/split_ledger_public_financials.py'
GUARD_REPORT = REPORTS / 'baselane_export_guard_last.json'

MAX_RETRIES = int(os.environ.get('BASELANE_DETERMINISTIC_MAX_RETRIES', '3'))
RETRY_SLEEP = int(os.environ.get('BASELANE_DETERMINISTIC_RETRY_SLEEP_SEC', '5'))


def run_cmd(cmd, env=None, timeout=1800):
    p = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout)
    return {
        'cmd': cmd,
        'code': p.returncode,
        'stdout': (p.stdout or '')[-6000:],
        'stderr': (p.stderr or '')[-6000:],
    }


def now_iso():
    return datetime.now().isoformat()


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
    except Exception:
        return None


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding='utf-8')


def main():
    REPORTS.mkdir(parents=True, exist_ok=True)

    run = {
        'version': 'v1',
        'started_at': now_iso(),
        'status': 'running',
        'phases': [],
        'artifacts': {},
    }

    # phase 0: credential preflight (Bitwarden source-of-truth)
    py = str(ROOT / '.venv-playwright/bin/python')
    env = os.environ.copy()
    env.setdefault('BW_ENV', str(ROOT / '.secrets/bw.env'))
    bw_preflight = run_cmd([
        py,
        '-c',
        (
            'import os, subprocess, pathlib; '
            f"root=pathlib.Path('{str(ROOT)}'); "
            'env=dict(os.environ); env["BW_ENV"]=str(root/".secrets"/"bw.env"); '
            '# subprocess.check_call([str(root/"scripts"/"bw_ensure_session.sh")], env=env, stdout=subprocess.DEVNULL); '
            'pairs=[ln.split("=",1) for ln in (root/".secrets"/"bw.env").read_text(encoding="utf-8").splitlines() '
            'if "=" in ln and not ln.strip().startswith("#")]; '
            '[os.environ.__setitem__(k.strip(), v.strip()) for k, v in pairs]; '
            'item=os.environ.get("BASELANE_ITEM_ID","").strip(); '
            'sess=os.environ.get("BW_SESSION","").strip(); '
            'assert item, "Missing BASELANE_ITEM_ID"; '
            'subprocess.check_call(["bw","get","item",item,], stdout=subprocess.DEVNULL)'
        )
    ], env=env, timeout=300)
    phase0 = {'name': 'bitwarden_credential_preflight', 'ok': bw_preflight['code'] == 0, 'result': bw_preflight}
    run['phases'].append(phase0)
    if not phase0['ok']:
        run['status'] = 'failed'
        run['failed_phase'] = 'bitwarden_credential_preflight'
        run['finished_at'] = now_iso()
        save_json(RUN_REPORT, run)
        print(f"FAILED bitwarden_credential_preflight -> {RUN_REPORT}")
        raise SystemExit(1)

    # phase 1: session acquisition + guarded export (retry loop for relay flaps)
    phase1 = {'name': 'session_and_guarded_export', 'attempts': [], 'ok': False}
    for i in range(1, MAX_RETRIES + 1):
        attempt = {'attempt': i, 'started_at': now_iso()}
        res = run_cmd([py, str(REFRESH_EXPORT)], env=env, timeout=1800)
        attempt['result'] = res
        guard = load_json(GUARD_REPORT)
        attempt['guard_report_exists'] = bool(guard)
        attempt['guard_ok'] = bool((guard or {}).get('ok'))
        attempt['finished_at'] = now_iso()
        phase1['attempts'].append(attempt)

        if res['code'] == 0 and attempt['guard_ok']:
            phase1['ok'] = True
            break
        if i < MAX_RETRIES:
            time.sleep(RETRY_SLEEP)

    run['phases'].append(phase1)

    # fail-fast if phase1 failed
    if not phase1['ok']:
        run['status'] = 'failed'
        run['failed_phase'] = 'session_and_guarded_export'
        run['finished_at'] = now_iso()
        run['artifacts']['guard_report'] = str(GUARD_REPORT) if GUARD_REPORT.exists() else None
        save_json(RUN_REPORT, run)
        save_json(STATE, {
            'last_run': run['finished_at'],
            'status': run['status'],
            'failed_phase': run.get('failed_phase'),
            'report': str(RUN_REPORT),
        })
        print(f"FAILED session_and_guarded_export -> {RUN_REPORT}")
        raise SystemExit(2)

    # phase 2: canonical checks
    phase2 = {'name': 'canonical_verification', 'ok': CANON.exists(), 'canonical': str(CANON)}
    if CANON.exists():
        phase2['canonical_size_bytes'] = CANON.stat().st_size
        phase2['canonical_mtime'] = datetime.fromtimestamp(CANON.stat().st_mtime).isoformat()
    run['phases'].append(phase2)
    if not phase2['ok']:
        run['status'] = 'failed'
        run['failed_phase'] = 'canonical_verification'
        run['finished_at'] = now_iso()
        save_json(RUN_REPORT, run)
        print(f"FAILED canonical_verification -> {RUN_REPORT}")
        raise SystemExit(3)

    # phase 3: split ledger
    phase3_res = run_cmd(['python3', str(SPLIT_SCRIPT)], timeout=1800)
    phase3 = {'name': 'split_ledger', 'ok': phase3_res['code'] == 0, 'result': phase3_res}
    run['phases'].append(phase3)
    if not phase3['ok']:
        run['status'] = 'failed'
        run['failed_phase'] = 'split_ledger'
        run['finished_at'] = now_iso()
        save_json(RUN_REPORT, run)
        print(f"FAILED split_ledger -> {RUN_REPORT}")
        raise SystemExit(4)

    # phase 4: summarize artifacts
    snapshots = sorted(TRACKER.glob('ECO Systems General Ledger.filtered.*.csv'))
    backups = sorted(TRACKER.glob('ECO Systems General Ledger.*.bak.csv'))
    run['artifacts'] = {
        'canonical': str(CANON),
        'guard_report': str(GUARD_REPORT) if GUARD_REPORT.exists() else None,
        'latest_snapshot': str(snapshots[-1]) if snapshots else None,
        'latest_backup': str(backups[-1]) if backups else None,
    }

    run['status'] = 'ok'
    run['finished_at'] = now_iso()
    save_json(RUN_REPORT, run)
    save_json(STATE, {
        'last_run': run['finished_at'],
        'status': run['status'],
        'report': str(RUN_REPORT),
        'canonical': str(CANON),
    })

    print(f"OK deterministic session v1 -> {RUN_REPORT}")


if __name__ == '__main__':
    try:
        main()
    finally:
        close_baselane_tabs()
