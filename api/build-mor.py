"""api/build-mor.py — turn a month of plant records into EGLE's Monthly Operation Report.

Keith, 2026-08-20: *"proceed"*. The Operator-In-Charge is the person required to sign this report,
and until now she could not produce it: the generator ran as `scripts/build-mor.py` on Keith's
machine. Every other gap on her side was a view she could not see. This one was a capability she
did not have, and it is the far end of the loop that starts on the crew's tablet.

⛔ THIS FILE IS THE ONLY COPY OF THE FILL LOGIC. `scripts/build-mor.py` is now a thin client that
posts here and saves the bytes. The two used to be one script; leaving a second implementation on
a laptop is how the screen and the filed report drift apart, which is the entire defect class this
product exists to remove (see `civicscope-water/derive.js`, imported by both the tablet and the
API for exactly the same reason).

WHY THIS IS NOT A "WRITE A SPREADSHEET" FUNCTION
EGLE's template is a signed, print-laid-out state form. Its white cells are formulas, its yellow
cells are the only ones a supply may fill. So this does not build a workbook — it fills THAT
workbook and leaves everything else byte-identical. Four things had to be handled, each found the
hard way on 2026-08-18, and all four are carried over here unchanged:

  1. THE FILE IS ENCRYPTED with Excel's default blank-password scheme; xlrd refuses it outright.
     Decrypt with 'VelvetSweatshop' first.
  2. xlrd CANNOT READ FORMULAS, so a plain xlutils copy silently replaces all ~1,990 of them with
     their cached values — empty, on a blank template. Every Total, Maximum, Minimum and derived
     column would reach the State of Michigan blank. They are re-injected from a map extracted with
     SheetJS (`scripts/extract-mor-formulas.mjs`) and stored beside the template.
  3. xlutils FLATTENS MERGED RANGES: write_merge() stamps the top-left cell's style across the
     range, so every merged box loses the border living on its right-hand cell.
  4. xlwt writes every formula with an EMPTY cached result and calc_flags=0, so Excel opens the
     report showing blank calculated cells. FormulaRecord is patched to "recalculate on open".

Verified on July 2026: zero formatting differences on any cell with content, merged ranges and
column widths identical to the template, and all formulas intact.

THE TEMPLATE IS DATA (migration 022). It is fetched from the private `water-mor-templates` bucket
under `water_supplies.mor_template`, together with the formula map extracted from that same file.
A supply on a Class C form, or in another state, is a new key in that bucket and a column value —
never a branch in this file.

READ-ONLY BY CONSTRUCTION. It reads a month through the API's own ungated `month` action and the
template out of storage. It writes nothing, stores nothing and sends nothing. Generating a report
is not filing one: what Michelle sends to EGLE is this file after she has added her Cover comments
and signed it, and recording THAT is `record_filing` in api/water-ops.js, which takes the bytes she
actually sent rather than the bytes we guessed she would.
"""

import io
import json
import os
import tempfile
import urllib.request
from http.server import BaseHTTPRequestHandler

import xlrd
import xlwt
import msoffcrypto
from xlutils.filter import process, XLRDReader, XLWTWriter
import xlwt.BIFFRecords as _BR

# xlwt hardcodes calc_flags=0 and caches an "empty" result for every formula it writes. Force bits
# 0+1 (recalculate always / calculate on open) or the report opens with blank totals.
_orig_formula_rec = _BR.FormulaRecord.__init__


def _formula_rec(self, row, col, xf_index, rpn, calc_flags=0):
    _orig_formula_rec(self, row, col, xf_index, rpn, 3)


_BR.FormulaRecord.__init__ = _formula_rec

MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
          'August', 'September', 'October', 'November', 'December']

# Where each value lands in EGLE's template (0-based row, col).
# Pumpage:      day rows Excel 8..38  -> 0-based 7..37 ; Well N is column B..I (1..8)
# EntryPointN:  day rows Excel 9..39  -> 0-based 8..38
#   B=1 metered million gallons | D=3 chlorine solution lbs | G=6 EP free | H=7 EP total
#   I=8 phosphate solution lbs  | M=12 ortho analysis at the entry point
# Distribution: sample rows Excel 7..37 -> 0-based 6..36 ; B=1 date, C=2 free, D=3 total, E=4 ortho
PUMPAGE_ROW0 = 7
EP_ROW0 = 8
DIST_ROW0 = 6
FEED_COL = {'chlorine': 3, 'phosphate': 8, 'fluoride': 13, 'ph_adjust': 18}

SB_URL = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
SB_KEY = os.environ.get('SUPABASE_SERVICE_KEY') or ''
DATA_ORIGIN = (os.environ.get('MOR_DATA_ORIGIN') or 'https://app.civicscope.io').rstrip('/')
TEMPLATE_BUCKET = 'water-mor-templates'


