"use strict";
/* ryc-invoices/retainage.js — how much are we holding on this subcontractor, on this job.
 *
 * WHAT THIS REPLACES. Annette Wiseman keeps 330 workbooks in SharePoint under
 * Company Share/Accounting Office/Annette's Files/Vendors — one .xlsx per vendor, a worksheet tab
 * per job, 160 of them edited in 2026, maintained by four people. Each tab is
 * `Date | This Period | X% Ret | Current Due` with a totals row, and the live answer is that one
 * total: retainage held. Getting a job's exposure means opening every vendor file that ever
 * worked it.
 *
 * WHAT IT DOES NOT REPLACE, AND THE SCREEN SAYS SO RATHER THAN IMPLYING OTHERWISE:
 *   · the G703 scope-line grid she rebuilds in the lower half of each tab (earthwork, sanitary,
 *     storm, water…) with an `O = C - SUM(F:N)` check she works to zero — the reader takes the
 *     column E grand total and nothing finer;
 *   · release. Her sheets record it IN BAND, as a pay-app row whose date cell reads `pd retainage`
 *     or `Final Retention`. The register has no release event, so a job whose retainage has been
 *     paid back still shows the last application's line 5 — which is what the FORM says and is why
 *     the last-application date is on every row here;
 *   · `don't hold retainage`, which she writes per application and then deletes that row's formula.
 *     A rate read off the page gets this right by construction; nothing here needs the note.
 *
 * ⛔ NULL IS NOT ZERO, AND THIS FILE NEVER PRINTS $0 FOR AN UNKNOWN. A vendor+job whose
 * applications carried no legible line 5 renders as an em dash with its coverage beside it.
 * Printing zero would tell the front office RYC holds nothing on a subcontractor it may be holding
 * plenty on — the single most expensive thing this screen could get wrong.
 */

var _ret = { rows: [], summary: {}, by: "vendor", q: "" };

/* ONE RULE, ONE EXPRESSION. What may be added into a total: only a figure whose own face sheet
   foots (stated_status 'ok'). This is the SAME rule the server applies to `summary.held`, and it
   is a function rather than three copies of a ternary because the header total, the filtered
   total and the per-job subtotal were three places for it to drift — teaching one about
   contradicted figures and not the others is how a board ends up contradicting itself in plain
   sight. */
function retHeld(x){
  return (x && x.stated_status === "ok" && x.retainage_stated !== null)
    ? Number(x.retainage_stated) : 0;
}

function retPct(x){
  if(x === null || x === undefined) return "";
  var p = Number(x) * 100;
  return (Math.round(p * 100) / 100) + "%";
}

function renderRetainage(){
  var v = document.getElementById("view");
  var ti = document.getElementById("view-title");
  if(ti) ti.textContent = "Retainage";
  document.getElementById("view-ctx").innerHTML =
    "What we are holding, per subcontractor per job &middot; read off each pay application's "
    + "G702 line 5, never derived";
  v.innerHTML = '<div class="panel"><div class="sub">Loading retainage&hellip;</div></div>';

  invPost("retainage", {}).then(function(r){
    if(!r.ok || !r.data || r.data.error){
      v.innerHTML = '<div class="panel"><div class="sub m-r">'
        + esc((r.data && r.data.error) || r.error || "Could not load retainage.")
        + '</div></div>';
      return;
    }
    _ret.rows = r.data.rows || [];
    _ret.summary = r.data.summary || {};
    retPaint();
  });
}

function retSetBy(k){ _ret.by = k; retPaint(); }
function retSearch(el){ _ret.q = (el.value || "").toLowerCase(); retPaint(); }

