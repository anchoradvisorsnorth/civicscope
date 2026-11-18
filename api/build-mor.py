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

import struct
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

# ⛔ #VALUE! ON EP SUMMARY (Keith and Michelle, 2026-10-08, the first month generated by the OIC).
# xlwt 1.3.0 encodes every cell reference as VALUE class, even as a direct argument of MIN / MAX /
# AVERAGE / SUM / COUNTA / COUNTBLANK. Excel then dereferences the cell, and an idle well's "" dose
# becomes a TEXT argument to MIN -> #VALUE! on that day's row of the EP Summary. Excel writes those
# arguments as REFERENCE class (0x3A), so MIN skips the text — which is why Michelle's own workbooks
# never showed it. Proven against her Excel-saved August workbook: operand classes of all 800
# comparable formulas identical to Excel's after this repair, 0 of 800 before.

# function index -> which argument positions (0-based) take a reference; None = all of them
_REF_ARGS = {4: None, 5: None, 6: None, 7: None, 169: None, 347: None,   # SUM AVERAGE MIN MAX COUNTA COUNTBLANK
             29: {0}, 64: {1},                                           # INDEX(array,..) MATCH(x, array, ..)
             1: {1, 2}}                                                  # IF(test, then, else): Excel writes then/else as references
_FIXED_ARGC = {347: 1}   # COUNTBLANK is a fixed-arity ptgFunc; everything else here is ptgFuncVar
_REF_TOKENS = {0x24: 5, 0x25: 9, 0x3A: 7, 0x3B: 11}   # ref, area, ref3d, area3d (R-class base ids)


def _size(rpn, i):
    t = rpn[i]
    if 0x03 <= t <= 0x16: return 1
    if t == 0x17:
        cch, flg = rpn[i + 1], rpn[i + 2]
        return 3 + cch * (2 if flg & 1 else 1)
    if t == 0x19:
        g = rpn[i + 1]
        if g & 0x04: return 4 + 2 * (struct.unpack_from('<H', rpn, i + 2)[0] + 1)
        return 4
    if t in (0x1C, 0x1D): return 2
    if t == 0x1E: return 3
    if t == 0x1F: return 9
    base = t & 0x9F if t & 0x60 else t
    base = (t & 0x1F) | 0x20
    sizes = {0x20: 8, 0x21: 3, 0x22: 4, 0x23: 5, 0x24: 5, 0x25: 9, 0x2A: 5, 0x2B: 9, 0x2C: 5, 0x2D: 9,
             0x39: 7, 0x3A: 7, 0x3B: 11, 0x3C: 7, 0x3D: 11}
    if 0x20 <= t <= 0x7F and base in sizes: return sizes[base]
    raise ValueError(f'unknown token 0x{t:02x}')


def fix_ref_classes(rpn):
    try:
        out = bytearray(rpn)
        stack = []   # each operand: index of its single ref token, or None
        i = 0
        while i < len(rpn):
            t = rpn[i]; n = _size(rpn, i)
            base = (t & 0x1F) | 0x20 if 0x20 <= t <= 0x7F else t
            if 0x03 <= t <= 0x11:            # binary operators
                stack.pop(); stack.pop(); stack.append(None)
            elif t in (0x12, 0x13, 0x14):    # unary
                stack.pop(); stack.append(None)
            elif t == 0x15:                  # paren: no stack effect
                pass
            elif t == 0x19:
                if rpn[i + 1] & 0x10:        # tAttrSum = SUM(one arg)
                    stack.pop(); stack.append(None)
            elif t in (0x16, 0x17, 0x1C, 0x1D, 0x1E, 0x1F):
                stack.append(None)
            elif base in (0x21, 0x22):
                if base == 0x22:
                    argc = rpn[i + 1] & 0x7F; fn = struct.unpack_from('<H', rpn, i + 2)[0] & 0x7FFF
                else:
                    fn = struct.unpack_from('<H', rpn, i + 1)[0]
                    if fn not in _FIXED_ARGC: return rpn   # a fixed function we do not know the arity of
                    argc = _FIXED_ARGC[fn]
                args = stack[-argc:] if argc else []
                del stack[len(stack) - argc:]
                if fn in _REF_ARGS:
                    want = _REF_ARGS[fn]
                    for pos, ref_at in enumerate(args):
                        if ref_at is not None and (want is None or pos in want):
                            out[ref_at] = (out[ref_at] & 0x9F) | 0x20     # class bits -> REFERENCE
                if (t & 0x60) == 0x20 and fn != 29:
                    # a function's result is a VALUE, as Excel writes it — except INDEX, which returns a
                    # reference and which Excel leaves reference-class (IF(...,INDEX(..)) on Pumpage)
                    out[i] = (t & 0x9F) | 0x40
                stack.append(None)
            elif base in _REF_TOKENS:
                stack.append(i)
            elif 0x20 <= t <= 0x7F:
                stack.append(None)
            else:
                return rpn
            i += n
        return bytes(out) if len(stack) == 1 else rpn
    except Exception:
        return rpn

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
#   other    Excel 49..57 -> 0-based 48..56  (9 rows) — "Other: well samples, entry point (plant tap),
#            samples following construction/repair, etc." Outside the residual formulas on purpose:
#            a raw-water sample carries no distribution residual and is not a routine compliance count.
BACTI_OTHER = (48, 9)
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

# --- TEMPLATE KINDS (2026-11-17, new-town build) ------------------------------------------------
# A template's manifest may carry `kind`. ABSENT = the legacy path: the first customer's own blank,
# filled exactly as before this change, byte for byte (scripts/verify-mor-build-identity.py proves
# it against the pre-change file). The two new kinds:
#   'state'  — EGLE's shared, clean blank. Its Cover identity cells are EMPTY; build() writes the
#              supply's own details onto it, and each entry point's chemical strengths onto row 6.
#   'supply' — a town's own uploaded blank, identity pre-printed. Nothing extra is written; its
#              Cover must name the town, and any field that differs from the stored supply record
#              is reported (stats.cover_differences), not refused.
TEMPLATE_KINDS = ('state', 'supply')
# The shared state blank's storage key. Reported (never required) by the selftest.
STATE_TEMPLATE_KEY = os.environ.get('MOR_STATE_TEMPLATE_KEY') or 'egle-state'
# Cover field (X_COVER_CELLS) <- water_supplies column. The certification line (signed_by <-
# cover_signed_by) is handled apart: written only when the supply has it set.
COVER_FROM_SUPPLY = (('supply_name', 'name'), ('wssn', 'wssn'), ('oic_name', 'oic_name'),
                     ('classification', 'classification'), ('oic_cert', 'oic_cert'),
                     ('county', 'county'), ('submitted_to', 'report_to_email'))
COVER_REQUIRED = (('name', 'supply name'), ('wssn', 'water system number (WSSN)'),
                  ('oic_name', "operator-in-charge's name"))
# CHEMICAL STRENGTH, EntryPoint row 6 (0-based row 5). Each strength sits above its own feed's
# data column (FEED_COL): D6 chlorine, I6 phosphate, N6 fluoride, S6 pH adjustment; L6 is the
# phosphate's ortho factor. The form's formulas read them as FRACTIONS, never percent:
# E9 = D9*D$6 (pounds of solution -> pounds available) and F9 = E9/C9 with C9 = B9*8.34, which is
# derive.js's `solution_lbs * avail_fraction / (million_gallons * 8.34)`; L9 = K9*$L$6 is
# `dose * ortho_factor`. migrations/010_water_ops.sql records the first customer's own cells:
# D6 = 0.125 (12.5% hypochlorite), I6 = 0.25, L6 = 0.1 — the same numbers as water_feeds.
# Set False to leave row 6 exactly as the state blank holds it.
WRITE_FEED_STRENGTHS = True
STRENGTH_CELLS = {'chlorine': (5, 3), 'phosphate': (5, 8), 'fluoride': (5, 13), 'ph_adjust': (5, 18)}
ORTHO_CELL = (5, 11)
BACTI_LAB_CELL = (1, 7)
# THE RECOGNISED FORM — read from scripts/fixtures/mor-formulas.json (the first customer's map,
# extracted from EGLE's Class D workbook). The identity test asserts these still match the fixture.
REFERENCE_TABS = ('Instructions', 'Cover', 'Pumpage', 'EntryPoint1', 'EntryPoint2', 'EntryPoint3',
                  'EP Summary', 'Distribution', 'Bacti & Cl Res')
