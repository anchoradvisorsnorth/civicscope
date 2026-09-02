"use strict";
/* ryc-invoices/retainage.js — how much are we holding on this subcontractor, on this job.
 *
 * WHAT THIS REPLACES. Annette Wiseman keeps 330 workbooks in SharePoint under
 * Company Share/Accounting Office/Annette's Files/Vendors — one .xlsx per vendor, a worksheet tab
 * per job, 160 of them edited in 2026, maintained by four people. Each tab is
 * `Date | This Period | X% Ret | Current Due` with a totals row, and the live answer is that one
 * total. Getting a JOB's exposure means opening every vendor file that ever worked it.
 *
 * ⛔ TWO DIFFERENT NUMBERS, AND OUTSTANDING IS THE ONE PEOPLE MEAN.
 *   Held        G702 line 5 from the latest filed application — what the PAPER last said.
 *   Outstanding that figure less releases dated AFTER that application — what we STILL hold.
 * They are identical until retainage starts coming back. Retainage billed ON a final application is
 * already inside its line 5, which is why a release dated on or before the last application is
 * counted but not subtracted again (migrations 069/070). This screen leads with Outstanding.
 *
 * ⛔ NULL IS NOT ZERO, AND A CONTRADICTED FIGURE IS NOT SETTLED. Three states, and they must not
 * look alike — see `stated_status`. An em dash means nobody knows; a bold figure means the face
 * sheet foots; a figure marked `?` means the page disagrees with itself and is excluded from every
 * total. Printing $0.00 for an unknown would tell the front office RYC holds nothing on a
 * subcontractor it may be holding plenty on.
 *
 * WHAT IT STILL DOES NOT CAPTURE, said on the screen rather than implied away: the G703 scope-line
 * grid Annette rebuilds in the lower half of each tab, with the `O = C - SUM(F:N)` check she works
 * to zero; and pay-application NUMBERS, which the reader uses to classify a document and discards —
 * so a missing application in a sequence still cannot be detected.
 */

var _ret = { rows: [], view: [], summary: {}, by: "vendor", q: "", releasing: null,
             history: null, msg: "" };

function retPct(x){
  if(x === null || x === undefined) return "";
  return (Math.round(Number(x) * 10000) / 100) + "%";
}

/* ONE RULE, ONE EXPRESSION. What may be added into a total: only a figure whose own face sheet
   foots. The header total, the filtered total and the per-job subtotal were three places for this
   to drift — teaching one about contradicted figures and not the others is how a board contradicts
   itself in plain sight. Mirrors the server's `summary.outstanding`. */
function retOut(x){
  return (x && x.stated_status === "ok" && x.retainage_outstanding !== null)
    ? Number(x.retainage_outstanding) : 0;
}

function renderRetainage(){
  var v = document.getElementById("view");
  var ti = document.getElementById("view-title");
  if(ti) ti.textContent = "Retainage";
  document.getElementById("view-ctx").innerHTML =
    "What we still hold, per subcontractor per job &middot; read off each pay application's "
    + "G702 line&nbsp;5, less what has been released";
  v.innerHTML = '<div class="panel"><div class="sub">Loading retainage&hellip;</div></div>';
  retLoad();
}

