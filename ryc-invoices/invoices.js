"use strict";
/* ryc-invoices/invoices.js — the AP register tool.
   Lifted verbatim out of ryc-command/views.js when Invoices became its own workspace
   (Keith, 2026-08-11: "it is a tool like the estimator"). It depends only on
   RYCShell / RYCAuth / RYCFormat from the shared shell and on nothing in Command —
   which is why it could move without being rewritten. */
function esc(s){ if(!s) return ""; var d=document.createElement("div"); d.textContent=s; return d.innerHTML; }
function fmt(n){ return RYCFormat.exact(n); }
function fmtDate(s){ return RYCFormat.date(s); }
/* Job names come from the server as a small number->name map (action 'jobs'), rather than by
   loading Command's whole Procore feed to decorate a header. Degrades to the bare number. */
var _jobNames = {};
function jobByNo(no){ var n=_jobNames[no]; return n ? { name:n } : null; }
/* ===================== INVOICES — PM daily reconciliation (2026-08-11) ==============
   Replaces a manila folder and a four-field rubber stamp.

   REBUILT after Keith worked a real batch (2026-08-11). The first cut put every decision
   behind a "Work it" button that expanded a panel below the row, and listed documents in one
   flat table. Both were wrong for the actual job:
     · A PM reconciling a day's mail is doing the SAME action seventeen times. Making each one
       cost a click to open and a click to close turns a two-minute task into a chore.
     · The folder is one PM's day across a handful of jobs. GROUPING BY JOB is how the work is
       actually thought about — "what hit Shipshewana today" — not vendor by vendor.
   So: grouped by job, every control inline on the row, and one-click Investigate for anything
   a PM wants to come back to rather than reason about now.

   THE SILO: /api/ryc-invoices derives the PM from the CREDENTIAL. There is no `pm` parameter
   this page can send to widen its own scope. Only a front-office credential is scope 'all'. */
var INV_URL = "/api/ryc-invoices";
var _inv = { who:null, rows:[], codes:null, pm:null, busy:false, showDone:false,
             budget:{}, budgetBasis:null, budgetAsOf:null };

/* Budget lines for a job, fetched once per job and cached for the session. This is the number
   the PM currently opens Procore to read — how much is left on the line being coded against. */
function invLoadBudget(job){
  if(!job || _inv.budget[job]) return Promise.resolve(_inv.budget[job]);
  _inv.budget[job] = { loading:true, lines:[] };
  return invPost("budget", { job_no:job }).then(function(r){
    var d = r.ok ? r.data : null;
    if(!d || !d.available){
      _inv.budget[job] = { loading:false, available:false,
        reason:(d&&d.reason)||(r.error||"unavailable"), lines:[] };
    } else {
      _inv.budget[job] = { loading:false, available:true, lines:d.lines||[] };
      _inv.budgetBasis = d.basis; _inv.budgetAsOf = d.asOf;
    }
    return _inv.budget[job];
  });
}
/* TWO NOTATIONS FOR ONE CODE (fixed 2026-08-12). RYC writes `01-002 Site Superintendent` and
   that is what `ryc_invoices.cost_code` stores; Procore's ERP budget view calls the same thing
   `Div 1-01-002` and splits it into six cost types (.BUR .E .L .M .O .S). When the ERP lines
   went live the picker began offering the Procore spelling against a column holding the RYC
   spelling, so every already-coded invoice rendered as uncoded ("no budget line for 01-001")
   and Approve correctly refused it. The stored vocabulary stays RYC's; the ERP line is DERIVED. */
function invBaseCode(code){
  if(!code) return "";
  var m = /^\s*Div\s+\d+-(\d{2}-\d{3})(?:\.([A-Z]+))?\s*$/i.exec(String(code));
  if(m) return m[1];
  m = /^\s*(\d{2}-\d{3})(?:\.([A-Z]+))?\s*$/.exec(String(code));
  return m ? m[1] : String(code).trim();
}
/* "Circle Mat or Sub" is not bookkeeping — it picks the budget line. A material invoice hits
   the .M line and a subcontract hits .S, and one can be healthy while the other is blown. Those
   are the only two a vendor invoice can land on: .L/.E/.O/.BUR are RYC's own labour, equipment,
   other and burden, which nobody bills us for. */
function invLineSuffix(ms){
  return ms === "sub" ? "S" : (ms === "mat" ? "M" : null);
}
function invMsFor(id, r){
  var el = document.getElementById("ms-" + id);
  return (el && el.value) || (r && r.mat_or_sub) || "";
}
/* Resolve RYC code + Mat/Sub -> the ERP line. Returns null when that specific combination has
   no line on this job, which is a real answer worth showing, not a reason to fall back to a
   different line and quietly report someone else's remaining balance. */