REFERENCE_FORMULA_CELLS = {'Instructions': 0, 'Cover': 0, 'Pumpage': 66, 'EntryPoint1': 361,
                           'EntryPoint2': 361, 'EntryPoint3': 361, 'EP Summary': 800,
                           'Distribution': 29, 'Bacti & Cl Res': 12}
# EGLE's own file ships two formulas already broken (#REF!, EP Summary X1:X2); they cannot be
# restored and never were. Every other formula must restore.
REFERENCE_FORMULAS_RESTORABLE = 1988


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
# ⛔ PRINT SETTINGS (Keith and Michelle, 2026-10-08). Michelle PRINTS the MOR, and builds each month from
# her own "Blank MOR.xls", whose page setup she tuned once: US Letter, fit to one page on every tab but
# Distribution, landscape for the data tabs, 0.7"/0.75" margins, no header/footer, and a print area on the
# Bacti tab (A1:M57) that keeps the results key in columns O:P off the page. xlutils.copy drops all of it,
# so every generated workbook came out on A4 at 100% with xlwt's page-number header — and she was resetting
# nine tabs by hand. These are the settings read out of her blank (BIFF SETUP / WSBOOL / margin / NAME
# records); the printer-driver block (PLS) is deliberately not copied — it belongs to her printer.
#   sheet: (portrait, fit_to_one_page, scale_when_not_fitting)
PAGE_SETUP = {
    'Instructions': (True, True, 65), 'Cover': (True, True, 99), 'Pumpage': (False, True, 86),
    'EntryPoint1': (False, True, 65), 'EntryPoint2': (False, True, 65), 'EntryPoint3': (False, True, 65),
    'EP Summary': (False, True, 69), 'Distribution': (False, False, 73), 'Bacti & Cl Res': (True, True, 88),
}
PRINT_AREAS = {'Bacti & Cl Res': (0, 56, 0, 12)}      # 0-based rows 0..56, cols 0..12  ->  A1:M57


def apply_print_setup(wb, sheet_names, page_setup=None, print_areas=None):
    """`page_setup` / `print_areas` come from a kinded template's manifest; None = the constants
    above, which is the legacy path exactly as it was."""
    page_setup = PAGE_SETUP if page_setup is None else page_setup
    for i, name in enumerate(sheet_names):
        cfg = page_setup.get(name)
        if not cfg:
            continue
        portrait, fit, scale = cfg
        ws = wb.get_sheet(i)
        ws.paper_size_code = 1                     # US Letter
        ws.portrait = portrait
        ws.fit_num_pages = 1 if fit else 0          # WSBOOL "fit to page"
        ws.fit_width_to_pages = 1
        ws.fit_height_to_pages = 1
        ws.print_scaling = scale
        ws.header_str = b''   # xlwt 1.3.0 decodes bytes here; a str raises
        ws.footer_str = b''
        ws.header_margin = 0.3
        ws.footer_margin = 0.3
        ws.left_margin = ws.right_margin = 0.7
        ws.top_margin = ws.bottom_margin = 0.75
        ws.print_centered_horz = False
        ws.print_centered_vert = False
    _install_print_areas(wb, sheet_names, print_areas)


def _install_print_areas(wb, sheet_names, print_areas=None):
    """xlwt cannot write defined names, and a print area IS one (built-in name 0x06, Print_Area). This
    appends the NAME records after the EXTERNSHEET record, inside the globals block xlwt is already
    measuring — so the BOUNDSHEET stream offsets it computes afterwards stay correct. Each area needs an
    EXTERNSHEET entry for its sheet; one is added if no formula happens to reference that sheet."""
    print_areas = PRINT_AREAS if print_areas is None else print_areas
    wanted = [(sheet_names.index(n), area) for n, area in print_areas.items() if n in sheet_names]
    if not wanted:
        return
    from xlwt.Workbook import Workbook as _WB
    orig = _WB._Workbook__all_links_rec
    refs = wb._Workbook__sheet_refs
    if wb._ownbook_supbookx is None:
        wb.setup_ownbook()
    own = wb._ownbook_supbookx
    ixti = {}
    for si, _ in wanted:
        key = (own, si, si)
        if key not in refs:
            refs[key] = len(refs)
        ixti[si] = refs[key]
    names = b''
    for si, (r0, r1, c0, c1) in wanted:
        fmla = struct.pack('<BHHHHH', 0x3B, ixti[si], r0, r1, c0, c1)
        body = struct.pack('<HBBHHHBBBB', 0x0020, 0, 1, len(fmla), 0, si + 1, 0, 0, 0, 0) + b'\x00\x06' + fmla
        names += struct.pack('<HH', 0x0018, len(body)) + body

    def patched(self):
        base = orig(self)
        return base + names if self is wb else base
    _WB._Workbook__all_links_rec = patched
    wb._print_area_restore = (_WB, orig)


def _cover_text(v):
    """A Cover value as text: '' for nothing, a whole-number float without its '.0'."""
    if v is None or isinstance(v, bool):
        return ''
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else str(v)
    return str(v).strip()


def _wssn_digits(v):
    """WSSNs compared on digits with leading zeros dropped (a numeric cell reads 1310 for 01310)."""
    return re.sub(r'\D', '', _cover_text(v)).lstrip('0')


def _same_text(a, b):
    return ' '.join(_cover_text(a).split()).casefold() == ' '.join(_cover_text(b).split()).casefold()


def _manifest_print_setup(manifest):
    """(page_setup, print_areas) from a kinded manifest's `print_setup`, shaped like PAGE_SETUP /
    PRINT_AREAS; (None, None) when it has none (the constants then apply). A malformed one refuses:
    a workbook printed on the wrong paper is a smaller fault than a guessed layout going unnoticed."""
    ps = (manifest or {}).get('print_setup')
    if ps is None:
        return None, None
    bad = Refuse(409, 'this template\'s manifest carries a print_setup that is not in the expected shape '
                      '({"page_setup": {tab: [portrait, fit_to_page, scale]}, "print_areas": {tab: '
                      '[first_row, last_row, first_col, last_col]}}); re-register it with '
                      'scripts/upload-mor-template.mjs. The workbook was not generated.')
    if not isinstance(ps, dict) or not isinstance(ps.get('page_setup'), dict) \
            or not isinstance(ps.get('print_areas'), dict):
        raise bad
    page, areas = {}, {}
    for name, cfg in ps['page_setup'].items():
        if not (isinstance(cfg, (list, tuple)) and len(cfg) == 3 and isinstance(cfg[0], bool)
                and isinstance(cfg[1], bool) and isinstance(cfg[2], int) and not isinstance(cfg[2], bool)
                and 10 <= cfg[2] <= 400):
            raise bad
        page[str(name)] = (cfg[0], cfg[1], cfg[2])
    for name, a in ps['print_areas'].items():
        if not (isinstance(a, (list, tuple)) and len(a) == 4
                and all(isinstance(x, int) and not isinstance(x, bool) and x >= 0 for x in a)
                and a[0] <= a[1] <= 65535 and a[2] <= a[3] <= 255):
            raise bad
        areas[str(name)] = tuple(a)
    return page, areas


