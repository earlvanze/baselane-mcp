#!/usr/bin/env python3
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOGIN_WAIT = ROOT / 'baselane_login_and_wait_via_cdp.js'


def main():
    env = os.environ.copy()
    env.setdefault('BASELANE_LOGIN_WAIT_URL', 'https://app.baselane.com/transactions')
    # Compatibility wrapper: old token-capture entrypoint now delegates to the
    # deterministic raw-CDP login-and-wait flow used for UI/model-execution tasks.
    # Callers can override BASELANE_LOGIN_WAIT_MS if they want a longer hold window.
    raise SystemExit(subprocess.call(['node', str(LOGIN_WAIT)], env=env))


if __name__ == '__main__':
    main()
