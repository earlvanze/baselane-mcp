#!/usr/bin/env python3
import subprocess
from pathlib import Path

ROOT = Path('/home/umbrel/.openclaw/workspace')
SESSION_SCRIPT = ROOT / 'scripts' / 'baselane_deterministic_session_v1.py'
PY = ROOT / '.venv-playwright' / 'bin' / 'python'


def main():
    # Compatibility wrapper: old entrypoint now delegates to the proven
    # deterministic raw-CDP session/export pipeline.
    raise SystemExit(subprocess.call([str(PY), str(SESSION_SCRIPT)]))


if __name__ == '__main__':
    main()
