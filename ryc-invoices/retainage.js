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
/* THE DRILL-DOWN IS THE POINT, NOT A DETAIL VIEW.
   Keith: *"where does she see history, it seems the payapp to payapp from week to week is the
   important insight her spreadsheet offers."* Her tab is a row per pay application and the running
   story down it is what she keeps the file for; the total at the bottom is a by-product. */
function retOpenHistory(i){
  if(_ret.history === i){ _ret.history = null; retPaint(); return; }
  var x = retRowAt(i);
  if(!x) return;
  _ret.history = i; _ret.releasing = null; _ret.msg = "";
  _ret.detail = null;
  retPaint();
  invPost("retainage_detail", { vendor: x.vendor, job_no: x.job_no }).then(function(r){
    _ret.detail = (r.ok && r.data && r.data.ok) ? r.data : { applications: [], releases: [] };
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

/* THE TIMELINE — Annette's tab, rebuilt from the register.
   Applications and releases INTERLEAVED, oldest first, because that is how she keeps it: a release
   is a row in the same table whose date cell reads `pd retainage` or `Final Retention`. Splitting
   them into two lists would make this differ in shape from the thing the office already reads. */
function retTimeline(x){
  var d = _ret.detail;
  if(!d){ return '<div class="sub">Loading&hellip;</div>'; }
  var apps = d.applications || [], rels = d.releases || [];
  if(!apps.length && !rels.length){ return '<div class="sub">Nothing on file.</div>'; }

  var ev = [];
  apps.forEach(function(a){ ev.push({ at: a.at, kind: "app", a: a }); });
  rels.forEach(function(r){ ev.push({ at: r.released_on, kind: "rel", r: r }); });
  ev.sort(function(p, q){ return p.at < q.at ? -1 : p.at > q.at ? 1 : 0; });

  var h = '<div class="sub" style="margin:2px 0 8px">'
    + '<b>' + esc(x.vendor) + '</b> &middot; ' + esc(x.job_name || x.job_no)
    + ' &mdash; every pay application on file, oldest first. <b>Retainage this period</b> is the '
    + 'difference between one application&rsquo;s line&nbsp;5 and the previous one&rsquo;s; '
    + 'Annette derives the same figure the other way, as this period &times; the rate, so the two '
    + 'are independent reads of one number.</div>';

  h += '<div class="ptable-wrap"><table class="ptable"><thead><tr>'
    + '<th>Date</th><th>Doc</th><th class="r">This period</th>'
    + '<th class="r">Retainage this period</th><th class="r">Rate</th>'
    + '<th class="r">Retainage to date</th><th class="r">Current due</th>'
    + '<th class="r">Completed to date</th><th></th>'
    + '</tr></thead><tbody>';

  ev.forEach(function(e){
    if(e.kind === "rel"){
      var r = e.r;
      /* Her own convention: the release sits in the date column where a date would be. */
      h += '<tr class="static"><td class="sub">' + esc(fmtDate(r.released_on) || "") + '</td>'
        + '<td class="sub"><b>' + (r.voided_at ? "release (voided)" : "retainage released")
        + '</b></td>'
        + '<td class="r sub"></td>'
        + '<td class="r">' + (r.voided_at
            ? '<s class="sub">-' + retMoney(r.amount) + '</s>'
            : '<span class="m-a">-' + retMoney(r.amount) + '</span>') + '</td>'
        + '<td class="r sub"></td><td class="r sub"></td>'
        + '<td class="r sub">' + (r.voided_at ? '' : retMoney(r.amount)) + '</td>'
        + '<td class="r sub"></td>'
        + '<td class="sub">' + esc(r.method || "") + (r.note ? " &middot; " + esc(r.note) : "")
          + (r.voided_at ? ' &middot; <span class="m-r">voided</span>: '
              + esc(r.void_reason || "") : '')
        + '</td></tr>';
      return;
    }
    var a = e.a;
    var dash = '<span class="sub">&mdash;</span>';
    h += '<tr class="static"><td class="sub">' + esc(fmtDate(a.at) || "") + '</td>'
      + '<td class="sub">' + (a.url
          ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener">'
            + esc(a.invoice_no || "application") + '</a>'
          : esc(a.invoice_no || "application"))
        + (a.pages ? ' <span class="sub">p' + esc(a.pages) + '</span>' : '')
      + '</td>'
      + '<td class="r">' + (a.work_this_period === null ? dash : retMoney(a.work_this_period))
        + '</td>'
      /* ⛔ NULL, NOT ZERO. A missing line 5 on either end makes the difference unknowable, and
         showing 0 would assert a period in which nothing was withheld. */
      + '<td class="r">' + (a.retainage_this_period === null ? dash
          : retMoney(a.retainage_this_period)) + '</td>'
      + '<td class="r sub">' + (a.rate_this_period === null ? "" : retPct(a.rate_this_period))
        + '</td>'
      + '<td class="r sub">' + (a.retainage === null ? dash : retMoney(a.retainage)) + '</td>'
      + '<td class="r">' + (a.amount === null ? dash : retMoney(a.amount)) + '</td>'
      + '<td class="r sub">' + (a.completed_to_date === null ? dash
          : retMoney(a.completed_to_date)) + '</td>'
      + '<td class="sub">'
        + ((a.amount !== null && Number(a.amount) < 0)
            ? '<span class="m-r">negative payable &mdash; misread face sheet</span>' : '')
      + '</td></tr>';
  });
  h += '</tbody></table></div>';

  if(rels.length){
    h += '<div style="margin-top:6px">';
    rels.forEach(function(r){
      if(r.voided_at) return;
      h += '<button class="pfill" onclick="retVoidRelease(\'' + esc(r.id) + '\','
        + _ret.history + ')">Void ' + retMoney(r.amount) + ' of '
        + esc(fmtDate(r.released_on) || "") + '</button> ';
    });
    h += '</div>';
  }
  return h;
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
    + '<button class="pfill' + (byJob ? '' : ' on') + '" onclick="retSetBy(\'vendor\')">'
      + 'By subcontractor</button> '
    + '<button class="pfill' + (byJob ? ' on' : '') + '" onclick="retSetBy(\'job\')">'
      + 'By job</button> '
    + '<input id="ret-q" placeholder="Filter vendor or job" oninput="retSearch(this)" '
    + 'value="' + esc(_ret.q) + '" style="margin-left:8px">'
    + (_ret.q ? ' <span class="sub">' + rows.length + ' shown &middot; '
        + retMoney(shownOut) + ' outstanding</span>' : '')
    + '</div>'
    + '<div class="sub" style="margin-top:8px">'
    + '<b>History</b> opens every pay application on file for that subcontractor and job, oldest '
    + 'first &mdash; the week-to-week table Annette keeps, with retainage per period alongside the '
    + 'to-date figure off the paper. <b>Record release</b> writes down that retainage was paid back: '
    + 'it lowers <b>Outstanding</b>, moves no money, and does not touch <b>Held</b>, which is always '
    + 'what the last face sheet said.'
    + '</div>'
    + (_ret.msg ? '<div class="sub" style="margin-top:6px"><b>' + esc(_ret.msg) + '</b></div>' : '')
    + '</div>';

  if(!rows.length){
    v.innerHTML = h + '<div class="panel"><div class="sub">Nothing matches.</div></div>';
    return;
  }

  /* ⛔ `.ptable`, NOT `.tbl`. `.tbl` is not defined in ANY stylesheet in this app — the first
     version used it throughout, so the table had no padding, no header treatment and no column
     separation at all, which is why the headers ran together into "Outstanding Held (paper) Rate
     Last app Check". `.ptable` is the real one: padded cells, small-caps sticky headers, tabular
     numerals, `.r` for right alignment, row hover. */
  var cols = 6 + (byJob ? 0 : 1) + (showReleased ? 1 : 0);

  h += '<div class="ptable-wrap"><table class="ptable"><thead><tr>'
    + '<th>Subcontractor</th>'
    + (byJob ? '' : '<th>Job</th>')
    + '<th class="r">Outstanding</th>'
    + '<th class="r">Held (paper)</th>'
    + (showReleased ? '<th class="r">Released</th>' : '')
    + '<th class="r">Rate</th>'
    + '<th>Last app</th>'
    + '<th class="r">Apps</th>'
    + '<th></th></tr></thead><tbody>';

  var lastJob = null;
  rows.forEach(function(x, i){
    if(byJob){
      var jk = x.job_name || x.job_no || "";
      if(jk !== lastJob){
        lastJob = jk;
        var inJob = rows.filter(function(y){ return (y.job_name || y.job_no || "") === jk; });
        var jobTotal = inJob.reduce(function(a, y){ return a + retOut(y); }, 0);
        var notCounted = inJob.filter(function(y){ return y.stated_status !== "ok"; }).length;
        h += '<tr class="static"><td colspan="' + cols + '" style="background:#f7f9fc">'
          + '<b>' + esc(jk) + '</b> &middot; ' + retMoney(jobTotal) + ' outstanding'
          + (notCounted ? ' <span class="m-a">&middot; ' + notCounted + ' of ' + inJob.length
              + ' not counted</span>' : '')
          + '</td></tr>';
      }
    }

    /* THREE STATES AND THEY MUST NOT LOOK ALIKE. Em dash = nobody knows. A figure marked ? = the
       page disagrees with itself and is in no total. A plain figure = the face sheet foots. */
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

    /* The flags ride UNDER the subcontractor name rather than in a column of their own. They are
       rare, they are prose, and a dedicated column for them was empty on almost every row while
       squeezing the figures. */
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

    h += '<tr class="static">'
      + '<td><div class="jname" style="max-width:230px">' + esc(x.vendor || "") + '</div>'
        + (checks.length ? '<div class="sub" style="white-space:normal;max-width:230px">'
            + checks.join(' &middot; ') + '</div>' : '')
      + '</td>'
      + (byJob ? '' : '<td class="sub"><div style="max-width:220px;overflow:hidden;'
          + 'text-overflow:ellipsis">' + esc(x.job_name || x.job_no || "") + '</div></td>')
      + '<td class="r">' + outCell + '</td>'
      + '<td class="r sub">' + cell(x.retainage_stated) + '</td>'
      + (showReleased
          ? '<td class="r sub">'
            + ((Number(x.released_total) > 0) ? retMoney(x.released_total) : '') + '</td>' : '')
      + '<td class="r sub">' + retPct(x.retainage_rate_stated) + '</td>'
      + '<td class="sub">' + esc(fmtDate(x.last_app_at) || "") + '</td>'
      + '<td class="r sub">' + (x.apps || 0) + '</td>'
      + '<td class="r">'
        + '<button class="pfill' + (_ret.history === i ? ' on' : '')
          + '" onclick="retOpenHistory(' + i + ')">History</button> '
        + '<button class="pfill' + (_ret.releasing === i ? ' on' : '')
          + '" onclick="retOpenRelease(' + i + ')">Record release</button>'
      + '</td></tr>';

    if(_ret.releasing === i){
      var today = new Date().toISOString().slice(0, 10);
      h += '<tr class="static"><td colspan="' + cols + '" style="white-space:normal">'
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
      h += '<tr class="static"><td colspan="' + cols + '" style="white-space:normal;'
        + 'background:#fbfcfe">' + retTimeline(x) + '</td></tr>';
    }
  });

  h += '</tbody></table></div>'
    /* The standing limitations live here, once, under the data. A permanent warning printed above
       every screenful is one people learn to scroll past, taking the ones that change with it. */
    + '<div class="sub" style="margin-top:10px">'
    + '<b>Held (paper)</b> is G702 line&nbsp;5 from the latest filed application; <b>Outstanding</b> '
    + 'is that figure less releases recorded after it. Not captured: the G703 <b>scope-line grid</b>, '
    + 'and pay-application <b>numbers</b> &mdash; so a missing application in a sequence cannot be '
    + 'detected here.'
    + '</div>';
  v.innerHTML = h;
}