function invBudgetLine(job, code, ms){
  var b=_inv.budget[job];
  if(!b || !b.available || !code) return null;
  var base = invBaseCode(code), suffix = invLineSuffix(ms);
  var i, exact = null;
  for(i=0;i<b.lines.length;i++){
    var l = b.lines[i];
    if(invBaseCode(l.code) !== base) continue;
    if(suffix && new RegExp("\\." + suffix + "$", "i").test(String(l.code))) exact = l;
    // Legacy rows coded during the one day the picker offered Procore's spelling directly.
    if(!suffix && String(l.code) === String(code)) exact = l;
  }
  // Deliberately NO "first line with this base" fallback. Without Mat/Sub the code alone does
  // not identify a line — .BUR would answer first and report burden's balance as if it were the
  // material balance. A wrong number here is worse than no number: it is the exact figure the
  // PM is deciding against.
  return exact;
}
/* The distinct RYC codes this job actually has budget on, in code order, with the name taken
   from RYC's own catalog rather than Procore's (which is blank on these rows). */
function invJobCodes(job){
  var b=_inv.budget[job];
  if(!b || !b.available || !b.lines.length) return [];
  var seen = {}, out = [];
  b.lines.forEach(function(l){
    var base = invBaseCode(l.code);
    if(!base || seen[base]) return;
    seen[base] = 1;
    var name = "";
    if(_inv.codes) for(var i=0;i<_inv.codes.length;i++)
      if(_inv.codes[i].code === base){ name = _inv.codes[i].description || ""; break; }
    out.push({ code: base, name: name });
  });
  out.sort(function(a,b2){ return a.code < b2.code ? -1 : (a.code > b2.code ? 1 : 0); });
  return out;
}
/* The remaining figure, named. "Remaining" alone would be ambiguous — over/under and
   uncommitted are different numbers — so the label always says which basis is in play. */
function invBasisLabel(){
  return _inv.budgetBasis==="uncommitted"
    ? "revised &minus; committed &minus; spent"
    : "Procore projected over/under";
}

function invLinkKey(){ return (new URLSearchParams(location.search)).get("k"); }
/* A PM's own standing code, carried in the URL, so each person has ONE permanent address that
   just opens their desk — no code to type, no shared workspace password, and nothing to expire
   in the middle of a trial. `?k=` remains the time-boxed signed link for emailed notifications.

   This is a credential in a URL and is treated as exactly that: it resolves to ONE PM and can
   reach nothing but that PM's own queue, the tool is the only thing it opens, and it is
   replaced wholesale by per-user sign-in. Recorded rather than glossed over. */
function invUrlCode(){ return (new URLSearchParams(location.search)).get("c"); }
function invPost(action, body){
  var b = Object.assign({}, body || {}, { action: action });
  var k = invLinkKey(), c = invUrlCode();
  if(k) b.k = k;                       // the emailed one-click link IS the credential
  else if(c) b.code = c;               // this PM's own standing address
  else b.code = RYCAuth.gate();
  return fetch(INV_URL, { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(b) })
    .then(function(r){ return r.text().then(function(t){
      var d = null; try { d = JSON.parse(t); } catch(e){}
      if(!r.ok || d === null) return { ok:false, status:r.status, error:(d&&d.error)||("HTTP "+r.status) };
      return { ok:true, data:d };
    }); })
    .catch(function(e){ return { ok:false, error:(e&&e.message)||"network error" }; });
}

/* Findings are RANKED, not listed: a $55,927.77 exact duplicate and an available early-pay
   discount are not the same kind of news and must not look alike. `hard` findings are the
   ones that block approval until cleared. */
var INV_FLAG = {
  duplicate_exact:        { t:"Duplicate",        c:"m-r", hard:true  },
  vendor_marked_duplicate:{ t:"Vendor: DUPLICATE",c:"m-r", hard:true  },
  pages_missing:          { t:"Pages missing",    c:"m-r", hard:true  },
  not_ap_suspected:       { t:"Already paid?",    c:"m-r", hard:true  },
  duplicate_suspected:    { t:"Possible dup",     c:"m-a" },
  stale_invoice:          { t:"Stale",            c:"m-a" },
  job_unassigned:         { t:"No job",           c:"m-a" },
  unrouted:               { t:"Unrouted",         c:"m-a" },
  discount_available:     { t:"Discount",         c:"m-m" }
};
var INV_STATE = { "new":"", ready:"", needs_info:"Investigating", approved:"Approved",
  rejected:"Rejected", not_ap:"Not payable", duplicate:"Duplicate" };

