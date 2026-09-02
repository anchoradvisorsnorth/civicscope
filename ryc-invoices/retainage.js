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

/* CENTS, NOT WHOLE DOLLARS. RYCFormat.exact() rounds - right for contract and bid values, wrong
   here. This screen exists to be reconciled against Annette's workbooks, which carry cents
   ($270,598.52 of retainage on Fleming Excavating alone), and $106,672 shown against her
   $106,671.53 reads as a discrepancy that is not there. The shared formatter is deliberately NOT
   changed: it has other callers and a parity guard. */
function retMoney(n){
  if(n === null || n === undefined || n === "") return "";
  var v = Number(n);
  if(!isFinite(v)) return "";
  return (v < 0 ? "-$" : "$")
    + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits:2, maximumFractionDigits:2 });
}

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
        _ret.msg = "Recorded " + retMoney(amt) + " released to " + x.vendor + ".";
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

  var byJob = (_ret.by === "job");
  /* A column nobody can fill is noise. Released is empty on every row until the first release is
     recorded, and sitting between "Held (paper)" and "Rate" it made the header read as one
     mangled label. It appears when there is something to put in it. */
  var showReleased = rows.some(function(x){ return Number(x.released_total) > 0; });
  var shownOut = rows.reduce(function(a, x){ return a + retOut(x); }, 0);

  var h = '<div class="panel">'
    + '<div class="h">Outstanding retainage &middot; ' + retMoney(s.outstanding || 0) + '</div>'
    + '<div class="sub">'
    + '<b>' + (s.stated_rows || 0) + '</b> of <b>' + (s.rows || 0)
    + '</b> vendor&ndash;job pairs have a figure whose own page foots'
    + ' &middot; ' + (s.vendors || 0) + ' subcontractors &middot; ' + (s.jobs || 0) + ' jobs'
    + ' &middot; ' + (s.apps || 0) + ' pay applications'
    + ((s.released_total || 0) > 0
        ? ' &middot; ' + retMoney(s.released_total) + ' released on ' + (s.released_rows || 0)
          + ' pair(s)' : '')
    + '</div>';

  /* Only conditions that are TRUE OF THE DATA IN FRONT OF YOU belong up here. The standing
     limitations moved to a footnote under the table: a permanent caveat repeated above every
     screenful is one people stop reading, and it was crowding out the three that change. */
  var warn = [];
  if(s.paper_unrecorded_rows){
    warn.push('<b class="m-a">' + s.paper_unrecorded_rows + '</b> pair(s) show line&nbsp;5 coming '
      + '<b>down</b> between applications with nothing recording why &mdash; retainage was almost '
      + 'certainly released. Record it so Outstanding is right.');
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
      + 'the face sheet disagrees with itself &mdash; line&nbsp;4 &minus; line&nbsp;5 does not '
      + 'equal line&nbsp;6. Their ' + retMoney(s.contradicted_held) + ' is <b>not</b> in the total.');
  }
  if(s.excluded_rows){
    warn.push('<b class="m-r">' + s.excluded_rows + '</b> pair(s) contain a pay application with a '
      + 'negative payable &mdash; a misread face sheet, excluded from the arithmetic and left '
      + 'visible rather than filtered away.');
  }
  if(warn.length){
    h += '<div class="sub" style="margin-top:6px">&#9888; ' + warn.join('<br>&#9888; ') + '</div>';
  }

  h += '<div style="margin-top:10px">'
    /* `.pfill.on` is the shell's own selected state. The first version used `disabled`, which
       renders almost identically to an idle button — you could click By job and not see it take. */
    + '<button class="pfill' + (byJob ? '' : ' on') + '" onclick="retSetBy(\'vendor\')">'
      + 'By subcontractor</button> '
    + '<button class="pfill' + (byJob ? ' on' : '') + '" onclick="retSetBy(\'job\')">'
      + 'By job</button> '
    + '<input id="ret-q" placeholder="Filter vendor or job" oninput="retSearch(this)" '
    + 'value="' + esc(_ret.q) + '" style="margin-left:8px">'
    + (_ret.q ? ' <span class="sub">' + rows.length + ' shown &middot; '
        + retMoney(shownOut) + ' outstanding</span>' : '')
    + '</div>'
    /* THE ROW ACTION HAS TO SAY WHAT IT DOES BEFORE IT IS PRESSED. "Release" alone reads like it
       might pay somebody. It records, against this subcontractor and job, that retainage already
       went back — it moves no money and touches nothing in SharePoint. */
    + '<div class="sub" style="margin-top:8px">'
    + '<b>Record release</b> writes down that retainage was paid back to that subcontractor on that '
    + 'job. It lowers <b>Outstanding</b>; it does not move money, change the pay application, or '
    + 'touch <b>Held (paper)</b>, which is always what the last face sheet said. A release dated on '
    + 'or before that application is treated as already shown in its line&nbsp;5 and is not '
    + 'subtracted twice. Releases are kept and can be voided, never deleted.'
    + '</div>'
    + (_ret.msg ? '<div class="sub" style="margin-top:6px"><b>' + esc(_ret.msg) + '</b></div>' : '')
    + '</div>';

  if(!rows.length){
    v.innerHTML = h + '<div class="panel"><div class="sub">Nothing matches.</div></div>';
    return;
  }

  var NUM = ' style="text-align:right;white-space:nowrap"';
  var cols = 4 + (byJob ? 0 : 1) + (showReleased ? 1 : 0) + 2;   // +Check +action

  h += '<div class="panel"><table class="tbl"><tbody>';
  h += '<tr><th>Subcontractor</th>'
    + (byJob ? '' : '<th>Job</th>')
    + '<th' + NUM + '>Outstanding</th>'
    + '<th' + NUM + '>Held (paper)</th>'
    + (showReleased ? '<th' + NUM + '>Released</th>' : '')
    + '<th' + NUM + '>Rate</th>'
    + '<th style="white-space:nowrap">Last app</th>'
    + '<th>Check</th><th></th></tr>';

  var lastJob = null;
  rows.forEach(function(x, i){
    if(byJob){
      var jk = x.job_name || x.job_no || "";
      if(jk !== lastJob){
        lastJob = jk;
        var inJob = rows.filter(function(y){ return (y.job_name || y.job_no || "") === jk; });
        var jobTotal = inJob.reduce(function(a, y){ return a + retOut(y); }, 0);
        /* A SUBTOTAL THAT EXCLUDES ROWS MUST SAY SO. A bare "$0.00 outstanding" on a job header
           reads as "we hold nothing here", the same misleading zero one level up. */
        var notCounted = inJob.filter(function(y){ return y.stated_status !== "ok"; }).length;
        h += '<tr><td colspan="' + cols + '" class="sub" style="padding-top:12px"><b>' + esc(jk)
          + '</b> &middot; ' + retMoney(jobTotal) + ' outstanding'
          + (notCounted ? ' <span class="m-a">&middot; ' + notCounted + ' of ' + inJob.length
              + ' not counted</span>' : '')
          + '</td></tr>';
      }
    }

    /* THREE STATES AND THEY MUST NOT LOOK ALIKE. An em dash means nobody knows. A figure marked ?
       means the page disagrees with itself and is in no total. A plain figure means the face sheet
       foots. Printing $0.00 for an unknown would say RYC holds nothing on a subcontractor it may be
       holding plenty on. */
    var cell = function(val){
      if(x.stated_status === "unstated" || val === null || val === undefined){
        return '<span class="sub">&mdash;</span>';
      }
      if(x.stated_status === "contradicted"){
        return '<span class="m-a">' + retMoney(val) + '&#8239;?</span>';
      }
      return retMoney(val);
    };
    var outCell = (x.stated_status === "ok")
      ? '<b>' + retMoney(x.retainage_outstanding) + '</b>' : cell(x.retainage_outstanding);

    var checks = [];
    if(x.release_status === "paper_unrecorded"){
      checks.push('<span class="m-a">paper shows ' + retMoney(x.paper_released)
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
      checks.push('<span class="m-a">page off by ' + retMoney(x.face_sheet_residual) + '</span>');
    }
    if(x.retainage_stated !== null && x.apps_with_stated_retainage < x.apps){
      checks.push('<span class="sub">' + x.apps_with_stated_retainage + ' of ' + x.apps
        + ' read</span>');
    }

    h += '<tr>'
      + '<td>' + esc(x.vendor || "") + '</td>'
      + (byJob ? '' : '<td class="sub">' + esc(x.job_name || x.job_no || "") + '</td>')
      + '<td' + NUM + '>' + outCell + '</td>'
      + '<td' + NUM + ' class="sub">' + cell(x.retainage_stated) + '</td>'
      + (showReleased
          ? '<td' + NUM + ' class="sub">'
            + ((Number(x.released_total) > 0) ? retMoney(x.released_total) : '') + '</td>' : '')
      + '<td' + NUM + ' class="sub">' + retPct(x.retainage_rate_stated) + '</td>'
      + '<td class="sub" style="white-space:nowrap">' + esc(fmtDate(x.last_app_at) || "") + '</td>'
      + '<td class="sub">' + (checks.join(' &middot; ') || '') + '</td>'
      + '<td style="text-align:right;white-space:nowrap">'
        + '<button class="pfill' + (_ret.releasing === i ? ' on' : '')
        + '" onclick="retOpenRelease(' + i + ')">Record release</button>'
        + (Number(x.releases_count) > 0
            ? ' <button class="pfill' + (_ret.history === i ? ' on' : '')
              + '" onclick="retOpenHistory(' + i + ')">'
              + x.releases_count + ' release' + (x.releases_count > 1 ? 's' : '') + '</button>' : '')
      + '</td></tr>';

    if(_ret.releasing === i){
      var today = new Date().toISOString().slice(0, 10);
      h += '<tr><td colspan="' + cols + '">'
        + '<div class="sub" style="margin-bottom:6px">Retainage returned to <b>'
        + esc(x.vendor) + '</b> on <b>' + esc(x.job_name || x.job_no) + '</b>. '
        + 'Dated on or before the last application (' + esc(fmtDate(x.last_app_at) || "")
        + ') it is treated as already shown in that application&rsquo;s line&nbsp;5 and is not '
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
        + '<button class="pfill on" onclick="retSaveRelease(' + i + ')">Record</button> '
        + '<button class="pfill" onclick="retOpenRelease(' + i + ')">Cancel</button>'
        + '<div id="rel-msg" class="sub" style="margin-top:6px"></div>'
        + '</td></tr>';
    }

    if(_ret.history === i){
      h += '<tr><td colspan="' + cols + '">';
      if(!_ret.historyRows){
        h += '<div class="sub">Loading releases&hellip;</div>';
      } else if(!_ret.historyRows.length){
        h += '<div class="sub">No releases recorded.</div>';
      } else {
        h += '<table class="tbl"><tbody>';
        _ret.historyRows.forEach(function(r2){
          h += '<tr><td class="sub" style="white-space:nowrap">'
              + esc(fmtDate(r2.released_on) || "") + '</td>'
            + '<td' + NUM + '>' + (r2.voided_at
                ? '<s class="sub">' + retMoney(r2.amount) + '</s>' : retMoney(r2.amount)) + '</td>'
            + '<td class="sub">' + esc(r2.method || "") + ' &middot; ' + esc(r2.source || "")
              + '</td>'
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

  h += '</tbody></table>'
    /* The standing limitations live here, once, under the data — not above it. They are true every
       day and never change, and a permanent warning printed above every screenful is one people
       learn to scroll past, taking the three that DO change with it. */
    + '<div class="sub" style="margin-top:10px">'
    + '<b>Held (paper)</b> is G702 line&nbsp;5 from the latest filed application; <b>Outstanding</b> '
    + 'is that figure less releases recorded after it. Not captured: the G703 <b>scope-line grid</b>, '
    + 'and pay-application <b>numbers</b> &mdash; so a missing application in a sequence cannot be '
    + 'detected here.'
    + '</div></div>';
  v.innerHTML = h;
}