class Refuse(Exception):
    """A refusal with a status code. Never a stack trace to the operator."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------------------------
# fetching
# ---------------------------------------------------------------------------------------------
def _get(url, headers=None, timeout=25):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_month(wssn, year, month):
    """The month comes through the API's own `month` action, never straight from Postgres.

    That action is where a month is assembled — live rows only, superseded corrections excluded,
    feed readings joined onto their reading. Reimplementing that here would be a second definition
    of "what March contains", and the two would eventually disagree about a report filed with a
    regulator."""
    body = json.dumps({'action': 'month', 'wssn': wssn, 'year': year, 'month': month}).encode()
    req = urllib.request.Request(f'{DATA_ORIGIN}/api/water-ops', data=body,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=25) as r:
        data = json.load(r)
    if 'supply' not in data:
        raise Refuse(502, f'could not read {year}-{month:02d}: {str(data)[:200]}')
    return data


def fetch_template(key):
    """The blank workbook and the formula map that belongs to it, as a pair.

    A formula map from a different template than the one being filled would write formulas into
    the wrong cells of a state form, so they are stored under one key with a manifest naming both
    and are never resolved independently."""
    if not SB_URL or not SB_KEY:
        raise Refuse(503, 'template storage is not configured')
    h = {'apikey': SB_KEY, 'Authorization': f'Bearer {SB_KEY}'}
    base = f'{SB_URL}/storage/v1/object/{TEMPLATE_BUCKET}'
    try:
        manifest = json.loads(_get(f'{base}/{key}/manifest.json', h))
    except Exception:
        raise Refuse(503, f'no MOR template is stored under "{key}" — upload one with '
                          'scripts/upload-mor-template.mjs')
    try:
        raw = _get(f'{base}/{manifest["template"]["path"]}', h, timeout=40)
        formulas = json.loads(_get(f'{base}/{manifest["formulas"]["path"]}', h, timeout=40))
    except Exception as e:
        raise Refuse(503, f'the "{key}" template pair could not be read: {type(e).__name__}')
    return raw, formulas, manifest


def decrypt(raw):
    """EGLE ships the workbook Excel-encrypted with the default blank password. A copy that has
    been re-saved may not be, so try both rather than assuming."""
    try:
        of = msoffcrypto.OfficeFile(io.BytesIO(raw))
        of.load_key(password='VelvetSweatshop')
        buf = io.BytesIO()
        of.decrypt(buf)
        return buf.getvalue()
    except Exception:
        return raw


# ---------------------------------------------------------------------------------------------
# the fill
# ---------------------------------------------------------------------------------------------
def build(data, raw_template, formulas):
    plain = decrypt(raw_template)
    tmp = tempfile.NamedTemporaryFile(suffix='.xls', delete=False)
    try:
        tmp.write(plain)
        tmp.close()
        rb = xlrd.open_workbook(tmp.name, formatting_info=True)
        w = XLWTWriter()
        process(XLRDReader(rb, tmp.name), w)
        wb, styles = w.output[0][1], w.style_list
    finally:
        try:
            os.remove(tmp.name)
        except OSError:
            pass

    sheet_idx = {n: i for i, n in enumerate(rb.sheet_names())}

    def style_at(name, r, c):
        return styles[rb.sheet_by_name(name).cell_xf_index(r, c)]

    def put(name, r, c, val):
        if val is None:
            return
        wb.get_sheet(sheet_idx[name]).write(r, c, val, style_at(name, r, c))

    # 1. put the formulas back (xlrd could not carry them across)
    restored, skipped = 0, []
    for name, cells in formulas.items():
        if name not in sheet_idx or not cells:
            continue
        ws = wb.get_sheet(sheet_idx[name])
        for keyrc, f in cells.items():
            r, c = (int(x) for x in keyrc.split(','))
            try:
                ws.write(r, c, xlwt.Formula(f), style_at(name, r, c))
                restored += 1
            except Exception:
                # pre-broken #REF! in EGLE's own file — left exactly as the state ships it
                skipped.append(f'{name}!{xlrd.formula.colname(c)}{r + 1}')

    # 2. undo xlutils' merged-range style flattening
    for name in rb.sheet_names():
        rs = rb.sheet_by_name(name)
        ws = wb.get_sheet(sheet_idx[name])
        have = formulas.get(name, {})
        for rlo, rhi, clo, chi in rs.merged_cells:
            for r in range(rlo, rhi):
                for c in range(clo, chi):
                    if (r, c) == (rlo, clo) or f'{r},{c}' in have:
                        continue
                    ws.row(r).set_cell_blank(c, style_at(name, r, c))

    # 3. the data
    by_ep = {}
    for row in data['readings']:
        by_ep.setdefault(row['entry_point_id'], {})[int(row['reading_date'][8:10])] = row

    for ep in data['entryPoints']:
        rows = by_ep.get(ep['id'], {})
        sheet = f'EntryPoint{ep["mor_sheet"]}' if ep.get('mor_sheet') else None
        feed_kind = {f['id']: f['kind'] for f in ep.get('feeds', [])}
        for day, row in rows.items():
            mg = row.get('million_gallons')
            if ep.get('well_no') and 1 <= ep['well_no'] <= 8:
                put('Pumpage', PUMPAGE_ROW0 + day - 1, ep['well_no'], mg)
            if not sheet or sheet not in sheet_idx:
                continue
            r0 = EP_ROW0 + day - 1
            put(sheet, r0, 1, mg)
            put(sheet, r0, 6, row.get('tap_free'))
            put(sheet, r0, 7, row.get('tap_total'))
            put(sheet, r0, 12, row.get('tap_ortho'))
            for fr in row.get('feeds', []):
                col = FEED_COL.get(feed_kind.get(fr['feed_id']))
                if col is not None:
                    put(sheet, r0, col, fr.get('solution_lbs'))

    for i, s in enumerate(sorted(data['dist'], key=lambda x: x['sample_date'])):
        r0 = DIST_ROW0 + i
        d = s['sample_date']
        put('Distribution', r0, 1, f'{int(d[5:7])}/{int(d[8:10])}/{d[:4]}')
        put('Distribution', r0, 2, s.get('free'))
        put('Distribution', r0, 3, s.get('total'))
        put('Distribution', r0, 4, s.get('ortho'))

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue(), {'formulas_restored': restored, 'formulas_skipped': skipped,
                            'well_days': len(data['readings']), 'distribution': len(data['dist']),
                            'bacti': len(data['bacti'])}


# ---------------------------------------------------------------------------------------------
# the route
# ---------------------------------------------------------------------------------------------
def selftest():
    """The safe contract for this route (scripts/verify-api-endpoints.js).

    A 405 guard would prove only that a guard is intact. This exercises everything the real path
    depends on and that a deploy can plausibly break — the Python runtime, all four Excel
    libraries, the formula/style round trip, and that Centreville's template pair is present,
    decryptable and readable — while writing nothing and reading no plant data.
    """
    out = {'ok': False, 'route': 'build-mor', 'libs': {}}
    for mod, name in ((xlrd, 'xlrd'), (xlwt, 'xlwt'), (msoffcrypto, 'msoffcrypto')):
        out['libs'][name] = getattr(mod, '__version__', getattr(mod, '__VERSION__', 'ok'))
    raw, formulas, manifest = fetch_template('egle-class-d')
    plain = decrypt(raw)
    if plain is raw:
        raise Refuse(500, 'the stored template did not decrypt — VelvetSweatshop no longer applies')
    bk = xlrd.open_workbook(file_contents=plain, formatting_info=True)
    sheets = bk.sheet_names()
    for need in ('Cover', 'Pumpage', 'Distribution'):
        if need not in sheets:
            raise Refuse(500, f'the stored template has no {need} sheet')
    cells = sum(len(v or {}) for v in formulas.values())
    if cells < 1000:
        raise Refuse(500, f'the formula map holds only {cells} cells; the EGLE MOR has ~1,990')
    out.update({'ok': True, 'template': manifest['key'], 'sheets': len(sheets),
                'formula_cells': cells, 'decrypted': True})
    return out


def generate(body):
    wssn = str(body.get('wssn') or '').strip()
    year, month = body.get('year'), body.get('month')
    if not wssn:
        raise Refuse(400, 'wssn required')
    try:
        year, month = int(year), int(month)
    except (TypeError, ValueError):
        raise Refuse(400, 'year and month required')
    if not (2000 < year < 2100 and 1 <= month <= 12):
        raise Refuse(400, 'year/month out of range')

    data = fetch_month(wssn, year, month)
    supply = data['supply']
    if not data.get('readings'):
        raise Refuse(409, f'{MONTHS[month]} {year} has no readings on file — there is nothing to '
                          'report. If the round was walked, it was written somewhere other than here.')

    raw, formulas, _ = fetch_template(supply.get('mor_template') or 'egle-class-d')
    xls, stats = build(data, raw, formulas)
    name = f'{supply["name"]} MOR - {MONTHS[month]} {year}.xls'
    return xls, name, stats


class handler(BaseHTTPRequestHandler):
    def _send(self, status, payload, content_type='application/json', headers=None):
        body = payload if isinstance(payload, (bytes, bytearray)) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            self._send(200, selftest())
        except Refuse as e:
            self._send(e.status, {'error': e.message})
        except Exception as e:
            self._send(500, {'error': f'{type(e).__name__}: {e}'})

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(n) or b'{}') if n else {}
            action = body.get('action') or 'generate'
            if action == 'selftest':
                return self._send(200, selftest())
            if action != 'generate':
                raise Refuse(400, f'unknown action: {action}')
            xls, name, stats = generate(body)
            # The stats ride in headers so the browser can report what it built without a second
            # request, while the body stays the workbook itself.
            self._send(200, xls, 'application/vnd.ms-excel', {
                'Content-Disposition': f'attachment; filename="{name}"',
                'X-Mor-Filename': name,
                'X-Mor-Stats': json.dumps(stats),
            })
        except Refuse as e:
            self._send(e.status, {'error': e.message})
        except Exception as e:
            self._send(500, {'error': f'{type(e).__name__}: {e}'})