def _fraction(v, what):
    """A strength as the fraction the form multiplies by (0.125, never 12.5)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        f = None
    if f is None or f != f or not 0 < f <= 1:
        raise Refuse(409, f'{what} is {v!r}; the state form needs a fraction between 0 and 1 '
                          '(0.125 for 12.5%). Correct it on the admin page; the workbook was not generated.')
    return f


def build(data, raw_template, formulas, manifest=None):
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

    # THE TEMPLATE'S KIND (2026-11-17). None = legacy: every line below that tests `kind` is
    # skipped and the output is byte-identical to the code before this change.
    kind = (manifest or {}).get('kind')
    if kind is not None and kind not in TEMPLATE_KINDS:
        raise Refuse(409, f'this template\'s manifest names kind {kind!r}, which the generator does not know '
                          f'(expected one of {", ".join(TEMPLATE_KINDS)}); the workbook was not generated.')
    # NT-3: the formula map fetched with a kinded template must be the one it was registered with.
    # A map swapped in storage afterwards would install its formulas in every report. The kind-less
    # legacy template never reaches this line.
    want_fmh = (manifest or {}).get('formula_map_sha256') if kind is not None else None
    if want_fmh:
        got_fmh = formula_map_sha256(formulas if isinstance(formulas, dict) else {})
        if got_fmh != want_fmh:
            raise Refuse(409, 'this template\'s formula map is not the one it was registered with (its hash '
                              f'{got_fmh[:12]} does not match the manifest\'s {str(want_fmh)[:12]}). Re-register the '
                              'template with scripts/upload-mor-template.mjs; the workbook was not generated.')
    supply = data.get('supply') or {}
    page_setup = print_areas = None
    if kind is not None:
        page_setup, print_areas = _manifest_print_setup(manifest)
        if 'Cover' not in sheet_idx:
            raise Refuse(409, 'this template has no Cover tab; the workbook was not generated.')
    if kind == 'state':
        missing = [label for col, label in COVER_REQUIRED if not _cover_text(supply.get(col))]
        if missing:
            raise Refuse(409, 'the report cover cannot be filled: this supply\'s record has no '
                              + ', no '.join(missing) + '. Add it on the admin page; the workbook was not generated.')
        cv0 = rb.sheet_by_name('Cover')
        wr0, wc0 = X_COVER_CELLS['wssn']
        pre = cv0.cell_value(wr0, wc0) if wr0 < cv0.nrows and wc0 < cv0.ncols else ''
        if _cover_text(pre):
            raise Refuse(409, f'the shared blank must not carry a water system number, but its Cover reads '
                              f'WSSN {_cover_text(pre)}. Re-register a clean state blank; the workbook was not generated.')

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

        AND 'other' IS NEITHER ROUTINE NOR REPEAT (Codex finding 3, 2026-09-11) — it has ITS OWN
        BLOCK. Round 1 of that review concluded EGLE's Bacti tab had only two blocks and excluded
        well samples from the workbook. That was wrong: rows 49..57 are "Other: well samples, entry
        point (plant tap), samples following construction/repair, etc.", and every 2026 report
        Michelle filed carries her monthly well samples there (Keith, 2026-10-08, with the printed
        form). `other` now goes into that block — never into routine, whose COUNTA is the
        compliance count — with no residual required (a raw-water sample has none).
        """
        rows = sorted(d.get('bacti') or [], key=lambda x: (x.get('collected_date') or '',
                                                           x.get('site_name') or ''))
        clear_block(BACTI_SHEET, BACTI_ROUTINE[0], BACTI_ROUTINE[1], BACTI_COLS)
        clear_block(BACTI_SHEET, BACTI_REPEAT[0], BACTI_REPEAT[1], BACTI_COLS)
        clear_block(BACTI_SHEET, BACTI_OTHER[0], BACTI_OTHER[1], BACTI_COLS)

        buckets = {'routine': list(BACTI_ROUTINE), 'repeat': list(BACTI_REPEAT), 'other': list(BACTI_OTHER)}
        used = {'routine': 0, 'repeat': 0, 'other': 0}
        for smp in rows:
            kind = str(smp.get('sample_kind') or 'routine').lower()
            if kind not in buckets:
                raise Refuse(409, f'a bacti sample has kind "{kind}", which has no block on the state form; '
                                  'the workbook was not generated.')
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
                fx = xlwt.Formula(f)
                fx._Formula__parser.rpn = fix_ref_classes(fx._Formula__parser.rpn)   # see fix_ref_classes
                ws.write(r, c, fx, style_at(name, r, c))
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

    # ⛔ EVERY READING HAS A HOME OR THE WORKBOOK IS REFUSED (review 2026-11-17, Codex finding 4).
    # This loop used to `continue` past an entry point with no EntryPoint tab, skip pumpage for a
    # well numbered outside 1..8, and drop a feed whose kind had no column -- each one a reading on
    # file that silently never reached the state form. All placement is now decided BEFORE anything
    # is written, and a value with nowhere to go refuses the month by name. An idle day (a null
    # value) needs no home and is never a refusal. Inactive entry points that carry readings this
    # month arrive in `entryPoints` flagged `active: false` and are placed exactly like active ones.
    ep_by_id = {ep['id']: ep for ep in data['entryPoints']}
    for row in data['readings']:
        if row.get('entry_point_id') not in ep_by_id:
            raise Refuse(409, f'a reading dated {row.get("reading_date")} belongs to entry point '
                              f'{row.get("entry_point_id")!r}, which is not in this month\'s entry points; '
                              'the workbook was not generated.')

    def ep_label(ep):
        return ep.get('label') or ep.get('code') or (f'Well {ep["well_no"]}' if ep.get('well_no') else str(ep['id']))

    plan = []                       # (ep, sheet or None, well_no or None, feed_kind, rows)
    pump_owner, tab_owner = {}, {}
    for ep in data['entryPoints']:
        rows = by_ep.get(ep['id'], {})
        feed_kind = {f['id']: f.get('kind') for f in ep.get('feeds', [])}
        name = ep_label(ep)
        needs_pump = needs_tab = False
        for day, row in sorted(rows.items()):
            when = row.get('reading_date')
            if row.get('million_gallons') is not None:
                needs_pump = needs_tab = True
            if any(row.get(k) is not None for k in ('tap_free', 'tap_total', 'tap_ortho')):
                needs_tab = True
            for fr in row.get('feeds', []):
                if fr.get('solution_lbs') is None:
                    continue
                needs_tab = True
                if fr.get('feed_id') not in feed_kind:
                    raise Refuse(409, f'{name} on {when} has a chemical feed reading for feed '
                                      f'{fr.get("feed_id")!r}, which is not one of its feeds; '
                                      'the workbook was not generated.')
                if FEED_COL.get(feed_kind[fr['feed_id']]) is None:
                    raise Refuse(409, f'{name} on {when} has a {feed_kind[fr["feed_id"]]!r} feed reading, '
                                      'which has no column on the state form; the workbook was not generated.')
        well = ep.get('well_no')
        if isinstance(well, float) and well.is_integer():
            well = int(well)
        well_ok = isinstance(well, int) and not isinstance(well, bool) and 1 <= well <= 8
        sheet = f'EntryPoint{ep["mor_sheet"]}' if ep.get('mor_sheet') else None
        if needs_pump and not well_ok:
            raise Refuse(409, f'{name} has metered pumpage this month but its well number ({well!r}) '
                              'has no column on the Pumpage tab (wells 1-8); the workbook was not generated.')
        if needs_tab and not sheet:
            raise Refuse(409, f'{name} has readings this month but is not mapped to an EntryPoint tab; '
                              'the workbook was not generated.')
        if needs_tab and sheet not in sheet_idx:
            raise Refuse(409, f'{name} is mapped to {sheet}, which this template does not have; '
                              'the workbook was not generated.')
        if needs_pump:
            if well in pump_owner:
                raise Refuse(409, f'{name} and {pump_owner[well]} are both mapped to Pumpage well {well}; '
                                  'the workbook was not generated.')
            pump_owner[well] = name
        if needs_tab:
            if sheet in tab_owner:
                raise Refuse(409, f'{name} and {tab_owner[sheet]} are both mapped to {sheet}; '
                                  'the workbook was not generated.')
            tab_owner[sheet] = name
        plan.append((ep, sheet if needs_tab else None, well if needs_pump else None, feed_kind, rows))

    well_days = 0                   # readings that put at least one value into the workbook
    for ep, sheet, well, feed_kind, rows in plan:
        for day, row in rows.items():
            wrote = False
            mg = row.get('million_gallons')
            if well is not None and mg is not None:
                put('Pumpage', PUMPAGE_ROW0 + day - 1, well, mg)
                wrote = True
            if sheet is None:
                well_days += 1 if wrote else 0
                continue
            r0 = EP_ROW0 + day - 1
            for c, v in ((1, mg), (6, row.get('tap_free')), (7, row.get('tap_total')), (12, row.get('tap_ortho'))):
                if v is not None:
                    put(sheet, r0, c, v)
                    wrote = True
            for fr in row.get('feeds', []):
                if fr.get('solution_lbs') is not None:
                    put(sheet, r0, FEED_COL[feed_kind[fr['feed_id']]], fr.get('solution_lbs'))
                    wrote = True
            well_days += 1 if wrote else 0

    # STATE BLANK: each entry point's chemical strengths onto its tab's row 6 (see STRENGTH_CELLS).
    # Row 6 is blanked on every EntryPoint tab first, so a kind this entry point does not feed can
    # never show a strength. Only feeds that are active, or that carry a reading this month, count;
    # two of them of one kind with different strengths have one cell between them and refuse.
    strengths_written, strength_cells = {}, []
    if kind == 'state' and WRITE_FEED_STRENGTHS:
        row6 = list(STRENGTH_CELLS.values()) + [ORTHO_CELL]
        for name in [s for s in rb.sheet_names() if s.startswith('EntryPoint')]:
            rs = rb.sheet_by_name(name)
            for r, c in row6:
                if r >= rs.nrows or c >= rs.ncols:
                    raise Refuse(409, f'{name} has no cell {xlrd.formula.colname(c)}{r + 1} for a chemical '
                                      'strength; this is not the recognised state form. The workbook was not generated.')
                wb.get_sheet(sheet_idx[name]).row(r).set_cell_blank(c, style_at(name, r, c))
        for ep, sheet, well, feed_kind, rows in plan:
            if sheet is None:
                continue
            used = {fr.get('feed_id') for row in rows.values() for fr in row.get('feeds', [])
                    if fr.get('solution_lbs') is not None}
            per_kind = {}
            for f in ep.get('feeds', []):
                if f.get('active') is False and f.get('id') not in used:
                    continue
                if f.get('kind') in STRENGTH_CELLS:
                    per_kind.setdefault(f['kind'], []).append(f)
            cells = {}
            for k, feeds in per_kind.items():
                vals = {_fraction(f.get('avail_fraction'), f'{ep_label(ep)}\'s {k} strength') for f in feeds}
                if len(vals) > 1:
                    raise Refuse(409, f'{ep_label(ep)} has {k} feeds of different strengths '
                                      f'({", ".join(str(v) for v in sorted(vals))}); the state form has one '
                                      f'strength cell for {k}. The workbook was not generated.')
                cells[STRENGTH_CELLS[k]] = vals.pop()
                if k == 'phosphate':
                    orth = {_fraction(f.get('ortho_factor'), f'{ep_label(ep)}\'s phosphate ortho factor')
                            for f in feeds if f.get('ortho_factor') is not None}
                    if len(orth) > 1:
                        raise Refuse(409, f'{ep_label(ep)} has phosphate feeds with different ortho factors; '
                                          'the state form has one cell for it. The workbook was not generated.')
                    if orth:
                        cells[ORTHO_CELL] = orth.pop()
            for (r, c), v in cells.items():
                put(sheet, r, c, v)
                strength_cells.append((sheet, r, c, v))
            if cells:
                strengths_written[sheet] = {f'{xlrd.formula.colname(c)}{r + 1}': v for (r, c), v in cells.items()}

    # The reporting period. Written before the data so a refusal later cannot leave a workbook
    # that is correctly filled and wrongly labelled.
    put('Cover', COVER_MONTH[0], COVER_MONTH[1], MONTHS[data['month']][:3])
    put('Cover', COVER_YEAR[0], COVER_YEAR[1], data['year'])

    # STATE BLANK: whose report it is, from the supply's own record. Optional fields with no value
    # stay as the clean blank has them (empty). The certification line only when it is set.
    cover_written = {}
    if kind == 'state':
        for field, col in COVER_FROM_SUPPLY:
            v = _cover_text(supply.get(col))
            if v:
                put('Cover', X_COVER_CELLS[field][0], X_COVER_CELLS[field][1], v)
                cover_written[field] = v
        signer = _cover_text(supply.get('cover_signed_by'))
        if signer:
            put('Cover', X_COVER_CELLS['signed_by'][0], X_COVER_CELLS['signed_by'][1], signer)
            cover_written['signed_by'] = signer

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

    apply_print_setup(wb, rb.sheet_names(), page_setup, print_areas)     # her blank's page setup and the Bacti print area
    out = io.BytesIO()
    try:
        wb.save(out)
    finally:
        restore = getattr(wb, '_print_area_restore', None)
        if restore:
            restore[0]._Workbook__all_links_rec = restore[1]

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
        wr, wc = X_COVER_CELLS['wssn']
        raw_wssn = back.cell_value(wr, wc) if wr < back.nrows and wc < back.ncols else ''
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
        back_other = _filled(*BACTI_OTHER)
        dsh = back_bk.sheet_by_name('Distribution')
        back_dist = sum(1 for r in range(DIST_ROW0, DIST_ROW0 + DIST_ROWS)
                        if r < dsh.nrows and str(dsh.cell_value(r, 1)).strip())
    except Exception as e:
        raise Refuse(500, f'the generated workbook could not be read back to check its samples: {e}')
    if (back_routine, back_repeat, back_other) != (bacti_written['routine'], bacti_written['repeat'], bacti_written['other']):
        raise Refuse(500, f'the saved workbook carries {back_routine} routine / {back_repeat} repeat / {back_other} other '
                          f'bacti rows but {bacti_written["routine"]} / {bacti_written["repeat"]} / {bacti_written["other"]} '
                          'were written; the workbook was not returned.')
    if back_dist != len(data['dist']):
        raise Refuse(500, f'the saved workbook carries {back_dist} distribution rows but '
                          f'{len(data["dist"])} were written; the workbook was not returned.')
    if got_month != want_month or got_year != want_year:
        raise Refuse(500, f'the generated workbook is labelled {got_month} {got_year} but reports '
                          f'{want_month} {want_year}; it was not returned. This is the defect found '
                          f'2026-09-02, when nothing wrote the Cover period and every month '
                          f'inherited the July that sits in the template.')

    # ⛔ AND WHOSE REPORT IT IS (review 2026-11-17, Codex finding 5). Only the period is written
    # here; the supply name and WSSN come from the stored template, and the template key falls back
    # to 'egle-class-d'. A template whose Cover names another supply would hand this supply a report
    # that says it is somebody else's. A non-blank Cover WSSN that differs from the requested one
    # refuses. Compared on digits with leading zeros dropped: a numeric cell reads 1310 for 01310.
    # A BLANK Cover WSSN is reported (stats.cover_wssn = None), not refused: nothing on record
    # establishes that the stored template carries the WSSN on its Cover.
    if isinstance(raw_wssn, float):
        got_wssn = str(int(raw_wssn)) if raw_wssn.is_integer() else str(raw_wssn)
    else:
        got_wssn = str(raw_wssn or '').strip()
    got_wssn = got_wssn or None
    want_wssn = str((data.get('supply') or {}).get('wssn') or '').strip()

    def _wssn_key(v):
        return re.sub(r'\D', '', str(v or '')).lstrip('0')

    if got_wssn and want_wssn and _wssn_key(got_wssn) != _wssn_key(want_wssn):
        raise Refuse(409, f'the template\'s Cover names WSSN {got_wssn}, but this report is for WSSN '
                          f'{want_wssn}; the workbook was not returned. The supply\'s MOR template '
                          'belongs to another supply.')

    # KINDED TEMPLATES: the same doctrine — what reached the saved file, not what was intended.
    kind_stats = {}
    if kind == 'state':
        bad = []
        bcv = back_bk.sheet_by_name('Cover')
        for field, v in cover_written.items():
            r, c = X_COVER_CELLS[field]
            got = bcv.cell_value(r, c) if r < bcv.nrows and c < bcv.ncols else ''
            if _cover_text(got) != v:
                bad.append(f'Cover {xlrd.formula.colname(c)}{r + 1} ({field}) reads {_cover_text(got)!r}, not {v!r}')
        for sheet, r, c, v in strength_cells:
            bsh = back_bk.sheet_by_name(sheet)
            got = bsh.cell_value(r, c) if r < bsh.nrows and c < bsh.ncols else ''
            if not isinstance(got, float) or abs(got - v) > 1e-12:
                bad.append(f'{sheet}!{xlrd.formula.colname(c)}{r + 1} reads {got!r}, not {v!r}')
        if not got_wssn or _wssn_digits(got_wssn) != _wssn_digits(want_wssn):
            bad.append(f'the Cover WSSN reads {got_wssn!r}, not {want_wssn!r}')
        if bad:
            raise Refuse(409, 'the report cover did not save as written: ' + '; '.join(bad[:6])
                              + '. The workbook was not returned.')
        kind_stats = {'template_kind': 'state', 'cover_written': sorted(cover_written),
                      'strengths_written': strengths_written}
    elif kind == 'supply':
        if not got_wssn:
            raise Refuse(409, 'this supply\'s own blank has no water system number on its Cover. A town\'s '
                              'own blank must name the town; re-register it. The workbook was not returned.')
        cover = _extract_cover(back_bk)
        pairs = [(f, col) for f, col in COVER_FROM_SUPPLY if f != 'wssn']
        if _cover_text(supply.get('cover_signed_by')):
            pairs.append(('signed_by', 'cover_signed_by'))
        diffs = [{'field': f, 'cover': cover.get(f), 'supply': _cover_text(supply.get(col))}
                 for f, col in pairs
                 if _cover_text(supply.get(col)) and not _same_text(cover.get(f), supply.get(col))]
        kind_stats = {'template_kind': 'supply', 'cover_differences': diffs}

    # stats report what REACHED THE WORKBOOK, not what was fetched. Reporting len(data['bacti'])
    #    while writing none of it is what let the omission run unnoticed: review.html prints this
    #    count beside the download, so the product asserted '2 bacti' about a file containing zero.
    stats = {'formulas_restored': restored, 'formulas_skipped': skipped,
                            'cover_month': got_month, 'cover_year': got_year,
                            'cover_wssn': got_wssn,
                            # readings that put at least one value into the workbook (2026-11-17)
                            'well_days': well_days, 'distribution': len(data['dist']),
                            'bacti': bacti_written['routine'] + bacti_written['repeat'],
                            'bacti_routine': bacti_written['routine'],
                            'bacti_repeat': bacti_written['repeat'],
                            # well / raw-water samples, written to the form's Other block (2026-10-08)
                            'bacti_other': bacti_written['other'],
                            'bacti_other_excluded': 0}
    stats.update(kind_stats)       # empty on the legacy path: its stats are exactly as before
    return out.getvalue(), stats


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
    out['state_template'] = _selftest_state()
    return out