function invArg(s){ return JSON.stringify(String(s)).replace(/"/g, "&quot;"); }
function invOpenFlags(r){ return (r.flags||[]).filter(function(f){ return !f.resolved_at; }); }
function invHardFlags(r){
  return invOpenFlags(r).filter(function(f){ var m=INV_FLAG[f.code]; return m && m.hard; });
}
function invDone(r){ return r.review_state!=="new" && r.review_state!=="ready"; }

function renderInvoices(){
  var v = document.getElementById("view");
  v.innerHTML = '<div class="panel"><div class="sub">Loading&hellip;</div></div>';
  invPost("whoami", {}).then(function(r){
    if(!r.ok){
      v.innerHTML = '<div class="panel"><div class="h">Invoices</div>'
        + '<div class="warn-banner">' + esc(r.error||"Unavailable") + '</div></div>';
      return;
    }
    _inv.who = r.data; _inv.pm = r.data.pm || null;
    if(!_inv.codes) invPost("cost_codes", {}).then(function(c){
      if(c.ok){ _inv.codes = c.data.codes || []; invPaint(); }
    });
    invPost("jobs", {}).then(function(j){
      if(j.ok && j.data && j.data.names){ _jobNames = j.data.names; invPaint(); }
    });
    invLoad();
  });
}
function invLoad(){
  var body = { days:30 };
  if(_inv.who && _inv.who.scope === "all" && _inv.pm) body.pm = _inv.pm;
  return invPost("queue", body).then(function(r){
    var v = document.getElementById("view");
    if(!r.ok){
      v.innerHTML = '<div class="panel"><div class="h">Invoices</div>'
        + '<div class="warn-banner">' + esc(r.error) + '</div></div>';
      return;
    }
    _inv.rows = r.data.rows || [];
    invPaint();
    // Budget lines per job, then repaint — the queue must not wait on Procore to render.
    var jobs = {};
    _inv.rows.forEach(function(x){ if(x.job_no) jobs[x.job_no]=1; });
    var pending = Object.keys(jobs).filter(function(j){ return !_inv.budget[j]; });
    if(pending.length){
      Promise.all(pending.map(invLoadBudget)).then(function(){ invPaint(); });
    }
  });
}

/* ---- grouping: BY JOB, because that is how the day is actually thought about ---- */
function invGroups(rows){
  var by = {}, order = [];
  rows.forEach(function(r){
    var k = r.job_no || " none";
    if(!by[k]){ by[k] = { job:r.job_no, rows:[], total:0, open:0, hard:0 }; order.push(k); }
    by[k].rows.push(r);
    by[k].total += Number(r.amount) || 0;
    if(!invDone(r)) by[k].open++;
    if(invHardFlags(r).length) by[k].hard++;
  });
  // unassigned last — it is a worklist, not a job
  order.sort(function(a,b){
    if(a === " none") return 1;
    if(b === " none") return -1;
    return by[b].total - by[a].total;
  });
  return order.map(function(k){ return by[k]; });
}
// job number -> the name Command already knows, so the header reads like a job not a code
function invJobName(no){
  if(!no) return null;
  var j = (typeof jobByNo === "function") ? jobByNo(no) : null;
  return j ? (j.name || null) : null;
}

function invPaint(){
  var v = document.getElementById("view"), who = _inv.who || {};
  var rows = _inv.rows;
  var open = rows.filter(function(r){ return !invDone(r); });
  var done = rows.filter(invDone);
  var hard = open.filter(function(r){ return invHardFlags(r).length; });
  var val  = open.reduce(function(a,r){ return a + (Number(r.amount)||0); }, 0);

  var h = '<div class="panel"><div class="h">'
    + (who.scope === "pm" ? esc(who.pm) : (_inv.pm ? esc(_inv.pm) : "All desks"))
    + ' &middot; ' + open.length + ' to review &middot; ' + fmt(val) + '</div>'
    + '<div class="sub">'
    + (hard.length ? '<b class="m-r">' + hard.length + ' need a look before they can be approved</b> &middot; ' : '')
    + done.length + ' done'
    + (who.scope === "pm"
        ? ' &middot; signed in by ' + (who.via === "link" ? "an emailed link" : "your access code")
          + '; approvals are recorded as attributed but <b>unverified</b> until per-user sign-in'
        : ' &middot; front-office scope')
    + '</div>';
  if(who.scope === "all"){
    h += '<div style="margin-top:8px">'
      + (who.pms||[]).map(function(p){
          return '<button class="pfill" onclick="invSetPm(' + invArg(p) + ')">' + esc(p) + '</button>';
        }).join(" ")
      + ' <button class="pfill" onclick="invSetPm(null)">All desks</button></div>';
  }
  h += '</div>';

  if(who.scope === "all") h += invIntakePanel();

  if(!rows.length){
    v.innerHTML = h + '<div class="panel"><div class="sub">Nothing in the register for this period.</div></div>';
    return;
  }

  invGroups(open).forEach(function(g){ h += invJobPanel(g); });

  if(done.length){
    h += '<div class="panel"><div class="h">Done &middot; ' + done.length + '</div>'
      + '<div style="margin-bottom:6px"><button class="pfill" onclick="invToggleDone()">'
      + (_inv.showDone ? "Hide" : "Show") + '</button></div>';
    if(_inv.showDone){
      h += '<table class="tbl"><tbody>';
      done.forEach(function(r){
        h += '<tr><td><b>' + esc(r.vendor_name||"") + '</b> <span class="sub">' + esc(r.invoice_no||"") + '</span></td>'
          + '<td class="r">' + fmt(Number(r.amount)||0) + '</td>'
          + '<td class="sub">' + esc(INV_STATE[r.review_state]||r.review_state)
          + (r.reviewed_by ? ' &middot; ' + esc(r.reviewed_by) : '') + '</td>'
          + '<td>' + invDocBtn(r)
          + ' <button class="pfill" onclick="invReview(' + invArg(r.id) + ",'reopen'," + r.version + ')">Reopen</button></td></tr>';
      });
      h += '</tbody></table>';
    }
    h += '</div>';
  }

  h += '<div class="panel"><div class="h">Finish the batch</div>'
    + '<div class="sub"><b>Nothing here needs saving.</b> Every Save, Approve, Investigate and '
    + 'dismissal is written the moment you click it &mdash; close the tab and come back and it is '
    + 'exactly as you left it. This button does not save; it produces the <b>summary the front '
    + 'office receives</b>: what was approved, what is held and why, and what is still open.</div>';
  if(_inv.pm || (who.scope === "pm")){
    h += '<div style="margin-top:8px"><button class="pfill" onclick="invCloseBatch()">'
      + 'Summary for ' + esc(_inv.pm || who.pm) + '</button></div>';
  } else {
    h += '<div class="sub" style="margin-top:8px">Pick a desk above to produce that desk&rsquo;s summary '
      + '&mdash; a batch is finished per PM, not for everyone at once.</div>';
  }
  h += '<div id="invSummary"></div></div>';
  v.innerHTML = h;
}
function invToggleDone(){ _inv.showDone = !_inv.showDone; invPaint(); }

function invJobPanel(g){
  var name = invJobName(g.job);
  var title = g.job
    ? esc(g.job) + (name ? ' &middot; ' + esc(name) : '')
    : 'No job yet';
  var h = '<div class="panel"><div class="h">' + title
    + ' <span class="sub" style="font-weight:400">&middot; ' + g.rows.length + ' &middot; ' + fmt(g.total) + '</span></div>';
  if(!g.job){
    h += '<div class="sub">Nothing on these documents said which job. Type a job number and it is '
      + 'remembered &mdash; the next invoice from that vendor printing the same text classifies itself.</div>';
  }
  h += '<table class="tbl"><tbody>';
  g.rows.forEach(function(r){ h += invRowHtml(r); });
  return h + '</tbody></table></div>';
}

/* ONE ROW = ONE LINE OF WORK. Coding and decision are both here; nothing to expand. */
function invRowHtml(r){
  var hard = invHardFlags(r);
  var pills = invOpenFlags(r).map(function(f){
    var m = INV_FLAG[f.code] || { t:f.code, c:"m-m" };
    return '<span class="pill ' + m.c + '" title="' + esc(f.detail||"") + '">' + esc(m.t) + '</span>';
  }).join(" ");

  var h = '<tr><td style="vertical-align:top;min-width:190px">'
    + '<b>' + esc(r.vendor_name||"&mdash;") + '</b>'
    + '<div class="sub">' + esc(r.invoice_no||"") + ' &middot; '
    + (r.invoice_date ? fmtDate(r.invoice_date) : "&mdash;")
    + (r.doc_type && r.doc_type !== "invoice" ? ' &middot; ' + esc(r.doc_type) : '') + '</div>'
    + (pills ? '<div style="margin-top:3px">' + pills + '</div>' : '')
    + '</td>'
    + '<td class="r" style="vertical-align:top;white-space:nowrap"><b>' + fmt(Number(r.amount)||0) + '</b></td>'
    + '<td style="vertical-align:top">';

  // ---- inline coding ----
  h += '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">';
  if(!r.job_no){
    h += '<input id="job-' + esc(r.id) + '" placeholder="Job no" value="" style="width:110px" '
      + 'title="' + esc(r.job_text||"nothing printed") + '">';
  }
  h += '<span id="cccell-' + esc(r.id) + '">' + invCodeSelect(r) + '</span>'
    + '<select id="ms-' + esc(r.id) + '" style="width:92px" '
    + 'onchange="invRepaintCode(' + invArg(r.id) + ')"><option value="">Mat/Sub</option>'
    + '<option value="mat"' + (r.mat_or_sub === "mat" ? " selected" : "") + '>Material</option>'
    + '<option value="sub"' + (r.mat_or_sub === "sub" ? " selected" : "") + '>Sub</option></select>'
    + '<button class="pfill" onclick="invSave(' + invArg(r.id) + "," + r.version + ')">Save</button>'
    + '</div>'
    + '<div id="rem-' + esc(r.id) + '" class="sub" style="margin-top:3px">' + invRemainingHtml(r) + '</div>';

  // ---- clearing a blocker, inline and one click ----
  if(hard.length){
    h += '<div style="margin-top:5px">';
    hard.forEach(function(f){
      var m = INV_FLAG[f.code] || { t:f.code };
      // duplicate_exact keeps its required reason. It is the $55,927.77 case and the entire
      // reason this module exists; an unexplained dismissal there is the paper process again.
      // Everything else clears in one click, with the who/when still recorded.
      if(f.code === "duplicate_exact"){
        h += '<input id="fx-' + esc(f.code) + "-" + esc(r.id) + '" placeholder="Why is this OK? (required)" style="width:250px"> ';
      }
      h += '<button class="pfill" onclick="invResolve(' + invArg(r.id) + "," + invArg(f.code) + "," + r.version
        + ')">Clear &ldquo;' + esc(m.t) + '&rdquo;</button> ';
    });
    h += '</div>';
  }
  h += '</td>';

  // ---- inline decision ----
  h += '<td style="vertical-align:top;white-space:nowrap">'
    + (hard.length
        ? '<span class="sub m-r" title="Clear the finding first">Approve blocked</span> '
        : '<button class="pfill" onclick="invReview(' + invArg(r.id) + ",'approved'," + r.version + ')">Approve</button> ')
    + '<button class="pfill" onclick="invReview(' + invArg(r.id) + ",'needs_info'," + r.version + ')" '
    + 'title="Park it and come back — nothing is approved and the batch summary reports it as open">Investigate</button> '
    + '<button class="pfill" onclick="invReview(' + invArg(r.id) + ",'duplicate'," + r.version + ')">Dup</button> '
    + '<button class="pfill" onclick="invReview(' + invArg(r.id) + ",'not_ap'," + r.version + ')">Not payable</button> '
    + invDocBtn(r)
    + '<div id="inv-err-' + esc(r.id) + '" class="sub"></div>'
    + '</td></tr>';
  return h;
}

/* THE SCAN. Opens the actual page image in a new tab — the browser's own viewer — not a link
   to wherever the file happens to live. The bytes sit in a PRIVATE bucket; this asks the server
   for a 15-minute signed URL, so a scan is never on a guessable public path and a stale tab
   stops working on its own.

   The window is opened FIRST and navigated after the URL arrives: opening it inside the fetch
   callback is an async popup and browsers block it. A multi-page document opens page 1 and
   offers the rest inline rather than spraying tabs. */
function invDocBtn(r){
  return '<button class="pfill" onclick="invViewDoc(' + invArg(r.id) + ')">View</button>'
    + '<span id="pg-' + esc(r.id) + '"></span>';
}
function invViewDoc(id){
  var w = window.open("", "_blank");           // opened synchronously — not blocked
  invPost("pages", { id:id }).then(function(r){
    var el = document.getElementById("pg-" + id);
    if(!r.ok || !r.data || r.data.error){
      if(w) w.close();
      if(el) el.innerHTML = ' <span class="sub m-r">' + esc((r.data&&r.data.error)||r.error||"unavailable") + '</span>';
      return;
    }
    if(!r.data.stored){
      // No stored scan — fall back to whatever link the batch does carry, honestly labelled.
      if(r.data.uri){ if(w) w.location = r.data.uri; }
      else { if(w) w.close(); if(el) el.innerHTML = ' <span class="sub">no scan stored</span>'; }
      return;
    }
    var pages = r.data.pages || [];
    if(!pages.length){ if(w) w.close(); if(el) el.innerHTML = ' <span class="sub">no pages</span>'; return; }
    if(w) w.location = pages[0].url;
    if(el && pages.length > 1){
      el.innerHTML = ' ' + pages.slice(1).map(function(p){
        return '<a class="pfill" target="_blank" rel="noopener" href="' + esc(p.url) + '">p' + p.page + '</a>';
      }).join(" ");
    }
  });
}
function invSetPm(p){ _inv.pm = p; invLoad(); }

/* RYC's OWN vocabulary, grouped by division — 280 codes the estimators already use. Falls back
   to a free-text box if the list could not be fetched, so a picker outage never blocks coding. */
function invCodeSelect(r){
  /* THE JOB'S OWN BUDGET LINES FIRST. A PM coding against Shipshewana should choose from the
     codes that job actually has budget on — not RYC's full 280-code catalog, most of which is
     irrelevant to any one job. The catalog remains the fallback when the budget is unavailable
     or the job has no lines, so a Procore outage never blocks coding. */
  var b = r.job_no ? _inv.budget[r.job_no] : null;
  var jobCodes = r.job_no ? invJobCodes(r.job_no) : [];
  if(b && b.available && jobCodes.length){
    /* Values are RYC codes, so an invoice coded `01-001` before the ERP lines existed still
       shows as coded. The remaining figure follows Mat/Sub, so the row re-reads when either
       control changes. */
    var ms = invMsFor(r.id, r);
    var h = '<select id="cc-' + esc(r.id) + '" style="width:250px" '
      + 'onchange="invPaintRemaining(' + invArg(r.id) + ')"><option value="">Cost code&hellip;</option>';
    jobCodes.forEach(function(c){
      var l = invBudgetLine(r.job_no, c.code, ms);
      var tail = l ? ' &mdash; ' + esc(fmt(l.remaining)) + ' left'
                   : (invLineSuffix(ms) ? ' &mdash; no ' + (ms==="sub"?"Sub":"Material") + ' line' : '');
      h += '<option value="' + esc(c.code) + '"'
        + (invBaseCode(r.cost_code)===c.code ? " selected" : "") + '>'
        + esc(c.code + (c.name ? " " + c.name : "")) + tail + '</option>';
    });
    return h + '</select>';
  }
  if(!_inv.codes || !_inv.codes.length){
    return '<input id="cc-' + esc(r.id) + '" placeholder="Cost code" value="' + esc(r.cost_code||"") + '" style="width:130px">';
  }
  var byDiv = {}, order = [];
  _inv.codes.forEach(function(c){
    if(!byDiv[c.division]){ byDiv[c.division] = { n:c.division_name, l:[] }; order.push(c.division); }
    byDiv[c.division].l.push(c);
  });
  var h = '<select id="cc-' + esc(r.id) + '" style="width:200px"><option value="">Cost code&hellip;</option>';
  order.forEach(function(d){
    h += '<optgroup label="' + esc(d + " " + (byDiv[d].n||"")) + '">';
    byDiv[d].l.forEach(function(c){
      h += '<option value="' + esc(c.code) + '"' + (r.cost_code === c.code ? " selected" : "") + '>'
        + esc(c.code + " " + (c.description||"")) + '</option>';
    });
    h += '</optgroup>';
  });
  return h + '</select>';
}
/* What this invoice does to the line it is being coded against. Shown BEFORE approval, which
   is the whole point: the PM currently has to leave the screen and open Procore to learn it. */
function invRemainingHtml(r){
  var b = r.job_no ? _inv.budget[r.job_no] : null;
  if(!r.job_no) return "";
  if(b && b.loading) return "checking budget&hellip;";
  if(b && !b.available) return '<span class="m-m">budget unavailable &mdash; ' + esc(b.reason||"") + '</span>';
  var sel = document.getElementById("cc-" + r.id);
  var code = (sel && sel.value) || r.cost_code;
  if(!code) return "";
  var ms = invMsFor(r.id, r);
  var l = invBudgetLine(r.job_no, code, ms);
  if(!l){
    if(!invLineSuffix(ms))
      return '<span class="m-m">pick Material or Sub to see the line</span>';
    return '<span class="m-m">no ' + (ms==="sub"?"Sub":"Material") + ' budget line for '
      + esc(invBaseCode(code)) + ' on this job</span>';
  }
  var amt = Number(r.amount) || 0, after = (l.remaining || 0) - amt;
  var cls = after < 0 ? "m-r" : (after < amt ? "m-a" : "");
  return '<span class="' + cls + '">' + fmt(l.remaining) + ' left &rarr; ' + fmt(after)
    + ' after this</span> <span class="sub">(' + invBasisLabel() + ')</span>'
    + (after < 0 ? ' <b class="m-r">over the line</b>' : '');
}
function invPaintRemaining(id){
  var el = document.getElementById("rem-" + id);
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0];
  if(el && r) el.innerHTML = invRemainingHtml(r);
}
function invErr(id, msg){
  var e = document.getElementById("inv-err-" + id);
  if(e) e.innerHTML = '<span class="m-r">' + esc(msg) + '</span>';
}
function invAfter(id, r){
  _inv.busy = false;
  if(!r.ok || (r.data && r.data.error)){ invErr(id, (r.data && r.data.error) || r.error || "Failed"); return; }
  invLoad();
}
/* The month is DERIVED from the received date rather than typed. It was a field on the rubber
   stamp because paper cannot derive anything; asking a PM to type it 17 times is the folder
   with extra steps. Editable later if a period ever needs overriding. */
function invMonthFor(r){
  var d = r.cost_month || (r.received_date || r.invoice_date || "");
  return d ? String(d).slice(0, 7) : null;
}
function invSave(id, ver){
  if(_inv.busy) return;
  _inv.busy = true;
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0] || {};
  var jobEl = document.getElementById("job-" + id);
  var job = jobEl ? (jobEl.value || "").trim() : "";
  var cc  = (document.getElementById("cc-" + id)||{}).value || "";
  var ms  = (document.getElementById("ms-" + id)||{}).value || "";
  var first = job
    ? invPost("assign", { id:id, job_no:job, source:"manual", version:ver })
    : Promise.resolve({ ok:true, data:{ version:ver } });
  first.then(function(a){
    if(!a.ok || (a.data && a.data.error)){ invAfter(id, a); return; }
    var nv = (a.data && a.data.version) || ver;   // assign bumped it; carry it forward
    return invPost("code", { id:id, month:invMonthFor(r), cost_code:cc||null,
      mat_or_sub:ms||null, version:nv }).then(function(b){ invAfter(id, b); });
  });
}
function invResolve(id, code, ver){
  if(_inv.busy) return;
  var el = document.getElementById("fx-" + code + "-" + id);   // only duplicate_exact has one
  var note = el ? el.value.trim() : "Reviewed on screen and cleared.";
  if(el && note.length < 3){
    invErr(id, "A reason is required to clear a duplicate — that is the one finding worth typing for.");
    return;
  }
  _inv.busy = true;
  invPost("resolve_flag", { id:id, flag_code:code, note:note, version:ver })
    .then(function(r){ invAfter(id, r); });
}
/* Mat/Sub changes which budget line the code resolves to, so the whole cell is re-rendered
   (keeping the current selection) rather than just the remaining figure. */
