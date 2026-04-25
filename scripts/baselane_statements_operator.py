#!/usr/bin/env python3
import argparse
import calendar
import datetime as dt
import os
import re
import shutil
from pathlib import Path

OPENCLAW_ROOT = Path(os.environ.get('OPENCLAW_ROOT', str(Path.home() / '.openclaw')))
if not OPENCLAW_ROOT.exists() and (Path.home() / 'umbrel/app-data/openclaw/home/umbrel/.openclaw').exists():
    OPENCLAW_ROOT = Path.home() / 'umbrel/app-data/openclaw/home/umbrel/.openclaw'
REPO = Path(os.environ.get('WORKSPACE_ROOT', str(OPENCLAW_ROOT / 'workspace')))
DEFAULT_DOWNLOADS = Path(os.environ.get('DOWNLOADS_DIR', str(Path.home() / 'Downloads')))
DEFAULT_RE = Path(os.environ.get('REAL_ESTATE_ROOT', str(REPO / 'Dropbox/Real Estate')))
DEFAULT_PERSONAL = Path(os.environ.get('PERSONAL_ROOT', str(REPO / 'pdf-extracts/personal/Financials/Bank Statements')))
DEFAULT_HOLDINGS = Path(os.environ.get('HOLDINGS_ROOT', str(REPO / 'pdf-extracts/business-holdings/Financials/Bank Statements')))

MONTH_TOKENS = {
    1: 'JAN', 2: 'FEB', 3: 'MAR', 4: 'APR', 5: 'MAY', 6: 'JUN',
    7: 'JUL', 8: 'AUG', 9: 'SEP', 10: 'OCT', 11: 'NOV', 12: 'DEC'
}

# Ordered mapping rules (first match wins)
DEST_RULES = [
    ('22164 UMLAND CIRCLE', 'CA/22164 Umland Cir, Jenner, CA 95450/Public/Financials/Bank Statements/{year}'),
    ('1315 E 114TH ST', 'OH/LFTY0300 1315 E 114th St, Cleveland, OH 44106/Public/Financials/Bank Statements/{year}'),
    ('724 3RD AVE', 'NY/724 3rd Ave Public/Financials/Bank Statements/{year}'),
    ('88 MADISON AVE', 'NY/88 Madison Ave Albany, NY 12202/Financials/Bank Statements/{year}'),
    ('86 MADISON AVE', 'NY/86 Madison Ave Albany, NY 12202/Financials/Bank Statements/{year}'),
    ('84 MADISON AVE', 'NY/84 Madison Ave Albany, NY 12202/Financials/Bank Statements/{year}'),
    ('90 MADISON AVE', 'NY/90 Madison Ave Albany, NY 12202/Financials/Bank Statements/{year}'),
    ('1321 ALLENDALE AVE', 'OH/LFTY0123 Ohio 3-Property Package/Public/1321 Allendale Ave, Akron, OH 44306/Financials/Bank Statements/{year}'),
    ('1518 DILLE RD', 'OH/APG/1518 Dille Rd/Public/Financials/Bank Statements/{year}'),
    ('OHIO-3 SECURITY DEPOSITS', 'OH/APG/1518 Dille Rd/Public/Financials/Bank Statements/{year}'),
    ('566 NASH ST', 'OH/566 Nash St, Akron, OH 44306/Public/Financials/Bank Statements/{year}'),
    ('566 SECURITY DEPOSITS', 'OH/566 Nash St, Akron, OH 44306/Public/Financials/Bank Statements/{year}'),
    ('254 BOWMANVILLE', 'OH/LFTY0134 254 Bowmanville St, Akron, OH 44305/Public/Financials/Bank Statements/{year}'),
    ('1278 E 187TH ST', 'OH/LFTY0094 1278 E 187th St, Cleveland, OH 44110/Public/Financials/Bank Statements/{year}'),
    ('1278 SECURITY DEPOSITS', 'OH/LFTY0094 1278 E 187th St, Cleveland, OH 44110/Public/Financials/Bank Statements/{year}'),
    ('1432 SARA AVE', 'OH/LFTY0130 1432 Sara Ave, Akron, Ohio 44305/Public/Financials/Bank Statements/{year}'),
    ('15555 MILLARD AVE', 'IL/15555 Millard Ave, Markham, IL 60428/Public/Financials/Bank Statements/{year}'),
    ('25 CIRCLE DR', 'IL/LFTY0065 25 Circle Dr, Dixmoor, IL 60426/Public/Financials/Bank Statements/{year}'),
    ('428 CROSS ST', 'OH/LFTY0095 428 Cross St, Akron, OH 44311/Public/Financials/Bank Statements/{year}'),
    ('428 SECURITY DEPOSITS', 'OH/LFTY0095 428 Cross St, Akron, OH 44311/Public/Financials/Bank Statements/{year}'),
    ('5401 ODOM AVE', 'TX/LFTY0142 5401 Odom Ave Fort Worth, TX 76114/Public/Financials/Bank Statements/{year}'),
    ('5541 S PEORIA ST', 'IL/LFTY0062 5541 S Peoria St, Chicago, IL 60621/Public/Financials/Bank Statements/{year}'),
    ('7542 & 7656 S COLFAX AVE', 'IL/LFTY0096 7542 and 7656 S Colfax Ave, Chicago, IL 60649/Public/Financials/Bank Statements/{year}'),
    ('8143 S SANGAMON ST', 'IL/LFTY0059 8143 S Sangamon St, Chicago, IL 60620/Public/Financials/Bank Statements/{year}'),
    ('918 FREDERICK BLVD', 'OH/918 Frederick Blvd, Akron, OH 44320/Public/Financials/Bank Statements/{year}'),
    ('918 SECURITY DEPOSITS', 'OH/918 Frederick Blvd, Akron, OH 44320/Public/Financials/Bank Statements/{year}'),
    ('9634 S GREEN ST', 'IL/LFTY0011 9634 S Green St, Chicago, IL 60643/Public/Financials/Bank Statements/{year}'),
    ('9902 GARFIELD AVE', 'OH/LFTY0128 9902 Garfield Ave, Cleveland, OH, 44108/Public/Financials/Bank Statements/{year}'),
    ('9919 S OGLESBY AVE', 'IL/LFTY0054 9919 S Oglesby Ave, Chicago, IL 60617/Public/Financials/Bank Statements/{year}'),
    ('326-332 S ALCOTT', 'CO/326-332 S Alcott St Denver, CO 80219/Public/Financials/Bank Statements/{year}'),
    ('85-104 ALAWA PL', 'HI/85-104 Alawa Pl Public/Financials/Bank Statements/{year}'),
    ('9 COUNTRY CLUB LN', 'NY/9 Country Club Ln N Public/Financials/Bank Statements/{year}'),
    ('804 S QUITMAN ST', 'CO/804 S Quitman St. Denver, CO 80219/Public/Financials/Bank Statements/{year}'),
]