def _selftest_state():
    """REPORTED, NEVER FAILED ON (2026-11-17): is the shared state blank registered, and is it
    usable? The release check asserts only the legacy template above, so a town still waiting for
    the state blank cannot break a release."""
    rep = {'key': STATE_TEMPLATE_KEY, 'present': False}
    try:
        raw, formulas, manifest = fetch_template(STATE_TEMPLATE_KEY)
    except Exception as e:
        rep['why'] = getattr(e, 'message', None) or type(e).__name__
        return rep
    rep['present'] = True
    try:
        rep['kind'] = manifest.get('kind')
        bk = xlrd.open_workbook(file_contents=decrypt(raw))
        cv = bk.sheet_by_name('Cover')
        r, c = X_COVER_CELLS['wssn']
        rep['cover_wssn_blank'] = not _cover_text(cv.cell_value(r, c) if r < cv.nrows and c < cv.ncols else '')
        rep['formula_cells'] = sum(len(v or {}) for v in formulas.values())
        rep['usable'] = rep['kind'] == 'state' and rep['cover_wssn_blank'] and rep['formula_cells'] >= 1000
    except Exception as e:
        rep['usable'] = False
        rep['why'] = f'{type(e).__name__}: {e}'[:200]
    return rep


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
    elif sd not in ('', None) and not isinstance(sd, bool):
        # a number that is not a date serial — an accidental 42, an out-of-range value (R3-7):
        # non-empty and unreadable, never "blank"
        unreadable = str(sd)

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
        for kind, (row0, cap) in (('routine', BACTI_ROUTINE), ('repeat', BACTI_REPEAT), ('other', BACTI_OTHER)):
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

    # ⛔ THE COVER IS NOT THE ONLY THING THAT DATES A WORKBOOK (review 2026-11-17). A Cover saying
    # September over samples dated July was accepted as September. Every dated sample outside the
    # Cover's month (or, with no month on the Cover, the requested one) is listed in
    # `samples_outside_cover_month` and named in `notes`, so the caller can refuse or show it. Nothing
    # is dropped, and a consistent workbook returns exactly what it did before (no key, no note).
    cm_cover = None
    if cover_month:
        cm_cover = next((i for i, nm in enumerate(MONTHS)
                         if nm and nm.lower().startswith(str(cover_month).strip().lower()[:3])), None)
    cy_cover = (out['cover'] or {}).get('year') or year
    period = f'{int(cy_cover):04d}-{(cm_cover or month):02d}'
    stray = [{'tab': 'Distribution', 'date': s['date']} for s in out['distribution']
             if not str(s['date']).startswith(period)]
    stray += [{'tab': BACTI_SHEET, 'kind': s['kind'], 'location': s['location'], 'date': s['date']}
              for s in out['bacti'] if not str(s['date']).startswith(period)]
    if stray:
        out['samples_outside_cover_month'] = stray
        out['notes'].append(f'{len(stray)} sample date(s) fall outside {period}, the period the Cover '
                            f'names: ' + ', '.join(f'{s["tab"]} {s["date"]}' for s in stray[:10])
                            + (' …' if len(stray) > 10 else ''))

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

    raw, formulas, manifest = fetch_template(supply.get('mor_template') or 'egle-class-d')
    xls, stats = build(data, raw, formulas, manifest)     # a manifest with no `kind` = the legacy path
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


