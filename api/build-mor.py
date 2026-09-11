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

IT READS THE MONTH THROUGH THE API, NEVER POSTGRES. The month comes through the API's own ungated
`month` action and the template out of storage. Generating a report is not filing one: what
Michelle sends to EGLE is this file after she has added her Cover comments and signed it, and
recording THAT is `record_filing` in api/water-ops.js, which takes the bytes she actually sent
rather than the bytes we guessed she would.

⛔ BUT EVERY GENERATION IS NOW RECORDED (2026-09-11). Until today this route handed over the file
and remembered nothing — no row, no bytes, no time, no name. Keith, with the August reminder sent,
the 10th gone by and no way to tell whether the OIC had ever pressed the button: *"If generated
wouldn't the report show at the bottom of the page. Otherwise, we need to tighten this up."* The
Vercel runtime log keeps about a day, so the product could not answer its own most basic question
about its own most important action. Now, after the fill, this route posts the bytes, the stats
and what the workbook says to `record_generation` on api/water-ops.js — authenticated with the
supply's ops code, carrying the browser's session cookie forward so the row names the signed-in
person when there is one. Recording is done here, server-side, and not by the page, so a script
or a curl that generates a month leaves the same trace the button does. If recording fails the
file is still handed over — refusing the OIC her report on the 9th because an audit write failed
would be the wrong failure — but the stats header says `recorded: false` and why, and the page
shows that.