function retLoad(){
  return invPost("retainage", {}).then(function(r){
    var v = document.getElementById("view");
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

function retSetBy(k){ _ret.by = k; _ret.releasing = null; _ret.history = null; retPaint(); }
function retSearch(el){ _ret.q = (el.value || "").toLowerCase(); retPaint(); }

/* Rows are addressed by their index in the CURRENTLY PAINTED list, never by name. Vendor names in
   this register include `Midwest Glass & Mirror` and `Circle "R" Electric, Inc.` — putting either
   into an onclick attribute is a quoting bug waiting to happen, and the register's own history has
   a defect from HTML built by concatenation and escaped afterwards. An integer cannot break. */
function retRowAt(i){ return _ret.view[i] || null; }

function retOpenRelease(i){
  _ret.releasing = (_ret.releasing === i) ? null : i;
  _ret.history = null; _ret.msg = "";
  retPaint();
}
function retOpenHistory(i){
  if(_ret.history === i){ _ret.history = null; retPaint(); return; }
  var x = retRowAt(i);
  if(!x) return;
  _ret.history = i; _ret.releasing = null; _ret.msg = "";
  _ret.historyRows = null;
  retPaint();
  invPost("retainage_releases", { vendor: x.vendor, job_no: x.job_no }).then(function(r){
    _ret.historyRows = (r.ok && r.data && r.data.rows) ? r.data.rows : [];
    if(_ret.history === i) retPaint();
  });
}

function retSaveRelease(i, confirmOver){
  var x = retRowAt(i);
  if(!x) return;
  var amt = parseFloat((document.getElementById("rel-amt") || {}).value);
  var on = ((document.getElementById("rel-on") || {}).value || "").trim();
  var method = ((document.getElementById("rel-method") || {}).value || "check");
  var note = ((document.getElementById("rel-note") || {}).value || "").trim();
  var msg = document.getElementById("rel-msg");
  if(!(amt > 0)){ if(msg) msg.innerHTML = '<span class="m-r">Amount must be more than zero.</span>'; return; }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(on)){
    if(msg) msg.innerHTML = '<span class="m-r">A release needs the date the money moved.</span>';
    return;
  }
  if(msg) msg.textContent = "Recording…";
  invPost("retainage_release", { vendor: x.vendor, job_no: x.job_no, amount: amt,
                                 released_on: on, method: method, note: note,
                                 confirm_over: !!confirmOver })
    .then(function(r){
      if(r.ok && r.data && r.data.ok){
        _ret.releasing = null;
        _ret.msg = "Recorded " + fmt(amt) + " released to " + x.vendor + ".";
        retLoad();
        return;
      }
      var e = (r.data && r.data.error) || r.error || "Could not record it.";
      /* A screen that refuses must offer the control that satisfies it, in the same words the
         server used. Over-releasing is possible — the paper can be out of date — so it is
         confirmed, not forbidden. */
      if(r.data && r.data.needs_confirm){
        if(msg){
          msg.innerHTML = '<span class="m-a">' + esc(e) + '</span> '
            + '<button class="pfill" onclick="retSaveRelease(' + i + ',true)">'
            + 'Record it anyway</button>';
        }
        return;
      }
      if(msg) msg.innerHTML = '<span class="m-r">' + esc(e) + '</span>';
    });
}

function retVoidRelease(id, i){
  var reason = window.prompt("Why is this release being voided? (it is kept, not deleted)");
  if(reason === null) return;
  if(!reason.trim()){ return; }
  invPost("retainage_release_void", { id: id, reason: reason.trim() }).then(function(r){
    if(r.ok && r.data && r.data.ok){
      _ret.msg = "Release voided.";
      _ret.history = null;
      retLoad();
    } else {
      _ret.msg = (r.data && r.data.error) || r.error || "Could not void it.";
      retPaint();
    }
  });
}

function retPaint(){
  var v = document.getElementById("view"), s = _ret.summary;

  var rows = _ret.rows.slice();
  if(_ret.q){
    rows = rows.filter(function(x){
      return ((x.vendor || "") + " " + (x.job_name || "") + " " + (x.job_no || ""))
        .toLowerCase().indexOf(_ret.q) >= 0;
    });
  }
  /* Two orderings because they are two different questions. BY SUBCONTRACTOR is Annette's own
     model — one file per sub. BY JOB is what close-out asks and what her filing cannot answer
     without opening every vendor file that ever touched it. */
  rows.sort(function(a, b){
    if(_ret.by === "job"){
      var j = (a.job_name || a.job_no || "").localeCompare(b.job_name || b.job_no || "");
      if(j) return j;
    }
    return retOut(b) - retOut(a);
  });
  _ret.view = rows;

  var shownOut = rows.reduce(function(a, x){ return a + retOut(x); }, 0);

  var h = '<div class="panel">'
    + '<div class="h">Outstanding retainage &middot; ' + fmt(s.outstanding || 0) + '</div>'
    + '<div class="sub">'
    + '<b>' + (s.stated_rows || 0) + '</b> of <b>' + (s.rows || 0)
    + '</b> vendor&ndash;job pairs have a figure whose own page foots'
    + ' &middot; ' + (s.vendors || 0) + ' subcontractors &middot; ' + (s.jobs || 0) + ' jobs'
    + ' &middot; ' + (s.apps || 0) + ' pay applications'
    + ((s.released_total || 0) > 0
        ? ' &middot; ' + fmt(s.released_total) + ' released on ' + (s.released_rows || 0) + ' pair(s)'
        : '')
    + '</div>';

  /* THE CAVEATS RIDE ON THE SCREEN, not in a doc nobody opens. Each names a real condition with a
     real cause, and each is a reason a number below might be wrong. */
  var warn = [];
  if(s.paper_unrecorded_rows){
    warn.push('<b class="m-a">' + s.paper_unrecorded_rows + '</b> pair(s) show line&nbsp;5 coming '
      + '<b>down</b> between applications with nothing recording why &mdash; retainage was almost '
      + 'certainly released. Record it so the outstanding figure is right.');
  }
  if(s.over_released_rows){
    warn.push('<b class="m-r">' + s.over_released_rows + '</b> pair(s) have releases totalling more '
      + 'than the paper says is held.');
  }
  if(s.unstated_rows){
    warn.push('<b class="m-a">' + s.unstated_rows + '</b> pair(s) show &mdash; because no '
      + 'application behind them printed a legible line&nbsp;5. <b>Unknown, not zero.</b>');
  }
  if(s.contradicted_rows){
    warn.push('<b class="m-a">' + s.contradicted_rows + '</b> pair(s) are marked <b>?</b> because '
      + 'the face sheet disagrees with itself &mdash; line&nbsp;4 &minus; line&nbsp;5 does not equal '
      + 'line&nbsp;6. Their ' + fmt(s.contradicted_held) + ' is <b>not</b> in the total above.');
  }
  if(s.excluded_rows){
    warn.push('<b class="m-r">' + s.excluded_rows + '</b> pair(s) contain a pay application with a '
      + 'negative payable &mdash; a misread face sheet, excluded from the arithmetic and left '
      + 'visible rather than filtered away.');
  }
  warn.push('The G703 <b>scope-line grid</b> and pay-application <b>numbers</b> are not captured, '
    + 'so a missing application in a sequence cannot be detected here.');
  h += '<div class="sub" style="margin-top:6px">&#9888; ' + warn.join('<br>&#9888; ') + '</div>';

  h += '<div style="margin-top:8px">'
    + '<button class="pfill" onclick="retSetBy(\'vendor\')"'
    + (_ret.by === "vendor" ? ' disabled' : '') + '>By subcontractor</button> '
    + '<button class="pfill" onclick="retSetBy(\'job\')"'
    + (_ret.by === "job" ? ' disabled' : '') + '>By job</button> '
    + '<input id="ret-q" placeholder="Filter vendor or job" oninput="retSearch(this)" '
    + 'value="' + esc(_ret.q) + '" style="margin-left:8px">'
    + (_ret.q ? ' <span class="sub">' + rows.length + ' shown &middot; '
        + fmt(shownOut) + ' outstanding</span>' : '')
    + '</div>'
    + (_ret.msg ? '<div class="sub" style="margin-top:6px">' + esc(_ret.msg) + '</div>' : '')
    + '</div>';

  if(!rows.length){
    v.innerHTML = h + '<div class="panel"><div class="sub">Nothing matches.</div></div>';
    return;
  }

  h += '<div class="panel"><table class="tbl"><tbody>';
  h += '<tr><th>Subcontractor</th><th>Job</th><th style="text-align:right">Outstanding</th>'
    + '<th style="text-align:right">Held (paper)</th><th style="text-align:right">Released</th>'
    + '<th style="text-align:right">Rate</th><th>Last app</th><th>Check</th><th></th></tr>';

  var lastJob = null;
  rows.forEach(function(x, i){
    if(_ret.by === "job"){
      var jk = x.job_name || x.job_no || "";
      if(jk !== lastJob){
        lastJob = jk;
        var inJob = rows.filter(function(y){ return (y.job_name || y.job_no || "") === jk; });
        var jobTotal = inJob.reduce(function(a, y){ return a + retOut(y); }, 0);
        /* ⛔ A SUBTOTAL THAT EXCLUDES ROWS MUST SAY SO. A bare "$0.00 outstanding" on a job header
           reads as "we hold nothing here", which is the same misleading zero this screen exists to
           avoid, one level up. */
        var notCounted = inJob.filter(function(y){ return y.stated_status !== "ok"; }).length;
        h += '<tr><td colspan="9" class="sub" style="padding-top:10px"><b>' + esc(jk)
          + '</b> &middot; ' + fmt(jobTotal) + ' outstanding'
          + (notCounted ? ' <span class="m-a">&middot; ' + notCounted + ' of ' + inJob.length
              + ' not counted</span>' : '')
          + '</td></tr>';
      }
    }

    var money = function(val){
      if(x.stated_status === "unstated" || val === null || val === undefined){
        return '<span class="sub">&mdash;</span>';
      }
      if(x.stated_status === "contradicted"){
        return '<span class="m-a">' + fmt(val) + '&#8239;?</span>';
      }
      return fmt(val);
    };
    var outCell = (x.stated_status === "ok")
      ? '<b>' + fmt(x.retainage_outstanding) + '</b>' : money(x.retainage_outstanding);

    var checks = [];
    if(x.release_status === "paper_unrecorded"){
      checks.push('<span class="m-a">paper shows ' + fmt(x.paper_released)
        + ' released &mdash; unrecorded</span>');
    }
    if(x.release_status === "over_released"){ checks.push('<span class="m-r">over-released</span>'); }
    if(x.release_status === "in_paper"){
      checks.push('<span class="sub">release already in the paper</span>');
    }
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

    h += '<tr>'
      + '<td>' + esc(x.vendor || "") + '</td>'
      + '<td class="sub">' + esc(x.job_name || x.job_no || "") + '</td>'
      + '<td style="text-align:right">' + outCell + '</td>'
      + '<td style="text-align:right" class="sub">' + money(x.retainage_stated) + '</td>'
      + '<td style="text-align:right" class="sub">'
        + ((Number(x.released_total) > 0) ? fmt(x.released_total) : '') + '</td>'
      + '<td style="text-align:right" class="sub">' + retPct(x.retainage_rate_stated) + '</td>'
      + '<td class="sub">' + esc(fmtDate(x.last_app_at) || "") + '</td>'
      + '<td class="sub">' + (checks.join(' &middot; ') || '') + '</td>'
      + '<td style="text-align:right"><button class="pfill" onclick="retOpenRelease(' + i + ')">'
        + 'Release</button>'
        + (Number(x.releases_count) > 0
            ? ' <button class="pfill" onclick="retOpenHistory(' + i + ')">'
              + x.releases_count + '</button>' : '')
      + '</td></tr>';

    if(_ret.releasing === i){
      var today = new Date().toISOString().slice(0, 10);
      h += '<tr><td colspan="9">'
        + '<div class="sub" style="margin-bottom:4px">Record retainage returned to <b>'
        + esc(x.vendor) + '</b> on <b>' + esc(x.job_name || x.job_no) + '</b>. '
        + 'A release dated on or before the last application (' + esc(fmtDate(x.last_app_at) || "")
        + ') is treated as already shown in that application&rsquo;s line&nbsp;5 and is not '
        + 'subtracted again.</div>'
        + '<input id="rel-amt" type="number" step="0.01" placeholder="Amount" style="width:120px"> '
        + '<input id="rel-on" type="date" value="' + today + '"> '
        + '<select id="rel-method">'
          + '<option value="check">Check</option>'
          + '<option value="final_application">Billed on the final application</option>'
          + '<option value="credit">Credit</option>'
          + '<option value="other">Other</option>'
        + '</select> '
        + '<input id="rel-note" placeholder="Note (check no., reference)" style="width:220px"> '
        + '<button class="pfill" onclick="retSaveRelease(' + i + ')">Record</button> '
        + '<button class="pfill" onclick="retOpenRelease(' + i + ')">Cancel</button>'
        + '<div id="rel-msg" class="sub" style="margin-top:6px"></div>'
        + '</td></tr>';
    }

    if(_ret.history === i){
      h += '<tr><td colspan="9">';
      if(!_ret.historyRows){
        h += '<div class="sub">Loading releases&hellip;</div>';
      } else if(!_ret.historyRows.length){
        h += '<div class="sub">No releases recorded.</div>';
      } else {
        h += '<table class="tbl"><tbody>';
        _ret.historyRows.forEach(function(r2){
          h += '<tr><td class="sub">' + esc(fmtDate(r2.released_on) || "") + '</td>'
            + '<td>' + (r2.voided_at ? '<s class="sub">' + fmt(r2.amount) + '</s>' : fmt(r2.amount))
            + '</td>'
            + '<td class="sub">' + esc(r2.method || "") + ' &middot; ' + esc(r2.source || "") + '</td>'
            + '<td class="sub">' + esc(r2.note || "") + '</td>'
            + '<td class="sub">' + (r2.voided_at
                ? '<span class="m-r">voided</span> &middot; ' + esc(r2.void_reason || "")
                : '<button class="pfill" onclick="retVoidRelease(\'' + esc(r2.id) + '\','
                  + i + ')">Void</button>') + '</td></tr>';
        });
        h += '</tbody></table>';
      }
      h += '</td></tr>';
    }
  });

  h += '</tbody></table></div>';
  v.innerHTML = h;
}