# ---------------------------------------------------------------------------------------------
# registering a template — checked LOCALLY, never over HTTP (2026-11-17)
# ---------------------------------------------------------------------------------------------
# This route has no privileged action today (generate, extract and selftest are all open), so the
# validator is NOT an HTTP action: it is a pure function, run on the owner's own machine by
# scripts/upload-mor-template.mjs as `pytools api/build-mor.py validate-template ...` before
# anything is uploaded. Nothing here reads the network.
#
# THE FORMULA MAP'S EXPRESSIONS, NOT ONLY ITS COUNTS (2026-11-17, review finding NT-3). Until now a
# map with the right number of formulas per tab passed even if one Total read SUM(B8:H8) where the
# form says SUM(B8:I8), and build() installed that wrong total into every report for the town. Now:
#   - the upload script reads the map out of the candidate workbook itself (SheetJS) and refuses a
#     supplied --formulas that differs from it;
#   - validate_template compares every expression with the RECOGNISED FORM's map (the fixture the
#     generator's cell layout was built against) and every address with the workbook's own BIFF
#     FORMULA records;
#   - the manifest carries `formula_map_sha256` (also inside the fingerprint), and build() refuses a
#     kinded template whose fetched map no longer hashes to it.
# The normalisation is defined once in words in scripts/extract-mor-formulas.mjs `normaliseFormula`
# and implemented identically here; the upload script cross-checks the two hashes on every run.
RECOGNISED_FORMULA_MAP = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'scripts',
                                      'fixtures', 'mor-formulas.json')