function invRepaintCode(id){
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0];
  if(!r) return;
  var sel = document.getElementById("cc-" + id);
  var keep = sel ? sel.value : "";
  var cell = document.getElementById("cccell-" + id);
  if(cell){
    cell.innerHTML = invCodeSelect(r);
    var s2 = document.getElementById("cc-" + id);
    if(s2 && keep) s2.value = keep;
  }
  invPaintRemaining(id);
}
/* APPROVE MUST NOT IGNORE WHAT IS ON THE SCREEN. The cost-code and Mat/Sub controls are local
   state until Save is pressed, and Approve reads the server — so a PM who picked a code and hit
   Approve was told "This invoice has no cost code", which is true of the database and plainly
   false of the screen. Flush pending coding first, then review. */
function invReview(id, decision, ver){
  if(_inv.busy) return;
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0] || {};
  var cc = (document.getElementById("cc-" + id)||{}).value || "";
  var ms = (document.getElementById("ms-" + id)||{}).value || "";
  var dirty = (cc && cc !== (r.cost_code || "")) || (ms && ms !== (r.mat_or_sub || ""));
  if(decision === "approved" && dirty){
    _inv.busy = true;
    invPost("code", { id:id, month:invMonthFor(r), cost_code:cc||null,
                      mat_or_sub:ms||null, version:ver }).then(function(c){
      if(!c.ok || (c.data && c.data.error)){ invAfter(id, c); return; }
      var nv = (c.data && c.data.version) || ver;
      return invPost("review", { id:id, decision:decision, version:nv })
        .then(function(x){ invAfter(id, x); });
    });
    return;
  }
  _inv.busy = true;
  invPost("review", { id:id, decision:decision, version:ver }).then(function(r2){ invAfter(id, r2); });
}
function invCloseBatch(){
  var el = document.getElementById("invSummary");
  if(!el) return;
  el.innerHTML = '<div class="sub">Building summary&hellip;</div>';
  invPost("close_batch", {}).then(function(r){
    if(!r.ok || !r.data || r.data.error){
      el.innerHTML = '<div class="sub m-r">' + esc((r.data && r.data.error) || r.error) + '</div>';
      return;
    }
    var s = r.data.summary || {};
    var held = (Number(s.needs_info)||0) + (Number(s.duplicate)||0) + (Number(s.not_ap)||0);
    el.innerHTML = '<table class="tbl" style="margin-top:8px"><tbody>'
      + '<tr><td>Approved</td><td class="r">' + (s.approved||0) + '</td><td class="r">' + fmt(Number(s.approved_value)||0) + '</td></tr>'
      + '<tr><td>Held / duplicate / not payable</td><td class="r">' + held + '</td><td class="r">' + fmt(Number(s.held_value)||0) + '</td></tr>'
      + '<tr><td>Rejected</td><td class="r">' + (s.rejected||0) + '</td><td class="r">&mdash;</td></tr>'
      + '<tr><td><b>Still open</b></td><td class="r"><b>' + (s.outstanding||0) + '</b></td><td class="r">&mdash;</td></tr>'
      + '</tbody></table>'
      + '<div class="sub" style="margin-top:6px">'
      + (Number(s.outstanding) > 0
          ? '<b class="m-a">' + s.outstanding + ' still unreviewed</b> — the summary says so rather than implying the batch is finished.'
          : "Every document in this batch has a decision.")
      + '</div>';
  });
}