THE EXTRACTOR LIVES HERE TOO (moved from scripts/extract-mor.py, 2026-09-11). `extract` reads a
workbook back into structured data — the Cover tab (who signed, when it went, comments), the
pumpage, the entry-point tabs, the samples. It is the fill map read backwards, and it is used for
two things: what a generated workbook SAYS is stored with the generation, and what the OIC
actually SENT is read out of the file she uploads when she marks a month as filed. One cell map,
one file, both directions — a second copy in a script on a laptop is how a filing recorded from
the wrong cells goes unnoticed.
"""

import base64
import datetime
import io
import json
import os
import re
import tempfile
import urllib.error
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
# ⛔ THE COVER'S MONTH IS THE CELL EGLE READS TO KNOW WHICH PERIOD THIS REPORT COVERS, AND NOTHING
# WROTE IT UNTIL 2026-09-02. It came through from the stored template, which carries `Jul` — so
# every month this product generated said July. It was invisible for exactly one reason: the only
# month ever generated and compared was JULY, where the template's value is correct. The
# byte-for-byte proof on 2026-08-21 and the mor-filings deploy gate both test July.
# Format taken from Michelle's own filed workbooks, not guessed: Cover r11c6 reads 'Jul', 'Apr',
# 'Feb' — a three-letter abbreviation — and r14c6 carries the year as a number.
COVER_MONTH = (11, 6)
COVER_YEAR = (14, 6)

PUMPAGE_ROW0 = 7
EP_ROW0 = 8
DIST_ROW0 = 6
FEED_COL = {'chlorine': 3, 'phosphate': 8, 'fluoride': 13, 'ph_adjust': 18}

# Bacti & Cl Res: the state form splits ROUTINE from REPEAT samples into two fixed blocks, and
# its own formulas name those exact ranges -- COUNTA(K12:K31) is the routine count, and the
# average/min/max residuals are AVERAGE/MIN/MAX(L12:L31,L36:L44). So the block bounds are not a
# guess: writing inside them makes EGLE's own summary cells compute themselves, and writing
# outside them silently drops a sample out of every total on the sheet.
#   routine  Excel 12..31 -> 0-based 11..30 (20 rows)
#   repeat   Excel 36..44 -> 0-based 35..43  (9 rows)
#   B=1 sample location | J=9 date collected | K=10 total coliform result | L=11 free | M=12 total
BACTI_SHEET = 'Bacti & Cl Res'
BACTI_ROUTINE = (11, 20)
BACTI_REPEAT = (35, 9)
BACTI_COLS = (1, 9, 10, 11, 12)
DIST_ROWS = 31          # Excel 7..37
DIST_COLS = (1, 2, 3, 4)

SB_URL = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
SB_KEY = os.environ.get('SUPABASE_SERVICE_KEY') or ''
DATA_ORIGIN = (os.environ.get('MOR_DATA_ORIGIN') or 'https://app.civicscope.io').rstrip('/')
TEMPLATE_BUCKET = 'water-mor-templates'
# The supply access code. Held by no person at the village (Keith, 2026-08-21) — it is the
# credential a SERVER presents to another server, which is exactly what recording a generation is.
OPS_CODE = os.environ.get('WATER_OPS_CODE') or ''
# An uploaded workbook larger than this is not an EGLE MOR (the seven on record are 260–335 KB).
MAX_UPLOAD_BYTES = 3 * 1024 * 1024

# --- the fill map, read BACKWARDS (was scripts/extract-mor.py) ----------------------------------
X_PUMPAGE_ROW0 = 7                                    # Excel 8..38 -> 0-based 7..37, one row per day
X_PUMPAGE_WELL_COL = {1: 1, 2: 2, 3: 3, 4: 4}         # Well N lives in column N
X_EP_ROW0 = 8                                         # Excel 9..39 -> 0-based 8..38
X_EP_COLS = {'mg': 1, 'cl_lbs': 3, 'free': 6, 'total': 7, 'po4_lbs': 8, 'ortho': 12}
X_DIST_ROW0, X_DIST_ROW1 = 6, 37
X_DIST_COLS = {'date': 1, 'free': 2, 'total': 3, 'ortho': 4}
X_BACTI_ROW0, X_BACTI_ROW1 = 11, 31                   # routine samples
X_BACTI_COLS = {'location': 1, 'date': 9, 'result': 10, 'free': 11, 'total': 12}
# The Cover tab is the only place the SUBMISSION itself is recorded — every other tab is data.
# Verified stable across all seven of Centreville's 2026 submittals (48-row Cover, identical map).
X_COVER_CELLS = {
    'supply_name': (8, 1), 'wssn': (8, 6),
    'oic_name': (11, 1), 'classification': (11, 4), 'month_label': (11, 6),
    'oic_cert': (14, 1), 'county': (14, 4), 'year_cell': (14, 6),
    'comment_left': (20, 1), 'comment_right': (20, 4),
    'signed_by': (34, 1), 'submitted_date': (38, 6),
    'submitted_to': (42, 4),
}


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

    def clear_block(name, row0, nrows, cols):
        """Blank a month's data region before writing this month into it.

        WHY THIS HAS TO EXIST, and it is the sharper half of the bacti defect.
        `put()` returns early on None, so any input cell the new month does not supply keeps
        whatever the template holds. On 2026-08-26 the stored template was a FILLED July: rows 12
        and 13 of the Bacti tab held the real 2026-07-29 samples, and generating August without
        clearing produced JULY'S SAMPLES LABELLED AUGUST -- a false regulatory filing rather than
        an incomplete one. The stored template has since been replaced by EGLE's blank
        (manifest source `Blank MOR.xls`; verified 2026-09-11: zero Pumpage, EntryPoint and
        Distribution input cells carry a value). The clearing stays, and now covers EVERY input
        region -- Pumpage and the EntryPoint tabs too (Codex finding 10): a template is data that
        can be re-uploaded, and a rule that depends on a bucket object being blank is not a rule.

        A formula cell is never blanked: EGLE's own COUNTA/AVERAGE/MIN/MAX cells live beside
        the data and are restored from the formula map, so clearing one would delete the
        summary the state reads.
        """
        if name not in sheet_idx:
            return
        have = formulas.get(name, {})
        ws = wb.get_sheet(sheet_idx[name])
        for r in range(row0, row0 + nrows):
            for c in cols:
                if f'{r},{c}' in have:
                    continue
                ws.row(r).set_cell_blank(c, style_at(name, r, c))

    def write_bacti(d):
        """The bacteriological samples -- the half of the MOR that was never written at all.

        `build()` wrote pumpage, entry points and distribution, then saved. `data['bacti']` was
        read only to report `len()` in the stats, which review.html prints beside the download.
        So the product said '2 bacti' while the workbook contained none of them, and the OIC
        could file a report omitting regulatory sample data believing it was included.

        ROUTINE AND REPEAT ARE SEPARATE BLOCKS AND MUST NOT BE MERGED. The form's own formulas
        count them separately -- COUNTA(K12:K31) is the routine count and COUNTA(K36:K44) the
        repeat count -- and a repeat sample written into the routine block would overstate
        routine compliance, which is the number the state checks against the monitoring
        schedule. Residual statistics span both blocks, so both must be populated to be right.

        AND 'other' IS NEITHER (Codex finding 3, 2026-09-11). The schema admits a third kind --
        Centreville's sampling plan lists Well #1/#3/#4 as `bacti_other` sites -- and the default
        branch here wrote it into the ROUTINE block, so one well sample would have counted as a
        routine compliance sample on the state form. EGLE's Bacti tab has a routine block and a
        repeat block and nothing else; a raw-water or investigative sample is not reported on it.
        Those samples are now EXCLUDED from the workbook and COUNTED in the stats
        (`bacti_other_excluded`), so the page says so rather than the form saying something false.
        """
        rows = sorted(d.get('bacti') or [], key=lambda x: (x.get('collected_date') or '',
                                                           x.get('site_name') or ''))
        clear_block(BACTI_SHEET, BACTI_ROUTINE[0], BACTI_ROUTINE[1], BACTI_COLS)
        clear_block(BACTI_SHEET, BACTI_REPEAT[0], BACTI_REPEAT[1], BACTI_COLS)

        buckets = {'routine': list(BACTI_ROUTINE), 'repeat': list(BACTI_REPEAT)}
        used = {'routine': 0, 'repeat': 0, 'other_excluded': 0}
        for smp in rows:
            kind = str(smp.get('sample_kind') or 'routine').lower()
            if kind not in buckets:
                used['other_excluded'] += 1
                continue
            row0, cap = buckets[kind]
            n = used[kind]
            if n >= cap:
                # Refuse rather than drop. A sample silently missing from a filed MOR is the
                # exact failure this function was added to end.
                raise Refuse(409, f'more {kind} bacti samples ({used[kind] + 1}) than the state '
                                  f'form has rows ({cap}). EGLE needs a supplemental sheet for '
                                  'this month; the workbook was not generated.')
            r0 = row0 + n
            used[kind] = n + 1
            dt = str(smp.get('collected_date') or '')
            put(BACTI_SHEET, r0, 1, smp.get('site_name'))
            if len(dt) >= 10:
                put(BACTI_SHEET, r0, 9, f'{int(dt[5:7])}/{int(dt[8:10])}/{dt[:4]}')
            put(BACTI_SHEET, r0, 10, smp.get('result'))
            put(BACTI_SHEET, r0, 11, smp.get('free'))
            put(BACTI_SHEET, r0, 12, smp.get('total'))

        # The lab is a property of the month's sampling, not of the template it inherited.
        lab = next((x.get('lab_name') for x in rows if x.get('lab_name')), None)
        put(BACTI_SHEET, 1, 7, lab)
        return used

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

    # Every input region is blanked before this month is written into it -- Pumpage and the
    # EntryPoint tabs included (Codex finding 10). A day this month has no reading for must be a
    # BLANK cell (EGLE: "do not put 0 in a cell if the pumpage was not checked"), never whatever
    # the template happened to hold.
    clear_block('Pumpage', PUMPAGE_ROW0, 31, range(1, 9))
    for name in [s for s in rb.sheet_names() if s.startswith('EntryPoint')]:
        clear_block(name, EP_ROW0, 31, (1, 3, 6, 7, 8, 12))

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

    # The reporting period. Written before the data so a refusal later cannot leave a workbook
    # that is correctly filled and wrongly labelled.
    put('Cover', COVER_MONTH[0], COVER_MONTH[1], MONTHS[data['month']][:3])
    put('Cover', COVER_YEAR[0], COVER_YEAR[1], data['year'])

    clear_block('Distribution', DIST_ROW0, DIST_ROWS, DIST_COLS)
    for i, s in enumerate(sorted(data['dist'], key=lambda x: x['sample_date'])):
        if i >= DIST_ROWS:
            raise Refuse(409, f"{len(data['dist'])} distribution samples will not fit the state "
                              f'form, which has room for {DIST_ROWS}. File a supplemental sheet.')
        r0 = DIST_ROW0 + i
        d = s['sample_date']
        put('Distribution', r0, 1, f'{int(d[5:7])}/{int(d[8:10])}/{d[:4]}')
        put('Distribution', r0, 2, s.get('free'))
        put('Distribution', r0, 3, s.get('total'))
        put('Distribution', r0, 4, s.get('ortho'))

    bacti_written = write_bacti(data)

    out = io.BytesIO()
    wb.save(out)

    # ⛔ READ THE PERIOD BACK OUT OF THE SAVED FILE AND REFUSE IF IT IS WRONG.
    # Same doctrine as the bacti stats below: report — and here, assert — what REACHED THE
    # WORKBOOK, never what was intended. A mislabelled MOR is a false statement to a state
    # regulator about which month is being reported, and it is the one defect that looks
    # completely normal in every other cell. Cheap: one parse of a ~250 KB file.
    want_month, want_year = MONTHS[data['month']][:3], int(data['year'])
    try:
        back_bk = xlrd.open_workbook(file_contents=out.getvalue())
        back = back_bk.sheet_by_name('Cover')
        got_month = str(back.cell_value(*COVER_MONTH)).strip()
        got_year = int(float(back.cell_value(*COVER_YEAR) or 0))
    except Exception as e:
        raise Refuse(500, f'the generated workbook could not be read back to check its '
                          f'reporting period: {e}')

    # ⛔ AND THE SAMPLE COUNTS — from the saved cells, not from the writer's own counters.
    # `bacti_written` is what this function INTENDED; the Aug 26 review's finding #1 was a
    # workbook that said "2 bacti" in its stats and carried none. The counts the form's own
    # COUNTA formulas will produce are counted here the same way, and a mismatch refuses.
    try:
        bsh = back_bk.sheet_by_name(BACTI_SHEET)
        def _filled(row0, cap):
            return sum(1 for r in range(row0, row0 + cap)
                       if r < bsh.nrows and str(bsh.cell_value(r, 1)).strip()
                       and str(bsh.cell_value(r, 9)).strip())
        back_routine = _filled(*BACTI_ROUTINE)
        back_repeat = _filled(*BACTI_REPEAT)
        dsh = back_bk.sheet_by_name('Distribution')
        back_dist = sum(1 for r in range(DIST_ROW0, DIST_ROW0 + DIST_ROWS)
                        if r < dsh.nrows and str(dsh.cell_value(r, 1)).strip())
    except Exception as e:
        raise Refuse(500, f'the generated workbook could not be read back to check its samples: {e}')
    if (back_routine, back_repeat) != (bacti_written['routine'], bacti_written['repeat']):
        raise Refuse(500, f'the saved workbook carries {back_routine} routine / {back_repeat} repeat '
                          f'bacti rows but {bacti_written["routine"]} / {bacti_written["repeat"]} '
                          'were written; the workbook was not returned.')
    if back_dist != len(data['dist']):
        raise Refuse(500, f'the saved workbook carries {back_dist} distribution rows but '
                          f'{len(data["dist"])} were written; the workbook was not returned.')
    if got_month != want_month or got_year != want_year:
        raise Refuse(500, f'the generated workbook is labelled {got_month} {got_year} but reports '
                          f'{want_month} {want_year}; it was not returned. This is the defect found '
                          f'2026-09-02, when nothing wrote the Cover period and every month '
                          f'inherited the July that sits in the template.')

    # stats report what REACHED THE WORKBOOK, not what was fetched. Reporting len(data['bacti'])
    #    while writing none of it is what let the omission run unnoticed: review.html prints this
    #    count beside the download, so the product asserted '2 bacti' about a file containing zero.
    return out.getvalue(), {'formulas_restored': restored, 'formulas_skipped': skipped,
                            'cover_month': got_month, 'cover_year': got_year,
                            'well_days': len(data['readings']), 'distribution': len(data['dist']),
                            'bacti': bacti_written['routine'] + bacti_written['repeat'],
                            'bacti_routine': bacti_written['routine'],
                            'bacti_repeat': bacti_written['repeat'],
                            # well / raw-water samples the state form has no block for (finding 3)
                            'bacti_other_excluded': bacti_written['other_excluded']}


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
    # The template's INPUT regions must be blank (Codex finding 10). build() now clears them
    # anyway, but a template carrying somebody's month is a template that should never have been
    # uploaded, and the selftest is where that is cheapest to notice.
    dirty = 0
    psh = bk.sheet_by_name('Pumpage')
    dirty += sum(1 for r in range(PUMPAGE_ROW0, PUMPAGE_ROW0 + 31) for c in range(1, 9)
                 if r < psh.nrows and c < psh.ncols and str(psh.cell_value(r, c)).strip())
    for name in [s for s in sheets if s.startswith('EntryPoint')]:
        esh = bk.sheet_by_name(name)
        dirty += sum(1 for r in range(EP_ROW0, EP_ROW0 + 31) for c in (1, 3, 6, 7, 8, 12)
                     if r < esh.nrows and c < esh.ncols and str(esh.cell_value(r, c)).strip())
    dsh = bk.sheet_by_name('Distribution')
    dirty += sum(1 for r in range(DIST_ROW0, DIST_ROW0 + DIST_ROWS)
                 if r < dsh.nrows and str(dsh.cell_value(r, 1)).strip())
    if dirty:
        raise Refuse(500, f'the stored template carries {dirty} filled input cell(s) — it is somebody\'s '
                          'month, not a blank form. Re-upload EGLE\'s blank with scripts/upload-mor-template.mjs')
    out.update({'ok': True, 'template': manifest['key'], 'sheets': len(sheets),
                'formula_cells': cells, 'decrypted': True, 'input_cells_blank': True})
    return out


# ---------------------------------------------------------------------------------------------
# reading a workbook BACK — the fill map in the other direction
# ---------------------------------------------------------------------------------------------
def _num(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace(',', '')
        if re.fullmatch(r'-?\d+(\.\d+)?', s):
            return float(s)
    return None


def _as_date(v, year, month, datemode):
    """A date cell here is one of THREE things and the workbook does not say which: a real Excel
    serial (the first sample of the month, typed as a date), a bare day-of-month (every one after
    it, typed as a number), or TEXT — which is what this generator itself writes (`7/29/2026`,
    build() line "put('Distribution', r0, 1, …)") and what a person typing quickly produces.
    Guessing wrong silently moves a sample by decades, so the numeric cases are separated by
    magnitude and every case is validated against the month.

    ⛔ The text case was missing on 2026-09-11 and the deploy gate caught it on the first run: the
    extractor read the product's OWN July workbook back as 0 distribution samples out of 23. A
    filing recorded from a generation would then have compared "23 held vs 0 filed" — a phantom
    divergence on a compliance record, manufactured by the product disagreeing with itself."""
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        mm = re.fullmatch(r'(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?', s)
        if mm:
            m_, d_, y_ = int(mm.group(1)), int(mm.group(2)), mm.group(3)
            yy = year if y_ is None else (int(y_) + 2000 if len(y_) == 2 else int(y_))
            try:
                return datetime.date(yy, m_, d_).isoformat()
            except ValueError:
                return None
        iso = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})', s)
        if iso:
            try:
                return datetime.date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3))).isoformat()
            except ValueError:
                return None
    n = _num(v)
    if n is None:
        return None
    if n > 1000:
        y, m, d = xlrd.xldate_as_tuple(n, datemode)[:3]
        return f'{y:04d}-{m:02d}-{d:02d}'
    d = int(n)
    if not 1 <= d <= 31:
        return None
    try:
        return datetime.date(year, month, d).isoformat()
    except ValueError:
        return None                      # a "31" on a 30-day month — report nothing, not a lie


def _extract_cover(bk):
    """The Cover tab: who certified this under 1976 PA 399, when it went, and the comments to EGLE.
    `submitted_date` is legitimately blank sometimes — Centreville's January 2026 went out with the
    cell unfilled. An absent date is reported as None and never guessed."""
    if 'Cover' not in bk.sheet_names():
        return {}
    sh = bk.sheet_by_name('Cover')
    raw = {}
    for key, (r, c) in X_COVER_CELLS.items():
        raw[key] = sh.cell_value(r, c) if r < sh.nrows and c < sh.ncols else ''

    def text(k):
        v = raw.get(k)
        if v is None or isinstance(v, float):
            return None if v is None else (str(int(v)) if float(v).is_integer() else str(v))
        s = str(v).strip()
        return s or None

    # The submission date may be an Excel serial OR text somebody typed (R2-4). A text date that
    # cannot be read is reported as UNREADABLE, never as blank: "we do not know when this went"
    # and "the Cover says 9/10/2026 and we could not parse it" are different facts.
    submitted, unreadable = None, None
    sd = raw.get('submitted_date')
    n = _num(sd)
    if n and n > 1000:
        y, m, d = xlrd.xldate_as_tuple(n, bk.datemode)[:3]
        submitted = f'{y:04d}-{m:02d}-{d:02d}'
    elif isinstance(sd, str) and sd.strip():
        submitted = _as_date(sd, 1, 1, bk.datemode) if re.search(r'\d{4}', sd) else None
        if not submitted:
            unreadable = sd.strip()

    comments = ' '.join(x for x in (text('comment_left'), text('comment_right')) if x) or None
    year_cell = _num(raw.get('year_cell'))
    return {
        'supply_name': text('supply_name'), 'wssn': text('wssn'),
        'oic_name': text('oic_name'), 'oic_cert': text('oic_cert'),
        'classification': text('classification'), 'county': text('county'),
        'month_label': text('month_label'),
        'year': int(year_cell) if year_cell else None,
        # The certification-line cell ONLY, never the OIC name substituted for it (Codex finding
        # 8). ⚠ On Centreville's Class D form that line is PRE-PRINTED with the OIC's name in the
        # blank template (verified 2026-09-11), so a name here is the name on the line — not
        # evidence that anybody signed. Whether the report was actually signed and sent is an
        # attestation the signed-in OIC makes when she records the filing, and is recorded as such.
        'signed_by': text('signed_by'),
        'submitted_date': submitted, 'submitted_date_unreadable': unreadable,
        'submitted_to': text('submitted_to'),
        'comments': comments,
    }


def extract_workbook(raw, year, month):
    """Read an EGLE MOR (bytes) back into the structure `water_mor_filings.filed` stores.

    The workbook may or may not still carry Excel's default encryption — a copy re-saved by the
    OIC usually does not — so decrypt() tries both, exactly as it does for the template."""
    plain = decrypt(raw)
    try:
        bk = xlrd.open_workbook(file_contents=plain)
    except Exception as e:
        raise Refuse(400, f'that file is not a readable Excel 97-2003 workbook ({type(e).__name__})')
    dm = bk.datemode
    for need in ('Pumpage', 'Distribution'):
        if need not in bk.sheet_names():
            raise Refuse(400, f'that workbook has no {need} sheet — it is not an EGLE MOR')

    out = {'year': year, 'month': month, 'cover': _extract_cover(bk),
           'pumpage': {}, 'entry_points': {}, 'distribution': [], 'bacti': [], 'notes': []}

    # The caller said one month; the Cover says another. Trust neither silently — a filing
    # recorded against the wrong month is worse than one that refused to load.
    cover_month = (out['cover'] or {}).get('month_label')
    if cover_month:
        cm = next((i for i, nm in enumerate(MONTHS)
                   if nm and nm.lower().startswith(str(cover_month).strip().lower()[:3])), None)
        if cm and cm != month:
            out['notes'].append(f'this is recorded as {MONTHS[month]} but the Cover tab says {cover_month!r}')

    sh = bk.sheet_by_name('Pumpage')
    for i in range(31):
        r = X_PUMPAGE_ROW0 + i
        if r >= sh.nrows:
            break
        day = _num(sh.cell_value(r, 0))
        if not day:
            continue
        per_well = {}
        for well, col in X_PUMPAGE_WELL_COL.items():
            v = _num(sh.cell_value(r, col)) if col < sh.ncols else None
            if v is not None:
                per_well[str(well)] = v
        if per_well:
            out['pumpage'][str(int(day))] = per_well

    for name in [s for s in bk.sheet_names() if s.startswith('EntryPoint')]:
        sh = bk.sheet_by_name(name)
        days = {}
        for i in range(31):
            r = X_EP_ROW0 + i
            if r >= sh.nrows:
                break
            day = _num(sh.cell_value(r, 0))
            if not day:
                continue
            rec = {}
            for k, c in X_EP_COLS.items():
                if c < sh.ncols:
                    v = _num(sh.cell_value(r, c))
                    if v is not None:
                        rec[k] = v
            if rec:
                days[str(int(day))] = rec
        if days:
            out['entry_points'][name] = days

    sh = bk.sheet_by_name('Distribution')
    for r in range(X_DIST_ROW0, min(X_DIST_ROW1, sh.nrows)):
        d = _as_date(sh.cell_value(r, X_DIST_COLS['date']), year, month, dm)
        if not d:
            continue
        rec = {'date': d}
        for k in ('free', 'total', 'ortho'):
            v = _num(sh.cell_value(r, X_DIST_COLS[k]))
            if v is not None:
                rec[k] = v
        if len(rec) > 1:
            out['distribution'].append(rec)

    # Bacti: the record that exists NOWHERE ELSE — not on the Well and Pump Record, absent from
    # July's paper packet entirely. For every other month the workbook is the only copy.
    # BOTH blocks, each row carrying its kind (Codex finding 9): the generator writes routine and
    # repeat samples into separate blocks and the extractor read only the first, so a repeat sample
    # vanished from the filing record while sitting correctly in the workbook.
    if BACTI_SHEET in bk.sheet_names():
        sh = bk.sheet_by_name(BACTI_SHEET)
        out['bacti_required'] = _num(sh.cell_value(3, 0)) if sh.nrows > 3 else None
        out['bacti_taken_stated'] = _num(sh.cell_value(4, 0)) if sh.nrows > 4 else None
        out['lab_name'] = (str(sh.cell_value(1, 7)).strip() or None) if sh.nrows > 1 and sh.ncols > 7 else None
        for kind, (row0, cap) in (('routine', BACTI_ROUTINE), ('repeat', BACTI_REPEAT)):
            for r in range(row0, min(row0 + cap, sh.nrows)):
                loc = str(sh.cell_value(r, X_BACTI_COLS['location'])).strip()
                d = _as_date(sh.cell_value(r, X_BACTI_COLS['date']), year, month, dm)
                if not loc or not d:
                    continue
                rec = {'location': loc, 'date': d, 'kind': kind,
                       'result': str(sh.cell_value(r, X_BACTI_COLS['result'])).strip() or None}
                for k in ('free', 'total'):
                    v = _num(sh.cell_value(r, X_BACTI_COLS[k]))
                    if v is not None:
                        rec[k] = v
                out['bacti'].append(rec)

    # Which EntryPoint is which well? ASSERTED, never assumed: the tabs are numbered 1..3 and
    # Centreville's wells are 1, 3 and 4, so the obvious mapping is wrong by construction.
    out['entry_point_wells'] = {}
    for name, days in out['entry_points'].items():
        scores = {}
        for well in X_PUMPAGE_WELL_COL:
            hits = tot = 0
            for day, rec in days.items():
                mg = rec.get('mg')
                pw = out['pumpage'].get(day, {}).get(str(well))
                if mg is None or pw is None:
                    continue
                tot += 1
                if abs(mg - pw) < 1e-9:
                    hits += 1
            if tot:
                scores[well] = (hits / tot, tot)
        best = max(scores.items(), key=lambda kv: (kv[1][0], kv[1][1]), default=(None, (0, 0)))
        # A tie is UNRESOLVED, not "the first well" (R2-13): two idle wells match each other's
        # zeros perfectly. And a match built only on zeros says nothing — at least one non-zero
        # figure has to agree before the tie-in is asserted.
        tied = best[0] is not None and sum(1 for s in scores.values() if s == best[1]) > 1
        informative = best[0] is not None and any(
            rec.get('mg') and rec.get('mg') > 0
            and abs(rec['mg'] - (out['pumpage'].get(day, {}).get(str(best[0])) or -1)) < 1e-9
            for day, rec in days.items())
        if best[0] is not None and best[1][0] >= 0.9 and not tied and informative:
            out['entry_point_wells'][name] = best[0]
        else:
            out['entry_point_wells'][name] = None
            out['notes'].append(f'{name}: could not tie to a well from its pumpage '
                                f'({"tie" if tied else "no non-zero agreement" if not informative else scores})')
    return out


def extract(body):
    b64 = body.get('workbook_b64')
    if not b64:
        raise Refuse(400, 'workbook_b64 required')
    try:
        raw = base64.b64decode(str(b64), validate=True)
    except Exception:
        raise Refuse(400, 'workbook_b64 is not valid base64')
    if not raw:
        raise Refuse(400, 'workbook_b64 decoded to nothing')
    if len(raw) > MAX_UPLOAD_BYTES:
        raise Refuse(413, f'that file is {len(raw):,d} bytes; an EGLE MOR is a few hundred KB')
    try:
        year, month = int(body.get('year')), int(body.get('month'))
    except (TypeError, ValueError):
        raise Refuse(400, 'year and month required')
    if not (2000 < year < 2100 and 1 <= month <= 12):
        raise Refuse(400, 'year/month out of range')
    return extract_workbook(raw, year, month)


# ---------------------------------------------------------------------------------------------
# recording that a workbook was handed over
# ---------------------------------------------------------------------------------------------
def record_generation(wssn, year, month, xls, name, stats, filed, cookie):
    """Tell api/water-ops.js this workbook left the building. Server-to-server, with the ops code;
    the browser's cookie is forwarded so the row can name the signed-in person. Never raises —
    the caller decides what to do with a failed record, and the answer is "hand over the file
    anyway and say so"."""
    if not OPS_CODE:
        return {'recorded': False, 'why': 'WATER_OPS_CODE is not configured on this deployment'}
    payload = json.dumps({
        'action': 'record_generation', 'wssn': wssn, 'year': year, 'month': month,
        'code': OPS_CODE, 'origin': 'review' if cookie is not None else 'script',
        'workbook_b64': base64.b64encode(xls).decode('ascii'),
        'workbook_name': name, 'stats': stats, 'filed': filed,
    }).encode()
    headers = {'Content-Type': 'application/json'}
    # Only the session cookie travels, never the browser's whole jar (Codex, 2026-09-11): the
    # data origin needs one credential to name the signed-in person, and nothing else it might
    # have been handed.
    if cookie:
        m = re.search(r'(?:^|;\s*)cs_session=([^;]+)', cookie)
        if m:
            headers['Cookie'] = f'cs_session={m.group(1)}'
    try:
        req = urllib.request.Request(f'{DATA_ORIGIN}/api/water-ops', data=payload, headers=headers)
        with urllib.request.urlopen(req, timeout=25) as r:
            j = json.load(r)
        if not j.get('ok'):
            return {'recorded': False, 'why': str(j)[:200]}
        return {'recorded': True, 'generation_id': j.get('id'), 'generated_by': j.get('generated_by')}
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:200]
        try:
            detail = json.loads(detail).get('error', detail)
        except Exception:
            pass
        return {'recorded': False, 'why': f'{e.code}: {detail}'}
    except Exception as e:
        return {'recorded': False, 'why': f'{type(e).__name__}: {e}'[:200]}


def generate(body, cookie=None):
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

    # What the workbook SAYS, read back through the same extractor an uploaded one goes through.
    # Stored with the generation so a filing can be recorded from it without a re-upload. A read
    # failure here is reported, not fatal: the file itself is what she is waiting for.
    try:
        filed = extract_workbook(xls, year, month)
    except Exception as e:
        filed = {'error': f'{type(e).__name__}: {e}'[:200]}
    stats.update(record_generation(wssn, year, month, xls, name, stats, filed, cookie))
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
            if action == 'extract':
                return self._send(200, extract(body))
            if action != 'generate':
                raise Refuse(400, f'unknown action: {action}')
            # The browser's session cookie rides along so the generation is attributed to the
            # signed-in person. None (not '') when no Cookie header came at all — that is how a
            # script's call is told apart from a browser with nobody signed in.
            xls, name, stats = generate(body, cookie=self.headers.get('Cookie'))
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