function retPaint(){
  var v = document.getElementById("view"), s = _ret.summary;

  var rows = _ret.rows.slice();
  if(_ret.q){
    rows = rows.filter(function(x){
      return ((x.vendor || "") + " " + (x.job_name || "") + " " + (x.job_no || ""))
        .toLowerCase().indexOf(_ret.q) >= 0;
    });
  }
  /* Two orderings because they are two different questions. BY VENDOR is Annette's own model —
     one file per subcontractor. BY JOB is the one her filing cannot answer without opening every
     vendor file that ever worked it, and it is what close-out actually asks. */
  rows.sort(function(a, b){
    if(_ret.by === "job"){
      var j = (a.job_name || a.job_no || "").localeCompare(b.job_name || b.job_no || "");
      if(j) return j;
      return (b.retainage_stated || 0) - (a.retainage_stated || 0);
    }
    return (b.retainage_stated || 0) - (a.retainage_stated || 0);
  });

  // Only figures whose own face sheet foots. Same rule as the server's `held` — see stated_status.
  var shownHeld = rows.reduce(function(a, x){ return a + retHeld(x); }, 0);

  var h = '<div class="panel">'
    + '<div class="h">Retainage held &middot; ' + fmt(s.held || 0) + '</div>'
    + '<div class="sub">'
    + '<b>' + (s.stated_rows || 0) + '</b> of <b>' + (s.rows || 0)
    + '</b> vendor&ndash;job pairs have a figure whose own page foots'
    + ' &middot; ' + (s.vendors || 0) + ' subcontractors &middot; ' + (s.jobs || 0) + ' jobs'
    + ' &middot; ' + (s.apps || 0) + ' pay applications'
    + '</div>';

  /* THE HONEST CAVEATS RIDE ON THE SCREEN, not in a doc nobody opens. Each of these is a real
     condition with a real cause, and each is the reason a number below might be wrong. */
  var warn = [];
  if(s.unstated_rows){
    warn.push('<b class="m-a">' + s.unstated_rows + '</b> pair(s) show '
      + '&mdash; because no application behind them printed a legible line&nbsp;5. '
      + '<b>That is unknown, not zero.</b>');
  }
  if(s.contradicted_rows){
    warn.push('<b class="m-a">' + s.contradicted_rows + '</b> pair(s) are marked <b>?</b> because '
      + 'the face sheet disagrees with itself &mdash; line&nbsp;4 &minus; line&nbsp;5 does not equal '
      + 'line&nbsp;6. Their ' + fmt(s.contradicted_held) + ' is <b>not</b> in the total above; go '
      + 'and look at the document.');
  }
  if(s.excluded_rows){
    warn.push('<b class="m-r">' + s.excluded_rows + '</b> pair(s) contain a pay application with a '
      + 'negative payable &mdash; a misread face sheet. It is excluded from the arithmetic and the '
      + 'row is left visible rather than filtered away.');
  }
  warn.push('Retainage <b>release</b> is not tracked here. A job whose retainage has been paid '
    + 'back still shows its last application&rsquo;s line&nbsp;5 &mdash; check the last-application '
    + 'date before treating a figure as outstanding.');
  h += '<div class="sub" style="margin-top:6px">&#9888; ' + warn.join('<br>&#9888; ') + '</div>';

  h += '<div style="margin-top:8px">'
    + '<button class="pfill" onclick="retSetBy(\'vendor\')"'
    + (_ret.by === "vendor" ? ' disabled' : '') + '>By subcontractor</button> '
    + '<button class="pfill" onclick="retSetBy(\'job\')"'
    + (_ret.by === "job" ? ' disabled' : '') + '>By job</button> '
    + '<input id="ret-q" placeholder="Filter vendor or job" oninput="retSearch(this)" '
    + 'value="' + esc(_ret.q) + '" style="margin-left:8px">'
    + (_ret.q ? ' <span class="sub">' + rows.length + ' shown &middot; '
        + fmt(shownHeld) + '</span>' : '')
    + '</div></div>';

  if(!rows.length){
    v.innerHTML = h + '<div class="panel"><div class="sub">Nothing matches.</div></div>';
    return;
  }

  h += '<div class="panel"><table class="tbl"><tbody>';
  h += '<tr><th>Subcontractor</th><th>Job</th><th style="text-align:right">Held</th>'
    + '<th style="text-align:right">Rate</th><th style="text-align:right">Apps</th>'
    + '<th>Last app</th><th>Check</th></tr>';

  var lastJob = null;
  rows.forEach(function(x){
    if(_ret.by === "job"){
      var jk = x.job_name || x.job_no || "";
      if(jk !== lastJob){
        lastJob = jk;
        var inJob = rows.filter(function(y){ return (y.job_name || y.job_no || "") === jk; });
        var jobTotal = inJob.reduce(function(a, y){ return a + retHeld(y); }, 0);
        /* ⛔ A SUBTOTAL THAT EXCLUDES ROWS MUST SAY SO. INDOT Roselawn has exactly one
           subcontractor, whose figure is contradicted, so its subtotal is $0.00 — and a bare
           "$0.00 held" on a job header reads as "we hold nothing here", which is the same
           misleading zero this screen exists to avoid, one level up. The count of rows the
           subtotal could not use rides beside it. */
        var notCounted = inJob.filter(function(y){ return y.stated_status !== "ok"; }).length;
        h += '<tr><td colspan="7" class="sub" style="padding-top:10px"><b>' + esc(jk)
          + '</b> &middot; ' + fmt(jobTotal) + ' held'
          + (notCounted ? ' <span class="m-a">&middot; ' + notCounted + ' of ' + inJob.length
              + ' not counted</span>' : '')
          + '</td></tr>';
      }
    }

    /* THREE STATES, NOT TWO, AND THEY MUST LOOK DIFFERENT.
         unstated     — the paper did not say. An em dash, never $0.
         contradicted — the paper said, and the same paper disagrees with itself. The figure is
                        shown because it is what was read, but it is NOT set in bold like a settled
                        number: OscarWLarson reads $0.00 against $1,708.80 implied by line 4 minus
                        line 6 on that very sheet, and a confident "$0.00 held" is the more
                        dangerous of the two readings.
         ok           — the face sheet foots. This is the only one that sums into the total. */
    var held;
    if(x.stated_status === "unstated" || x.retainage_stated === null){
      held = '<span class="sub">&mdash;</span>';
    } else if(x.stated_status === "contradicted"){
      held = '<span class="m-a">' + fmt(x.retainage_stated) + '&#8239;?</span>';
    } else {
      held = '<b>' + fmt(x.retainage_stated) + '</b>';
    }

    var checks = [];
    if(x.apps_excluded_unsound > 0){
      checks.push('<span class="m-r">' + x.apps_excluded_unsound + ' unsound</span>');
    }
    if(x.face_sheet_residual !== null && Math.abs(Number(x.face_sheet_residual)) > 1){
      checks.push('<span class="m-a">off by ' + fmt(x.face_sheet_residual) + '</span>');
    }
    if(x.retainage_stated !== null && x.apps_with_stated_retainage < x.apps){
      checks.push('<span class="sub">' + x.apps_with_stated_retainage + ' of ' + x.apps
        + ' read</span>');
    }
    /* The office's own arithmetic, shown ONLY where the view judged it sound and where it
       disagrees with the paper by more than a dollar. It covers just the applications this
       register has seen, so on a contract older than the register a difference is expected and
       says nothing — which is exactly why it is a quiet note and not a flag. */
    if(x.implied_status === "ok" && x.retainage_delta !== null
       && Math.abs(Number(x.retainage_delta)) > 1){
      checks.push('<span class="sub">paper vs register: ' + fmt(x.retainage_delta) + ' over '
        + x.retainage_implied_apps + ' app(s)</span>');
    }

    h += '<tr>'
      + '<td>' + esc(x.vendor || "&mdash;") + '</td>'
      + '<td class="sub">' + esc(x.job_name || x.job_no || "&mdash;") + '</td>'
      + '<td style="text-align:right">' + held + '</td>'
      + '<td style="text-align:right" class="sub">' + retPct(x.retainage_rate_stated) + '</td>'
      + '<td style="text-align:right" class="sub">' + (x.apps || 0) + '</td>'
      + '<td class="sub">' + esc(fmtDate(x.last_app_at) || "") + '</td>'
      + '<td class="sub">' + (checks.join(' &middot; ') || '') + '</td>'
      + '</tr>';
  });

  h += '</tbody></table></div>';
  v.innerHTML = h;
}