_FORMULA_PUNCT = frozenset('(),;+-*/^&=<>%:')
_FORMULA_KEY = re.compile(r'^(0|[1-9][0-9]*),(0|[1-9][0-9]*)$')


def normalise_formula(f):
    """Drop leading whitespace and then one '='; outside "..." and '...' upper-case a-z and drop
    whitespace at either end or beside ( ) , ; + - * / ^ & = < > % : (else keep one space: the
    intersection operator). Quoted text is kept byte for byte. Identical to
    extract-mor-formulas.mjs `normaliseFormula`."""
    s = str(f).lstrip(' \t\r\n')
    if s.startswith('='):
        s = s[1:]
    out, quote, pending_space = [], None, False
    for ch in s:
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in ' \t\r\n':
            pending_space = True
            continue
        if pending_space:
            if out and out[-1] not in _FORMULA_PUNCT and ch not in _FORMULA_PUNCT:
                out.append(' ')
            pending_space = False
        if ch in '"\'':
            quote = ch
            out.append(ch)
            continue
        out.append(ch.upper() if 'a' <= ch <= 'z' else ch)
    return ''.join(out)


def _rc(k):
    m = _FORMULA_KEY.match(str(k))
    return (int(m.group(1)), int(m.group(2))) if m else (float('inf'), float('inf'))


def _a1(k):
    r, c = _rc(k)
    return f'{xlrd.formula.colname(c)}{r + 1}' if r != float('inf') else repr(k)


def formula_map_canonical(m):
    """JSON of [[sheet, [[row, col, normalised], ...]], ...]: sheets sorted, cells by row then col.
    Byte-identical to extract-mor-formulas.mjs `formulaMapCanonical` for a well-formed map."""
    sheets = []
    for name in sorted(m):
        cells = [[*_rc(k), normalise_formula(f)] for k, f in (m[name] or {}).items()]
        cells.sort(key=lambda x: (x[0], x[1]))
        sheets.append([name, cells])
    return json.dumps(sheets, separators=(',', ':'), ensure_ascii=False)


def formula_map_sha256(m):
    import hashlib
    return hashlib.sha256(formula_map_canonical(m).encode('utf-8')).hexdigest()


def diff_formula_maps(a, b):
    """Every disagreement after normalise_formula: a sheet in only one map, a cell in only one, or a
    cell whose expressions differ. [{'sheet', 'key', 'cell', 'a', 'b'}], sorted."""
    out = []
    for name in sorted(set(a) | set(b)):
        if name not in a or name not in b:
            out.append({'sheet': name, 'key': None, 'cell': None,
                        'a': 'sheet present' if name in a else None, 'b': 'sheet present' if name in b else None})
            continue
        ca, cb = a[name] or {}, b[name] or {}
        for k in sorted(set(ca) | set(cb), key=lambda k: (*_rc(k), str(k))):
            fa, fb = ca.get(k), cb.get(k)
            if fa is None or fb is None or normalise_formula(fa) != normalise_formula(fb):
                out.append({'sheet': name, 'key': k, 'cell': _a1(k), 'a': fa, 'b': fb})
    return out


def describe_formula_diffs(diffs, a_label, b_label, limit=10):
    show = lambda v: '(none)' if v is None else json.dumps(v)
    lines = [(f'sheet "{d["sheet"]}": {a_label} {"has it" if d["a"] else "lacks it"}, '
              f'{b_label} {"has it" if d["b"] else "lacks it"}') if d['key'] is None else
             f'{d["sheet"]}!{d["cell"]} ({d["key"]}): {a_label} {show(d["a"])}, {b_label} {show(d["b"])}'
             for d in diffs[:limit]]
    if len(diffs) > limit:
        lines.append(f'... and {len(diffs) - limit} more')
    return lines


def _recognised_formula_map():
    with open(RECOGNISED_FORMULA_MAP, encoding='utf-8') as fh:
        return json.load(fh)


def formula_addresses(plain):
    """{sheet: {'row,col', ...}} — every cell holding a FORMULA record (0x0006) in the workbook's own
    BIFF stream. xlrd cannot read formulas, but the records still say WHERE they are."""
    import olefile
    ole = olefile.OleFileIO(io.BytesIO(plain))
    data = ole.openstream('Workbook' if ole.exists('Workbook') else 'Book').read()

    def records(pos):
        while pos + 4 <= len(data):
            rid, ln = struct.unpack_from('<HH', data, pos)
            yield rid, data[pos + 4:pos + 4 + ln]
            pos += 4 + ln
            if rid == 0x000A:
                return

    sheets = []
    for rid, body in records(0):
        if rid == 0x0085:
            off, cch, flag = struct.unpack_from('<I', body, 0)[0], body[6], body[7]
            nm = body[8:8 + cch * 2].decode('utf-16-le') if flag & 1 else body[8:8 + cch].decode('latin-1')
            sheets.append((nm, off))
    out = {}
    for nm, off in sheets:
        out[nm] = {'%d,%d' % struct.unpack_from('<HH', body, 0)
                   for rid, body in records(off) if rid == 0x0006 and len(body) >= 4}
    return out


def _input_cells(name):
    """Every data-entry cell build() writes or clears on this tab."""
    cells = set()

    def block(r0, n, cols):
        cells.update((r, c) for r in range(r0, r0 + n) for c in cols)
    if name == 'Pumpage':
        block(PUMPAGE_ROW0, 31, range(1, 9))
    elif name.startswith('EntryPoint'):
        block(EP_ROW0, 31, (1, 3, 6, 7, 8, 12))
    elif name == 'Distribution':
        block(DIST_ROW0, DIST_ROWS, DIST_COLS)
    elif name == BACTI_SHEET:
        for r0, n in (BACTI_ROUTINE, BACTI_REPEAT, BACTI_OTHER):
            block(r0, n, BACTI_COLS)
    return cells


def _identity_cells(name):
    """Cells that legitimately differ between one supply's blank and another's."""
    if name == 'Cover':
        return set(X_COVER_CELLS.values())
    if name.startswith('EntryPoint'):
        return set(STRENGTH_CELLS.values()) | {ORTHO_CELL}
    if name == BACTI_SHEET:
        return {BACTI_LAB_CELL}
    return set()


def _label_map(sh, name, formulas):
    """The printed form: every non-empty cell that is not data entry, not identity, not a formula."""
    skip = _input_cells(name) | _identity_cells(name)
    have = formulas.get(name) or {}
    out = {}
    for r in range(sh.nrows):
        for c in range(sh.ncols):
            if (r, c) in skip or f'{r},{c}' in have:
                continue
            t = ' '.join(_cover_text(sh.cell_value(r, c)).split())
            if t:
                out[f'{r},{c}'] = t
    return out


def _restorable(formulas, names):
    restored, skipped = 0, []
    for name, cells in formulas.items():
        if name not in names:
            continue
        for keyrc, f in (cells or {}).items():
            try:
                xlwt.Formula(f)
                restored += 1
            except Exception:
                skipped.append([name, keyrc, f])
    return restored, skipped