def normalize_name(name: str) -> str:
    s = re.sub(r' \(\d+\)\.pdf$', '.pdf', name, flags=re.I)
    s = re.sub(r'\.\d{8}-\d{6}\.pdf$', '.pdf', s, flags=re.I)
    return s


def resolve_dest(base: Path, filename: str, year: int):
    up = filename.upper()
    for key, rel in DEST_RULES:
        if key in up:
            return base / rel.format(year=year)
    return None


def list_matching_files(root: Path, month_tok: str, year: int):
    pat = f'*DAO LLC*_{month_tok}_{year}_STATEMENT*.pdf'
    return [p for p in root.rglob(pat)]


def move_downloads(downloads: Path, re_base: Path, month_tok: str, year: int):
    moved = []
    unmapped = []
    for p in downloads.glob(f'BASELANE_*DAO LLC*_{month_tok}_{year}_STATEMENT*.pdf'):
        dest_dir = resolve_dest(re_base, p.name, year)
        if not dest_dir:
            unmapped.append(p)
            continue
        dest_dir.mkdir(parents=True, exist_ok=True)
        target = dest_dir / p.name
        if target.exists():
            if target.stat().st_size == p.stat().st_size:
                p.unlink()
                moved.append(target)
                continue
            ts = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
            target = dest_dir / f'{p.stem}.{ts}.pdf'
        shutil.move(str(p), str(target))
        moved.append(target)
    return moved, unmapped


def move_non_property(downloads: Path, month_tok: str, year: int, personal_base: Path, holdings_base: Path):
    personal = []
    holdings = []
    for p in downloads.glob(f'BASELANE_*_{month_tok}_{year}_STATEMENT*.pdf'):
        up = p.name.upper()
        if 'DAO LLC' in up:
            continue
        if any(x in up for x in ['EVCO ', 'NARWALL ']):
            dest_dir = holdings_base / str(year)
            dest_dir.mkdir(parents=True, exist_ok=True)
            target = dest_dir / p.name
            if target.exists():
                if target.stat().st_size == p.stat().st_size:
                    p.unlink()
                    holdings.append(target)
                    continue
                ts = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
                target = dest_dir / f'{p.stem}.{ts}.pdf'
            shutil.move(str(p), str(target))
            holdings.append(target)
            continue
        if any(x in up for x in ['EARL VANZE CO', 'EARLDAO', 'ECO SYSTEMS, LLC']):
            dest_dir = personal_base / str(year)
            dest_dir.mkdir(parents=True, exist_ok=True)
            target = dest_dir / p.name
            if target.exists():
                if target.stat().st_size == p.stat().st_size:
                    p.unlink()
                    personal.append(target)
                    continue
                ts = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
                target = dest_dir / f'{p.stem}.{ts}.pdf'
            shutil.move(str(p), str(target))
            personal.append(target)
    return personal, holdings