/* ===================== INTAKE — front office drops the day's scan ===================
   Everything below exists so nobody has to run a script. Drop the scanned PDF (or the page
   images), and the page does the whole chain: open a batch, chunk it under the endpoint's
   16-page / 4MB bound, read each chunk, STORE the pages so View works, and register what
   came back. Page numbers come back already in batch coordinates — the server does that. */
function invIntakePanel(){
  return '<div class="panel"><div class="h">New batch</div>'
    + '<div class="sub">Drop today\'s scan. Pages are read, stored and registered in one go; '
    + 'anything the reader is unsure of arrives flagged rather than silently guessed.</div>'
    + '<div style="margin-top:8px">'
    + '<input type="file" id="invFile" accept="application/pdf,image/*" multiple> '
    + '<input id="invRecd" type="date" value="' + esc(new Date().toISOString().slice(0,10)) + '"> '
    + '<button class="pfill" id="invGoBtn" onclick="invIntakeRun()">Read &amp; register</button>'
    + '</div><div id="invIntakeLog" class="sub" style="margin-top:8px"></div></div>';
}
function invLog(msg){
  var el=document.getElementById("invIntakeLog");
  if(el) el.innerHTML += (el.innerHTML?"<br>":"") + msg;
}
/* PDF -> page images, in the browser, via the pdf.js build Chrome already ships? No — there is
   none. So a PDF is rejected with a clear instruction rather than half-working: images are what
   the endpoint reads, and pretending otherwise would fail at the worst moment. */