def fingerprint(bk, formulas):
    """A compact description of a form, stored in the manifest so a later registration (or a
    person) can tell whether two blanks are the same printed form. Version 2 (NT-3) adds
    `formula_map_sha256`, so the fingerprint covers every formula EXPRESSION, not only the counts."""
    import hashlib
    fp = {'version': 2, 'tabs': bk.sheet_names(), 'formula_cells': {}, 'merged': {}, 'labels': {},
          'formula_map_sha256': formula_map_sha256(formulas)}
    for name in bk.sheet_names():
        sh = bk.sheet_by_name(name)
        fp['formula_cells'][name] = len(formulas.get(name) or {})
        merged = sorted(list(m) for m in sh.merged_cells)
        fp['merged'][name] = {'ranges': len(merged),
                              'sha256': hashlib.sha256(json.dumps(merged).encode()).hexdigest()}
        lab = _label_map(sh, name, formulas)
        fp['labels'][name] = {'cells': len(lab),
                              'sha256': hashlib.sha256(json.dumps(sorted(lab.items())).encode()).hexdigest()}
    fp['formulas_restorable'] = _restorable(formulas, bk.sheet_names())[0]
    return fp


def read_print_setup(plain):
    """Page setup read back out of the workbook's own BIFF records — the records apply_print_setup
    writes: SETUP (0x00A1: orientation and scale), WSBOOL (0x0081: fit to page) and the built-in
    Print_Area NAME (0x0018). xlrd does not expose these. Returns the PAGE_SETUP / PRINT_AREAS
    shape plus `unreadable` (tabs whose SETUP record says its values are not valid)."""
    import olefile
    ole = olefile.OleFileIO(io.BytesIO(plain))
    data = ole.openstream('Workbook' if ole.exists('Workbook') else 'Book').read()

    def records(pos):
        while pos + 4 <= len(data):
            rid, ln = struct.unpack_from('<HH', data, pos)
            yield rid, data[pos + 4:pos + 4 + ln]
            pos += 4 + ln
            if rid == 0x000A:            # EOF of this substream
                return

    sheets, areas_by_index = [], {}
    for rid, body in records(0):
        if rid == 0x0085:                # BOUNDSHEET: stream offset, name
            off, cch, flag = struct.unpack_from('<I', body, 0)[0], body[6], body[7]
            nm = body[8:8 + cch * 2].decode('utf-16-le') if flag & 1 else body[8:8 + cch].decode('latin-1')
            sheets.append((nm, off))
        elif rid == 0x0018 and len(body) >= 15:      # NAME
            grbit, _key, cch, cce, _ixals, itab = struct.unpack_from('<HBBHHH', body, 0)
            if not grbit & 0x0020 or cch != 1:
                continue
            p = 14
            wide = body[p] & 1
            p += 1
            code = struct.unpack_from('<H', body, p)[0] if wide else body[p]
            p += 2 if wide else 1
            fm = body[p:p + cce]
            if code == 0x06 and itab and len(fm) >= 11 and fm[0] in (0x3B, 0x5B, 0x7B):
                _t, _ixti, r0, r1, c0, c1 = struct.unpack_from('<BHHHHH', fm, 0)
                areas_by_index[itab - 1] = [r0, r1, c0 & 0x3FFF, c1 & 0x3FFF]
    page, areas, unreadable = {}, {}, []
    for i, (nm, off) in enumerate(sheets):
        fit = portrait = scale = None
        nopls = False
        for rid, body in records(off):
            if rid == 0x0081 and len(body) >= 2:
                fit = bool(struct.unpack_from('<H', body, 0)[0] & 0x0100)
            elif rid == 0x00A1 and len(body) >= 12:
                _paper, scale, _start, _fw, _fh, g = struct.unpack_from('<HHHHHH', body, 0)
                portrait, nopls = bool(g & 0x02), bool(g & 0x04)
        if fit is None or portrait is None or nopls:
            unreadable.append(nm)
        else:
            page[nm] = [portrait, fit, scale]
        if i in areas_by_index:
            areas[nm] = areas_by_index[i]
    return {'page_setup': page, 'print_areas': areas, 'unreadable': unreadable}