def read_manifest(path: Path):
    if not path or not path.exists():
        return None
    lines = [x.strip() for x in path.read_text(encoding='utf-8').splitlines() if x.strip() and not x.strip().startswith('#')]
    return set(lines)


def emit_js(path: Path, missing: set[str], year: int, month: int):
    start = dt.date(year, month, 1)
    end_day = calendar.monthrange(year, month)[1]
    month_name = start.strftime('%b')
    period = f'{month_name} 1 - {month_name} {end_day}, {year}'
    arr = ',\n  '.join(repr(x) for x in sorted(missing))
    js = f"""// Paste this in Baselane statements page console.
(async () => {{
  const missing = new Set([\n  {arr}\n  ]);
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
  const period = {period!r};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const p = [...document.querySelectorAll('p')].find(x => norm(x.textContent) === period);
  const c = p?.parentElement?.parentElement;
  if (!c) return console.log('Period not found:', period);
  const kids = [...c.children];
  let clicked = 0;
  for (let i = 0; i + 2 < kids.length; i += 3) {{
    const acctDiv = kids[i], perDiv = kids[i+1], btnWrap = kids[i+2];
    const per = norm(perDiv.textContent);
    const ps = [...acctDiv.querySelectorAll('p')].map(p => norm(p.textContent)).filter(Boolean);
    const l1 = (ps[0] || norm(acctDiv.textContent)).toUpperCase();
    const l2 = (ps[1] || '').toUpperCase();
    if (!(l1 + ' ' + l2).includes('DAO LLC') || per !== period) continue;
    const expected = `BASELANE_${{l1}}_${{l2}}_{MONTH}_{YEAR}_STATEMENT.pdf`
      .replace('{MONTH}', '{MONTH}'.replace('{MONTH}', '{MONTH}'));
  }}
}})();
"""
    # Simpler robust template with direct formatting
    js = js.replace('{MONTH}', MONTH_TOKENS[month]).replace('{YEAR}', str(year))
    path.write_text(js, encoding='utf-8')


def main():
    ap = argparse.ArgumentParser(description='Baselane statements operator helper (move/status/missing)')
    ap.add_argument('--year', type=int, required=True)
    ap.add_argument('--month', type=int, required=True, help='1-12')
    ap.add_argument('--downloads', type=Path, default=DEFAULT_DOWNLOADS)
    ap.add_argument('--real-estate', type=Path, default=DEFAULT_RE)
    ap.add_argument('--personal', type=Path, default=DEFAULT_PERSONAL)
    ap.add_argument('--holdings', type=Path, default=DEFAULT_HOLDINGS)
    ap.add_argument('--manifest', type=Path, default=None, help='Text file of expected canonical filenames')
    args = ap.parse_args()

    month_tok = MONTH_TOKENS[args.month]

    moved, unmapped = move_downloads(args.downloads, args.real_estate, month_tok, args.year)
    personal, holdings = move_non_property(args.downloads, month_tok, args.year, args.personal, args.holdings)
    existing = list_matching_files(args.real_estate, month_tok, args.year)
    canon = {normalize_name(p.name) for p in existing}

    print(f'MOVED={len(moved)} PERSONAL={len(personal)} HOLDINGS={len(holdings)} UNMAPPED={len(unmapped)} CAPTURED_UNIQUE={len(canon)}')
    for p in moved:
        print(f'OK\t{p}')
    for p in personal:
        print(f'PERSONAL\t{p}')
    for p in holdings:
        print(f'HOLDINGS\t{p}')
    for p in unmapped:
        print(f'UNMAPPED\t{p.name}')

    manifest = read_manifest(args.manifest) if args.manifest else None
    if manifest is not None:
        missing = sorted(manifest - canon)
        print(f'MANIFEST_TOTAL={len(manifest)} MISSING={len(missing)}')
        for m in missing:
            print(f'MISS\t{m}')


if __name__ == '__main__':
    main()