function invIntakeRun(){
  var f=document.getElementById("invFile"), btn=document.getElementById("invGoBtn");
  var files=f&&f.files?Array.prototype.slice.call(f.files):[];
  if(!files.length){ invLog('<span class="m-r">Choose the scanned pages first.</span>'); return; }
  var pdf=files.filter(function(x){ return /pdf$/i.test(x.type)||/\.pdf$/i.test(x.name); });
  if(pdf.length){
    invLog('<span class="m-r">PDF received — export it to page images (JPG/PNG) and drop those. '
      + 'The reader works on page images; converting in the browser would be a second thing to trust.</span>');
    return;
  }
  files.sort(function(a,b){ return a.name.localeCompare(b.name, undefined, {numeric:true}); });
  btn.disabled=true;
  invLog(files.length+" page(s) — starting");

  var recd=(document.getElementById("invRecd")||{}).value||null;
  var CHUNK=12;                      // under the 16-page bound with headroom for size
  var readAll=[];

  invPost("open_batch",{received_date:recd,source:"scan",page_count:files.length,
      label:"Scan "+(recd||"")}).then(function(b){
    if(!b.ok||!b.data||!b.data.batch){ invLog('<span class="m-r">Could not open a batch.</span>'); btn.disabled=false; return; }
    var batchId=b.data.batch.id;
    invLog("batch opened");

    function toB64(file){
      return new Promise(function(res,rej){
        var fr=new FileReader();
        fr.onload=function(){ var s=String(fr.result); res(s.slice(s.indexOf(",")+1)); };
        fr.onerror=rej; fr.readAsDataURL(file);
      });
    }
    function chunk(i){
      if(i>=files.length){
        invLog("registering "+readAll.length+" document(s)…");
        return invPost("register",{batch_id:batchId,documents:readAll}).then(function(r){
          if(!r.ok||!r.data||r.data.error){ invLog('<span class="m-r">'+esc((r.data&&r.data.error)||r.error)+'</span>'); btn.disabled=false; return; }
          invLog("<b>registered "+r.data.registered+" · "+r.data.flagged+" flagged</b>");
          btn.disabled=false; invLoad();
        });
      }
      var slice=files.slice(i,i+CHUNK);
      invLog("reading pages "+(i+1)+"-"+(i+slice.length)+"…");
      return Promise.all(slice.map(toB64)).then(function(b64s){
        var images=b64s.map(function(d,j){ return {media_type:slice[j].type||"image/jpeg",data:d}; });
        return invPost("read",{images:images,batch_id:batchId,page_offset:i});
      }).then(function(r){
        if(!r.ok||!r.data||r.data.error){ invLog('<span class="m-r">'+esc((r.data&&r.data.error)||r.error)+'</span>'); btn.disabled=false; return; }
        var docs=r.data.documents||[];
        docs.forEach(function(d){ d.received_date=recd; readAll.push(d); });
        invLog("  → "+docs.length+" document(s), "+(r.data.stored_pages||0)+" page(s) stored");
        return chunk(i+CHUNK);
      });
    }
    return chunk(0);
  });
}