def validate_template(raw, formulas, kind, wssn=None, reference_raw=None):
    """Is this workbook a blank of the recognised EGLE form, fit to register as `kind`?
    Returns {'ok', 'failures': [...], 'warnings': [...], 'fingerprint', 'print_setup', ...}."""
    fails, warns = [], []
    res = {'ok': False, 'kind': kind, 'failures': fails, 'warnings': warns}
    if kind not in TEMPLATE_KINDS:
        fails.append(f'kind must be one of {", ".join(TEMPLATE_KINDS)}, not {kind!r}')
        return res
    if kind == 'supply' and not _wssn_digits(wssn):
        fails.append("a town's own blank (kind=supply) is registered with that town's WSSN; none was given")
    if not isinstance(formulas, dict) or not all(isinstance(v, dict) or v is None for v in formulas.values()):
        fails.append('the formula map is not a {tab: {"row,col": formula}} object')
        return res
    malformed = [f'{t}!{k}' for t, cells in formulas.items() for k, f in (cells or {}).items()
                 if not _FORMULA_KEY.match(str(k)) or not isinstance(f, str)]
    if malformed:
        fails.append('the formula map has cells that are not "row,col": "<formula text>": ' + ', '.join(malformed[:10]))
        return res
    plain = decrypt(raw)
    res['encrypted'] = plain is not raw
    try:
        bk = xlrd.open_workbook(file_contents=plain, formatting_info=True)
    except Exception as e:
        fails.append(f'the workbook does not open as an Excel 97-2003 file ({type(e).__name__}: {e})')
        return res
    names = bk.sheet_names()

    # 1. the tabs: every one the generator writes, none the form lacks, in the form's order
    missing = [t for t in REFERENCE_TABS if t not in names]
    extra = [t for t in names if t not in REFERENCE_TABS]
    if missing:
        fails.append(f'tab(s) missing: {", ".join(missing)}')
    if extra:
        fails.append(f'tab(s) the recognised form does not have: {", ".join(extra)}')
    if not missing and not extra and tuple(names) != REFERENCE_TABS:
        fails.append('the tabs are in a different order from the recognised form')

    # 2. the formula map belongs to this form, and every formula in it can be restored
    if set(formulas) != set(names):
        fails.append(f'the formula map names tabs {sorted(formulas)}, the workbook has {names}')
    for t in REFERENCE_TABS:
        n = len(formulas.get(t) or {})
        if n != REFERENCE_FORMULA_CELLS[t]:
            fails.append(f'{t}: the formula map has {n} formulas; the recognised form has {REFERENCE_FORMULA_CELLS[t]}')
    restored, skipped = _restorable(formulas, names)
    res.update({'formula_cells': sum(len(v or {}) for v in formulas.values()),
                'formulas_restored': restored, 'formulas_unrestorable': skipped})
    broken = [s for s in skipped if '#REF!' not in s[2]]
    if broken:
        fails.append(f'{len(broken)} formula(s) cannot be restored and are not EGLE\'s own #REF! cells: '
                     + ', '.join(f'{s[0]}!{s[1]}' for s in broken[:5]))
    if restored != REFERENCE_FORMULAS_RESTORABLE:
        fails.append(f'{restored} formulas restore; the recognised form restores {REFERENCE_FORMULAS_RESTORABLE}')

    # 2b. (NT-3) every EXPRESSION is the recognised form's, cell for cell, after normalise_formula.
    #     build() writes data into fixed cells and relies on these formulas reading them, so a
    #     different form revision is refused here; handling one is the owner's decision.
    try:
        recognised = _recognised_formula_map()
    except Exception as e:
        recognised = None
        fails.append(f"the recognised form's formula map could not be read ({type(e).__name__}: {RECOGNISED_FORMULA_MAP})")
    if recognised is not None:
        d = diff_formula_maps(recognised, formulas)
        if d:
            fails.append(f'{len(d)} formula cell(s) differ from the recognised form: '
                         + '; '.join(describe_formula_diffs(d, 'recognised form', 'this map')))

    # 2c. (NT-3) every ADDRESS in the map is a formula cell of THIS workbook, and every formula cell
    #     of this workbook is in the map (its own BIFF FORMULA records; xlrd cannot read the text).
    try:
        have = formula_addresses(plain)
    except Exception as e:
        have = None
        fails.append(f"the workbook's formula cells could not be read ({type(e).__name__}: {e})")
    if have is not None:
        wrong = []
        for t in names:
            m, w = set((formulas.get(t) or {}).keys()), have.get(t, set())
            for k in sorted(m ^ w, key=_rc):
                wrong.append(f'{t}!{_a1(k)} ({k}) ' + ('the map has a formula, the workbook has none' if k in m
                                                       else 'the workbook has a formula, the map has none'))
        if wrong:
            fails.append(f"{len(wrong)} formula address(es) disagree with this workbook's own formula cells: "
                         + '; '.join(wrong[:10]) + (f'; ... and {len(wrong) - 10} more' if len(wrong) > 10 else ''))
    res['formula_map_sha256'] = formula_map_sha256(formulas)

    # 3. the day labels every reading is placed by
    day_tabs = [('Pumpage', PUMPAGE_ROW0)] + [(t, EP_ROW0) for t in names if t.startswith('EntryPoint')]
    for t, row0 in day_tabs:
        if t not in names:
            continue
        sh = bk.sheet_by_name(t)
        wrong = [r + 1 for i, r in enumerate(range(row0, row0 + 31))
                 if not (r < sh.nrows and _num(sh.cell_value(r, 0)) == i + 1)]
        if wrong:
            fails.append(f'{t}: column A must number the days 1-31 from row {row0 + 1}; '
                         f'row(s) {", ".join(map(str, wrong[:5]))} do not')

    # 4. a blank is blank
    for t in names:
        sh = bk.sheet_by_name(t)
        filled = [(r, c) for (r, c) in sorted(_input_cells(t))
                  if r < sh.nrows and c < sh.ncols and _cover_text(sh.cell_value(r, c))]
        if filled:
            r, c = filled[0]
            fails.append(f'{t}: {len(filled)} data-entry cell(s) are filled (first {xlrd.formula.colname(c)}{r + 1}); '
                         'a template must be a blank form')

    # 5. the Cover, by kind
    if 'Cover' in names:
        cv = bk.sheet_by_name('Cover')

        def cover(field):
            r, c = X_COVER_CELLS[field]
            return _cover_text(cv.cell_value(r, c)) if r < cv.nrows and c < cv.ncols else ''

        def ref(field):
            r, c = X_COVER_CELLS[field]
            return f'Cover {xlrd.formula.colname(c)}{r + 1}'
        for field in ('comment_left', 'comment_right', 'submitted_date'):
            if cover(field):
                fails.append(f'{ref(field)} ({field}) reads {cover(field)!r}; it must be empty on a blank')
        if kind == 'state':
            for field in ('supply_name', 'wssn', 'oic_name', 'classification', 'oic_cert', 'county',
                          'submitted_to', 'signed_by'):
                if cover(field):
                    fails.append(f'{ref(field)} ({field}) reads {cover(field)!r}; the shared state blank must leave it empty')
            for t in [s for s in names if s.startswith('EntryPoint')]:
                sh = bk.sheet_by_name(t)
                for r, c in sorted(set(STRENGTH_CELLS.values()) | {ORTHO_CELL}):
                    if r < sh.nrows and c < sh.ncols and _cover_text(sh.cell_value(r, c)):
                        fails.append(f'{t}!{xlrd.formula.colname(c)}{r + 1} carries a chemical strength; '
                                     'the shared state blank must leave row 6 empty')
            if BACTI_SHEET in names:
                sh = bk.sheet_by_name(BACTI_SHEET)
                r, c = BACTI_LAB_CELL
                if r < sh.nrows and c < sh.ncols and _cover_text(sh.cell_value(r, c)):
                    fails.append(f'{BACTI_SHEET}!H2 names a laboratory; the shared state blank must leave it empty')
        else:
            if not cover('wssn'):
                fails.append(f"{ref('wssn')} is empty; a town's own blank must name the town")
            elif _wssn_digits(wssn) and _wssn_digits(cover('wssn')) != _wssn_digits(wssn):
                fails.append(f"{ref('wssn')} reads {cover('wssn')}, not {wssn}; this blank belongs to another supply")
            if not cover('supply_name'):
                warns.append(f"{ref('supply_name')} (supply name) is empty on a town's own blank")

    # 6. the printed form itself, against a reference blank of the recognised form
    res['fingerprint'] = fingerprint(bk, formulas)
    if reference_raw is None:
        fails.append('no reference workbook was given: the label cells and merged ranges could not be '
                     'compared with the recognised form')
    else:
        try:
            rbk = xlrd.open_workbook(file_contents=decrypt(reference_raw), formatting_info=True)
        except Exception as e:
            fails.append(f'the reference workbook does not open ({type(e).__name__})')
            rbk = None
        if rbk is not None:
            for t in [s for s in REFERENCE_TABS if s in names and s in rbk.sheet_names()]:
                a, b = _label_map(rbk.sheet_by_name(t), t, formulas), _label_map(bk.sheet_by_name(t), t, formulas)
                diff = sorted(set(a) ^ set(b) | {k for k in set(a) & set(b) if a[k] != b[k]},
                              key=lambda k: tuple(map(int, k.split(','))))
                if diff:
                    r, c = map(int, diff[0].split(','))
                    fails.append(f'{t}: {len(diff)} printed label cell(s) differ from the recognised form '
                                 f'(first {xlrd.formula.colname(c)}{r + 1}: form {a.get(diff[0])!r}, '
                                 f'this file {b.get(diff[0])!r})')
                ma = sorted(tuple(m) for m in rbk.sheet_by_name(t).merged_cells)
                mb = sorted(tuple(m) for m in bk.sheet_by_name(t).merged_cells)
                if ma != mb:
                    fails.append(f'{t}: merged ranges differ from the recognised form '
                                 f'({len(ma)} there, {len(mb)} here; {len(set(ma) ^ set(mb))} differ)')

    # 7. the page setup, carried into the manifest
    try:
        res['print_setup'] = read_print_setup(plain)
        if res['print_setup']['unreadable']:
            warns.append('page setup could not be read for: ' + ', '.join(res['print_setup']['unreadable']))
    except Exception as e:
        res['print_setup'] = None
        warns.append(f'page setup could not be read ({type(e).__name__}); pass --print-setup')
    res['ok'] = not fails
    return res


def _main(argv):
    import argparse
    p = argparse.ArgumentParser(prog='build-mor.py')
    sub = p.add_subparsers(dest='cmd', required=True)
    v = sub.add_parser('validate-template', help='check a blank before registering it (local only)')
    v.add_argument('--template', required=True)
    v.add_argument('--formulas', required=True)
    v.add_argument('--kind', required=True)
    v.add_argument('--wssn')
    v.add_argument('--reference')
    # NT-3: SheetJS cannot remove EGLE's RC4 encryption, so the upload script has the workbook
    # decrypted here (the same decrypt() build() uses; a lossless step) before reading its formulas.
    dc = sub.add_parser('decrypt', help='write the decrypted bytes of a workbook (local only)')
    dc.add_argument('--template', required=True)
    dc.add_argument('--out', required=True)
    a = p.parse_args(argv)
    if a.cmd == 'decrypt':
        with open(a.template, 'rb') as fh:
            raw = fh.read()
        plain = decrypt(raw)
        with open(a.out, 'wb') as fh:
            fh.write(plain)
        print(json.dumps({'ok': True, 'encrypted': plain is not raw, 'bytes': len(plain)}))
        return 0
    with open(a.template, 'rb') as fh:
        raw = fh.read()
    with open(a.formulas, encoding='utf-8') as fh:
        formulas = json.load(fh)
    ref = None
    if a.reference:
        with open(a.reference, 'rb') as fh:
            ref = fh.read()
    res = validate_template(raw, formulas, a.kind, a.wssn, ref)
    print(json.dumps(res))
    return 0 if res['ok'] else 1


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


if __name__ == '__main__':
    import sys
    sys.exit(_main(sys.argv[1:]))
