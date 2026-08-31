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
var _inv = { who:null, rows:[], codes:null, pm:null, busy:false, showDone:false, jobs:[],
             budget:{}, budgetBasis:null, budgetAsOf:null,
             /* batch id -> the submission the server returned, and batch id -> true while one is in
                flight. Held on `_inv` rather than in the markup for the same reason the success
                messages are: every path here ends in a repaint that rebuilds the row with
                `innerHTML =`, and anything living only in the DOM is destroyed by it. */
             submitted:{}, submitting:{}, submitError:{},
             /* printed job_text -> the community it names, or null for "asked, no community".
                Both answers are cached; see invLoadFamilies. */
             families:{},
             /* row id -> {msg, at}. THE SUCCESS CHANNEL THE ROW DID NOT HAVE. Held on `_inv`
                rather than in the markup because a save ends in `invLoad()`, which repaints from
                the server and would wipe anything written straight into the DOM — which is
                precisely why a working Save looked like a dead button. */
             said:{} };

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

/* The two reference tables both screens need: the job list (Inbound's picker AND the PM board's
   headers) and RYC's cost codes. Loaded once per session and shared — Inbound used to render its
   job picker EMPTY when it was opened first, because the list was only ever fetched by the PM
   board's own render path. `repaint` is passed in because the two screens paint differently. */
function invEnsureRefs(repaint){
  if(!_inv.codes && !_inv._codesLoading){
    _inv._codesLoading = true;
    invPost("cost_codes", {}).then(function(c){
      _inv._codesLoading = false;
      if(c.ok){ _inv.codes = c.data.codes || []; if(repaint) repaint(); }
    });
  }
  if(!_inv.jobs.length && !_inv._jobsLoading){
    _inv._jobsLoading = true;
    return invPost("jobs", {}).then(function(j){
      _inv._jobsLoading = false;
      if(j.ok && j.data && j.data.names){
        _jobNames = j.data.names;
        _inv.jobs = (j.data.jobs || []);      // active jobs + the PM each one implies
      }
      if(repaint) repaint();
    });
  }
  return Promise.resolve();
}

function renderInvoices(){
  var v = document.getElementById("view");
  v.innerHTML = '<div class="panel"><div class="sub">Loading&hellip;</div></div>';
  // whoami is resolved once at boot (app.js routes on it); don't pay for it twice.
  var whoami = _inv.who ? Promise.resolve({ ok:true, data:_inv.who }) : invPost("whoami", {});
  whoami.then(function(r){
    if(!r.ok){
      v.innerHTML = '<div class="panel"><div class="h">Invoices</div>'
        + '<div class="warn-banner">' + esc(r.error||"Unavailable") + '</div></div>';
      return;
    }
    _inv.who = r.data; _inv.pm = _inv.pm || r.data.pm || null;
    invEnsureRefs(invPaint);
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
    invLoadFamilies();
  });
}

/* ===== THE UNITS BEHIND A COMMUNITY ===================================================
   One round trip for the whole desk, keyed by the PRINTED TEXT rather than by row — two
   flooring invoices in a batch both read "Southfield Village - " and deserve one answer.
   Runs AFTER the first paint for the same reason budgets do: the queue must render without
   waiting on the Procore feed, and a desk that renders late reads as a desk that is broken.
   Every failure is a no-op — the row keeps the plain job box it has today. */
function invLoadFamilies(){
  var want = {}, list = [], items = [];
  _inv.rows.forEach(function(r){
    /* ⚠ A ROW WITH NO PRINTED TEXT AT ALL STILL NEEDS THE PICKER. A shared cost frequently prints
       nothing a matcher can use — the whole reason it is shared — so keying only on non-empty text
       left the dumpster and the stock buy with a bare job box and no way to split. The DESK is the
       evidence in that case, so the desk travels with the request. */
    var t = r.job_text || "";
    if(r.job_no || want[t] || _inv.families[t] !== undefined) return;
    want[t] = 1; list.push(t);
    items.push({ text:t, pm: r.assigned_pm || _inv.pm || null });
  });
  if(!list.length || _inv._famLoading) return;
  _inv._famLoading = true;
  invPost("job_candidates", { items:items }).then(function(f){
    _inv._famLoading = false;
    if(!f.ok || !f.data) return;
    var got = f.data.families || {};
    /* Record the MISSES too (as null). Without that, every repaint re-asks for the texts that
       have no community — which on a mixed desk is most of them — and the poll turns into a
       request loop nobody ordered. */
    list.forEach(function(t){ _inv.families[t] = got[t] || null; });
    invPaint();
  }, function(){ _inv._famLoading = false; });
}

var INV_UNASSIGNED = "__unassigned__";

/* ---- grouping: BY JOB, because that is how the day is actually thought about ---- */
function invGroups(rows){
  var by = {}, order = [];
  rows.forEach(function(r){
    /* THE UNASSIGNED GROUP KEY. It was three literal NUL BYTES in the source until 2026-08-21
       — `grep` reported this whole file as binary — and it only worked because all three
       sites happened to carry the identical byte. One reformat, one copy-paste or one generator
       pass and the comparisons below would stop matching, silently, and the unassigned group
       would sort into the middle of the board. Third instance of that corruption class in this
       module in three days. A plain sentinel cannot collide with a job number — they look like
       "2515CO01" or "RYC-EXPENSE" — and it survives every editor. */
    var k = r.job_no || INV_UNASSIGNED;
    if(!by[k]){ by[k] = { job:r.job_no, rows:[], total:0, open:0, hard:0 }; order.push(k); }
    by[k].rows.push(r);
    by[k].total += Number(r.amount) || 0;
    if(!invDone(r)) by[k].open++;
    if(invHardFlags(r).length) by[k].hard++;
  });
  // unassigned last — it is a worklist, not a job
  order.sort(function(a,b){
    if(a === INV_UNASSIGNED) return 1;
    if(b === INV_UNASSIGNED) return -1;
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

/* ---- grouping: BY BATCH, because that is what he is handed and what he hands back ----
   Keith, 2026-08-27: *"the invoices dont present at batches in logans desk view - they should -
   when all invoices have been approved logan should need to press a master submit button for the
   batch he is on."*

   Jobs remain the grouping INSIDE a batch — "what hit Shipshewana today" is still how the work is
   read — but the batch is the unit of the handoff, so it has to be the unit on screen. A PM who
   cannot see where one folder ends cannot be asked to submit one.

   `batch_label` already travels on every queue row (`ryc_invoice_queue`), so this costs no request
   and no schema. It was simply never used. */
var INV_NOBATCH = "__nobatch__";
function invBatches(rows){
  var by = {}, order = [];
  rows.forEach(function(r){
    var k = r.batch_id || INV_NOBATCH;
    if(!by[k]){
      by[k] = { id: r.batch_id || null, label: r.batch_label || null, rows: [], total: 0 };
      order.push(k);
    }
    by[k].rows.push(r);
    by[k].total += Number(r.amount) || 0;
  });
  /* Oldest folder first. He works the one that has been waiting, and the order does not reshuffle
     under him as rows leave — which sorting by "how much is left" would do on every approval. */
  order.sort(function(a, b){
    var ra = by[a].rows[0], rb = by[b].rows[0];
    return String((ra && ra.received_date) || "").localeCompare(String((rb && rb.received_date) || ""));
  });
  return order.map(function(k){ return by[k]; });
}

/* ONE BATCH: everything in it, then the button that hands it over.
   `openRows` are still to decide, `doneRows` already carry one. The submit gate is simply that
   `openRows` is empty — the same question the server asks again on arrival, because a disabled
   button is a courtesy and never the enforcement. */
function invBatchPanel(b, openRows, doneRows){
  /* THE SERVER IS THE AUTHORITY, the session cache is only for the moment between the answer and
     the reload. A submission the queue reports outlives the tab; one held only in `_inv` does not. */
  var fromRow = null;
  b.rows.forEach(function(r){ if(!fromRow && r.batch_submitted_at) fromRow = r; });
  var sub = _inv.submitted[b.id]
    || (fromRow ? { submitted_at: fromRow.batch_submitted_at, summary: null } : null);
  var busy = !!(_inv.submitting && _inv.submitting[b.id]);
  var err = (_inv.submitError || {})[b.id] || null;
  var label = b.label || (b.id ? "Batch " + String(b.id).slice(0, 8) : "Not from a batch");
  var n = openRows.length + doneRows.length;

  var h = '<div class="panel" style="border-left:3px solid var(--line,#d8dce3);padding-left:14px">'
    + '<div class="h">' + esc(label)
    + ' <span class="sub" style="font-weight:400">&middot; ' + n + ' invoice' + (n === 1 ? '' : 's')
    + ' &middot; ' + fmt(b.total) + '</span></div>';

  /* ⛔ SAY THAT NOTHING NEEDS SAVING, AND SAY IT WHERE THE WORK IS. Keith, 2026-08-27: *"It also
     should be obvious to each that they can save their progress or obvious that its being auto
     saved - ie they dont have to finish a batch in a single session."* It WAS true and it WAS
     written down — at the very bottom of the page, under a heading called "Finish the batch",
     which is the last place someone wondering whether they can stop halfway will look. It belongs
     on the batch, beside the button that is the only thing that actually ends it. */
  h += '<div class="sub" style="margin-bottom:8px">'
    + '<b>Your work is saved as you go.</b> Every approval, cost code and unit is written the moment '
    + 'you click it &mdash; you can close this and come back tomorrow and the batch will be exactly '
    + 'as you left it. Nothing reaches the front office until you press <b>Submit batch</b>.'
    + '</div>';

  if(sub){
    /* Already handed over. The panel stays — a PM looking for what he did yesterday should find it
       where he left it, not discover it has vanished. */
    h += '<div class="sub m-g" style="margin-bottom:8px">&#10003; Submitted '
      + esc(invWhen(sub.submitted_at)) + ' &mdash; with the front office now.'
      + (sub.summary
          ? ' ' + sub.summary.approved + ' approved, ' + sub.summary.held + ' held.'
          : '')
      + '</div>';
  }

  invGroups(openRows).forEach(function(g){ h += invJobPanel(g); });

  if(doneRows.length){
    h += '<div class="sub" style="margin:6px 0 2px"><b>' + doneRows.length + ' decided</b> in this '
      + 'batch &mdash; ' + doneRows.filter(function(r){ return r.review_state === "approved"; }).length
      + ' approved.</div>';
  }

  /* ---- the master button ---- */
  h += '<div id="invsub-' + esc(b.id || INV_NOBATCH) + '" style="margin-top:10px">';
  if(!b.id){
    h += '<div class="sub">These are not part of a scanned folder, so there is nothing to submit '
      + '&mdash; approving them is the whole of the work.</div>';
  } else if(busy){
    /* THE PROGRESS THE SCREEN OWED HIM. Keith, 2026-08-27: *"the user would expect something
       onscreen letting them know the process is running."* */
    h += '<button class="pfill" disabled>Submitting&hellip;</button>'
      + '<div class="sub" style="margin-top:4px">Stamping ' + (openRows.length + doneRows.length)
      + ' document(s) and handing the batch to the front office&hellip;</div>';
  } else if(sub){
    h += '<button class="pfill" disabled>&#10003; Submitted</button>';
  } else if(openRows.length){
    h += '<button class="pfill" disabled title="Every invoice needs a decision first">Submit batch</button>'
      + '<div class="sub" style="margin-top:4px"><b class="m-a">' + openRows.length + ' of ' + n
      + ' still need a decision.</b> The batch goes over as one piece, so the front office never '
      + 'receives half a folder.</div>';
  } else {
    h += '<button class="pfill on" onclick="invSubmitBatch(' + invArg(b.id) + ')">Submit batch</button>'
      + '<div class="sub" style="margin-top:4px">Every invoice has a decision. Submitting stamps '
      + 'each approved page with your coding and hands the folder to the front office to reconcile.</div>';
  }
  if(err) h += '<div class="sub m-r" style="margin-top:6px">' + esc(err) + '</div>';
  h += '</div></div>';
  return h;
}

/* Timestamps render in the viewer's own clock. An absolute instant against the wrong calendar is a
   defect this stack has already shipped once. */
function invWhen(ts){
  if(!ts) return "";
  try { return new Date(ts).toLocaleString(); } catch(e){ return String(ts).slice(0, 16); }
}

function invPaint(){
  var v = document.getElementById("view"), who = _inv.who || {};
  var _t = document.getElementById("view-title");
  if(_t) _t.textContent = (who.scope === "pm" ? "Your desk" : "PM Desks");
  /* Each screen owns its own context line. Inbound sets one when it paints, and before this the
     PM board set none — so switching Inbound → PM Desks left "Everything that has arrived and not
     yet been sent to a desk" sitting above a board of released invoices. */
  var _c = document.getElementById("view-ctx");
  if(_c) _c.innerHTML = (who.scope === "pm")
    ? "Invoices released to your desk &middot; every decision is written the moment you click it"
    : "Every desk, and what each one still owes a decision on";
  var rows = _inv.rows;
  var open = rows.filter(function(r){ return !invDone(r); });
  var done = rows.filter(invDone);
  var hard = open.filter(function(r){ return invHardFlags(r).length; });
  var val  = open.reduce(function(a,r){ return a + (Number(r.amount)||0); }, 0);

  /* SAY WHOSE DESK THIS IS. The header used to print a bare name, which reads as a title
     rather than a selection — with several desks to switch between, "Logan Moore" alone does not
     tell you that you are LOOKING at Logan's desk rather than at everyone's. */
  var _viewing = (who.scope === "pm") ? esc(who.pm)
    : (_inv.pm ? esc(_inv.pm) + '&rsquo;s desk' : 'All desks');
  var h = '<div class="panel"><div class="h">'
    + _viewing
    + ' &middot; ' + open.length + ' to review &middot; ' + fmt(val) + '</div>'
    + '<div class="sub">'
    /* SAY WHAT THE TWO BUTTONS DO. Keith asked outright — *"Difference between save and approve?"* —
       which is the evidence the screen never answered it. Approve flushes whatever is on the row
       first (`invFlushPending`), so going straight to Approve is not a shortcut that loses work;
       Save exists for stopping half-way. */
    + 'Approve records that RYC owes it and clears the row &mdash; it saves your coding first, so '
    + 'you can go straight to it. Save just keeps your work and leaves the row here. &middot; '
    + (hard.length ? '<b class="m-r">' + hard.length + ' need a look before they can be approved</b> &middot; ' : '')
    + done.length + ' done'
    + (who.scope === "pm"
        ? ' &middot; signed in by ' + (who.via === "link" ? "an emailed link" : "your access code")
          + '; approvals are recorded as attributed but <b>unverified</b> until per-user sign-in'
        : ' &middot; front-office scope')
    + '</div>';
  if(who.scope === "all"){
    /* Desks come from the DATA as well as the credential map. Procore is the authority on who
       owns a job — Chris Crothers appeared there without ever being in RYC_INVOICE_PMS — so a
       chip list built only from the credential map silently hides a desk that has real invoices
       on it. Union, sorted, de-duplicated. A PM still needs a code to sign in; that is a separate
       thing from whether their desk is visible to the front office. */
    var _desks = (who.pms || []).slice();
    rows.forEach(function(r){ if(r.assigned_pm && _desks.indexOf(r.assigned_pm) < 0) _desks.push(r.assigned_pm); });
    _desks.sort();
    // The selected chip carries `.on` — without it every desk looked identical and nothing on
    // screen said which one you were in.
    h += '<div style="margin-top:8px"><span class="sub" style="margin-right:6px">Desk:</span>'
      + _desks.map(function(p){
          return '<button class="pfill' + (_inv.pm === p ? ' on' : '') + '" onclick="invSetPm('
            + invArg(p) + ')">' + esc(p) + '</button>';
        }).join(" ")
      + ' <button class="pfill' + (_inv.pm ? '' : ' on') + '" onclick="invSetPm(null)">All desks</button></div>';
  }
  h += '</div>';

  // The drop zone lives on Inbound now (that is where things arrive); a PM's board is for
  // reviewing what was sent to them, not for taking delivery.

  // Above the desks on purpose: what has not been routed is the front office's actual job, and
  // it is the one thing that stops moving if nobody looks at it.
  if(who.scope === "all") h += invRoutingPanel();

  /* ALL DESKS IS A ROSTER, NOT A PILE (Keith, 2026-08-13). Viewing everyone at once used to
     render one flat run of job panels, so "2415GO03 · INDOT Roselawn" sat above "2515CO02 ·
     NPTech" with nothing on screen saying they belong to different people — the front office
     could see the work but not whose it was.
     Every desk gets its own section, in the same order as the chips above, INCLUDING the ones with
     nothing in them: a PM with no outstanding approvals is a fact worth stating, and an absent
     section reads as "not loaded yet" rather than "nothing to do". */
  if(who.scope === "all" && !_inv.pm){
    var _all = (who.pms || []).slice();
    open.concat(done).forEach(function(r){
      if(r.assigned_pm && _all.indexOf(r.assigned_pm) < 0) _all.push(r.assigned_pm);
    });
    _all.sort();
    if(!_all.length){
      h += '<div class="panel"><div class="sub">No desks are configured yet.</div></div>';
    }
    _all.forEach(function(p){
      var mine = open.filter(function(r){ return r.assigned_pm === p; });
      var mdone = done.filter(function(r){ return r.assigned_pm === p; });
      h += invDeskHeading(p, mine, mdone.length
        ? mdone.length + ' already done this period' : null);
      h += invBatchSections(mine, mdone);
    });
    // Anything released with no PM on it would otherwise be invisible on this screen.
    var orphans = open.filter(function(r){ return !r.assigned_pm; });
    if(orphans.length){
      h += invDeskHeading("No desk", orphans, null,
        'Released without a PM on it. Assign a desk in Inbound before releasing, or reassign here.');
      invGroups(orphans).forEach(function(g){ h += invJobPanel(g); });
    }
  } else if(!rows.length){
    v.innerHTML = h + '<div class="panel"><div class="sub">Nothing in the register for this period.</div></div>';
    return;
  } else {
    h += invBatchSections(open, done);
  }

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

  /* ⛔ "FINISH THE BATCH" AND ITS SUMMARY BUTTON ARE GONE (Keith, 2026-08-27: *"We should remove
     language at the bottom the screen and the summary button. Both are replaced by 'Submit
     batch'."*). The button was labelled *"the summary the front office receives"* and the front
     office received nothing — `close_batch` built a table on the PM's own screen and sent it
     nowhere. A control that describes an effect it does not have is the defect this module keeps
     paying for, and here it was inviting a PM to believe he had handed over a folder still sitting
     on his desk. The summary survives as `submit_batch`'s return value, shown against the batch it
     actually describes; the auto-save sentence moved up beside each Submit button, which is where
     someone wondering whether they can stop halfway is actually looking. */
  v.innerHTML = h;
}

/* One desk's work, split into the folders it arrived in. */
function invBatchSections(openRows, doneRows){
  var h = "", byBatchDone = {};
  (doneRows || []).forEach(function(r){
    var k = r.batch_id || INV_NOBATCH;
    (byBatchDone[k] || (byBatchDone[k] = [])).push(r);
  });
  /* A batch whose invoices are ALL decided has no open rows, so grouping the open ones alone would
     make it disappear at the exact moment it becomes submittable. Both sets build the list. */
  var all = (openRows || []).concat(doneRows || []);
  invBatches(all).forEach(function(b){
    var k = b.id || INV_NOBATCH;
    var o = (openRows || []).filter(function(r){ return (r.batch_id || INV_NOBATCH) === k; });
    h += invBatchPanel(b, o, byBatchDone[k] || []);
  });
  return h;
}
function invToggleDone(){ _inv.showDone = !_inv.showDone; invPaint(); }

/* A DESK TITLE MUST OWN WHAT FOLLOWS IT. Rendered as a panel it came out the same size, weight
   and colour as the job panel beneath it, with equal space above and below — so "Chris Crothers"
   read as a sibling of "2515CO02 · NPTech Community Fiber" rather than as the person whose desk
   it is. It is a heading: bigger, tied to the group below by spacing, and not a card. */
function invDeskHeading(name, openRows, doneNote, emptyNote){
  var val = openRows.reduce(function(a,r){ return a + (Number(r.amount)||0); }, 0);
  var h = '<div style="margin:26px 0 8px 2px">'
    + '<div style="font-size:17px;font-weight:700;letter-spacing:-0.01em">' + esc(name)
    + (openRows.length
        ? ' <span class="sub" style="font-weight:400;font-size:13px">&middot; ' + openRows.length
          + ' to review &middot; ' + fmt(val) + '</span>'
        : '')
    + '</div>';
  if(!openRows.length){
    h += '<div class="sub" style="margin-top:2px">'
      + esc(emptyNote || "No outstanding invoice approvals needed")
      + (doneNote ? ' &mdash; ' + esc(doneNote) : '') + '</div>';
  } else if(emptyNote){
    h += '<div class="sub" style="margin-top:2px">' + esc(emptyNote) + '</div>';
  }
  return h + '</div>';
}

function invJobPanel(g){
  var name = invJobName(g.job);
  var title = g.job
    ? esc(g.job) + (name ? ' &middot; ' + esc(name) : '')
    : 'No job yet';
  var h = '<div class="panel"><div class="h">' + title
    + ' <span class="sub" style="font-weight:400">&middot; ' + g.rows.length + ' &middot; ' + fmt(g.total) + '</span></div>';
  if(!g.job){
    /* ⚠ THIS SENTENCE DESCRIBED A CONTROL THAT IS NO LONGER THERE. It said "Type a job number"
       while the affordance underneath had become community chips, a split and a shared-cost
       ending — and a caption that describes something absent is worse than no caption. The hint
       store is still real and still learns, so that half stays; it just is not a text box any more. */
    h += '<div class="sub">Nothing on these documents named a unit. Pick one, split it across '
      + 'several, or send it to the shared job &mdash; and what you choose is remembered, so the '
      + 'next invoice from that vendor printing the same text classifies itself.</div>';
  }
  h += '<table class="tbl"><tbody>';
  g.rows.forEach(function(r){ h += invRowHtml(r); });
  return h + '</tbody></table></div>';
}

/* WHERE THE DOCUMENT WENT. The register's job does not end at "approved" — the invoice still
   has to reach the job folder, which is the step the front office currently does by hand after
   scanning the stamped paper. Filing runs on the VM (it holds the SharePoint credential), so
   this row reports an outcome it did not itself perform.

   It lands in `Invoice Desk` staging, NOT the live job folder (Keith, 2026-08-12), so the line
   also names the folder it belongs in — that is the front office's remaining move, and having
   to re-derive it per invoice would just move the manual work rather than remove it. */
function invFilingHtml(r){
  var st = r.file_state;
  if(st === "filed"){
    return '<span class="m-g">Filed</span> '
      + (r.filed_url ? '<a href="' + esc(r.filed_url) + '" target="_blank" rel="noopener">open</a> ' : '')
      + '<span class="sub">in Invoice Desk'
      + (r.filed_intended_folder ? ' &middot; move to &ldquo;' + esc(r.filed_intended_folder) + '&rdquo;' : '')
      + '</span>';
  }
  if(st === "failed"){
    return '<span class="m-r">Filing failed</span> <span class="sub">'
      + esc(r.file_error || "no reason recorded") + ' &mdash; it will be retried</span>';
  }
  if(st === "skipped"){
    // Not a failure: the worker declined deliberately and said why (usually that it could not
    // identify the job folder with enough confidence to file into it).
    return '<span class="m-a">Not filed</span> <span class="sub">'
      + esc(r.file_error || "no reason recorded") + '</span>';
  }
  if(r.review_state === "approved") return '<span class="m-m">approved &mdash; waiting to be filed</span>';
  return "";
}

/* ===================== THE INBOUND QUEUE — ITS OWN SCREEN =========================
   Keith, 2026-08-13, describing the real motion:
     "the invoice hits the ap inbox, auto moves to the queue where the system stages it, trying to
      find its job and relative PM, at some point in the day the front office will review, manually
      assign the ones where the system was unable, then release the batch, which will [appear] on
      the pm's page for review."

   So this is a DESTINATION, not a panel. The previous version put the unplaced invoices in a
   section inside the PM-facing board, which buried one person's whole job inside another's screen.

   The system stages from what the invoice PRINTS — the job name — and the job tells us the PM.
   Where it could not place one, it says WHY rather than leaving a blank, because "only 1
   distinctive word matched" and "nothing printed" call for completely different actions.

   Nothing here reaches a PM until Release. */
var _inb = { rows: [], summary: {}, busy: false, sel: {} };

function invInboundPost(action, body){ return invPost(action, body || {}); }

function renderInbound(){
  var v = document.getElementById("view");
  var ti = document.getElementById("view-title");
  if(ti) ti.textContent = "Inbound";
  document.getElementById("view-ctx").innerHTML =
    "Everything that has arrived and not yet been sent to a desk";
  v.innerHTML = '<div class="panel"><div class="sub">Loading the inbound queue&hellip;</div></div>';
  // The job picker on every row comes from this list; without it the front office gets a screen
  // full of empty dropdowns and no way to place anything.
  invEnsureRefs(function(){ if(_inb.rows.length) invPaintInbound(); });
  invInboundPost("inbound_queue", { days: 90 }).then(function(r){
    if(!r.ok || !r.data || r.data.error){
      v.innerHTML = '<div class="panel"><div class="sub m-r">'
        + esc((r.data && r.data.error) || r.error || "Could not load the inbound queue.")
        + '</div></div>';
      return;
    }
    _inb.rows = r.data.rows || [];
    _inb.summary = r.data.summary || {};
    _inb.sel = {};
    // Default the batch to everything the system already placed — that is the common action
    // ("release the batch"), and the unplaced ones are deliberately NOT pre-selected.
    _inb.rows.forEach(function(x){ if(x.staged_pm) _inb.sel[x.id] = true; });
    invPaintInbound();
  });
}

function invPaintInbound(){
  var v = document.getElementById("view"), s = _inb.summary;
  var pms = (_inv.who && _inv.who.pms) || [];
  var chosen = _inb.rows.filter(function(x){ return _inb.sel[x.id]; });
  var releasable = chosen.filter(function(x){ return !!x.staged_pm; });

  var h = '<div class="panel"><div class="h">Inbound &middot; ' + (s.documents || 0)
    + ' &middot; ' + fmt(s.value || 0) + '</div>'
    + '<div class="sub">'
    + '<b>' + (s.staged || 0) + '</b> placed by the system &middot; '
    + ((s.no_desk || 0) ? '<b class="m-a">' + s.no_desk + '</b> have a job but no desk &middot; ' : '')
    + '<b class="' + ((s.unplaced || 0) ? 'm-a' : '') + '">' + (s.unplaced || 0) + '</b> need you'
    + ((s.flagged || 0) ? ' &middot; <b class="m-r">' + s.flagged + ' flagged</b>' : '')
    + '</div>'
    + '<div style="margin-top:8px">'
    + '<button class="pfill" onclick="invStageInbound()">Re-read and place</button> '
    + '<button class="pfill" onclick="invReleaseBatch()"'
    + (releasable.length ? '' : ' disabled')
    + '>Release ' + releasable.length + ' to their desks</button>'
    + (chosen.length > releasable.length
        ? ' <span class="sub m-a">' + (chosen.length - releasable.length)
          + ' selected have no desk and will be held back</span>' : '')
    + '</div>'
    + '<div id="inb-msg" class="sub" style="margin-top:6px"></div></div>';

  /* ⛔ THE INTAKE CARD IS GONE FROM THIS SCREEN (Keith, 2026-08-20): *"Its confusing to have batch
     process in two places - it should be removed from the inbound page."*
     It was not merely duplicated, it was the copy that could not do the job — `invIntakeRun()`
     REFUSES a PDF and asks for exported page images, and the office's scanner produces exactly one
     thing: a PDF. So the card on the front office's own screen rejected the only file they have,
     while the screen that accepts it sat one rail item away. `invIntakePanel()` and
     `invIntakeRun()` are kept below and still work for loose page images; nothing on Inbound
     calls them. `open_batch`/`register` are untouched — that is the path ingest_ap_mailbox.py
     uses for email arrivals, and it is the reason this queue exists at all. */

  if(!_inb.rows.length){
    v.innerHTML = h + '<div class="panel"><div class="sub">Nothing waiting. Anything that arrives '
      + 'in ap@ appears here on its own.</div></div>';
    return;
  }

  // Unplaced first: that is the actual work on this screen.
  var order = _inb.rows.slice().sort(function(a,b){
    return (a.staged_pm ? 1 : 0) - (b.staged_pm ? 1 : 0);
  });

  h += '<div class="panel"><table class="tbl"><tbody>';
  order.forEach(function(r){
    /* A JOB, not a desk. The front office knows which job an invoice belongs to; which PM that
       implies is a lookup the Procore feed already does, and a desk picked by hand goes stale the
       moment a job is reassigned. */
    var jobs = _inv.jobs || [];
    var sel = '<select id="ib-' + esc(r.id) + '" style="width:230px" '
      + 'onchange="invStageOne(' + invArg(r.id) + ')">'
      + '<option value="">Choose a job&hellip;</option>'
      + jobs.map(function(j){
          var on = (r.staged_job_no === j.no);
          return '<option value="' + esc(j.no) + '"' + (on ? " selected" : "") + '>'
            + esc(j.no + ' · ' + j.name) + (j.pm ? '' : '  (no PM)') + '</option>';
        }).join("")
      + '</select>'
      // Putting a wrong guess back to "needs a human" has to be possible, or the only way to
      // correct it is to pick a different job you are also unsure about.
      + ((r.staged_pm || r.staged_job_no)
          ? ' <button class="pfill" onclick="invClearStage(' + invArg(r.id) + ')">clear</button>' : '');

    /* THREE STATES, NOT TWO. A job the system identified but whose DESK it does not know is not
       the same as an invoice it could not read at all — the first needs one click, the second
       needs somebody to look at the document. Collapsing them into "not placed" is what made
       2513CO04 Helix Orchard (no PM in Procore) look like an unreadable invoice. */
    var why, note;
    // The state and the reason are two different things and must not run together as one
    // sentence — "not placed no job resembles what the invoice printed" reads as a typo.
    var tail = function(s){ return s ? ' <span class="sub">&middot; ' + s + '</span>' : ''; };
    if(r.staged_pm){
      note = esc(r.staged_note || (r.staged_source === "manual" ? "set by hand" : ""));
      why = '<span class="m-g">' + esc(r.staged_pm) + '</span>' + tail(note);
    } else if(r.staged_job_no){
      note = esc(r.staged_note || (r.staged_job_no + " has no PM in Procore"));
      why = '<span class="m-a">no desk</span>' + tail(note);
    } else {
      note = esc(r.staged_note || "")
        + (r.job_text
            ? (r.staged_note ? ' &mdash; ' : '') + 'the invoice says &ldquo;' + esc(r.job_text) + '&rdquo;'
            : (r.staged_note ? '' : 'no job printed on it'));
      why = '<span class="m-a">not placed</span>' + tail(note);
    }

    h += '<tr>'
      + '<td style="vertical-align:top;width:24px"><input type="checkbox" id="cb-' + esc(r.id) + '"'
      + (_inb.sel[r.id] ? " checked" : "") + ' onchange="invToggleSel(' + invArg(r.id) + ')"></td>'
      // The grey line was an unlabelled invoice number and date — readable only if you already
      // knew what it was. Label it, and give the front office the same View the PM has: they are
      // the ones deciding where this goes, and the job is often only legible on the document.
      + '<td style="vertical-align:top;min-width:200px"><b>' + esc(r.vendor_name || "&mdash;") + '</b>'
      + '<div class="sub">'
      + (r.invoice_no ? 'Invoice ' + esc(r.invoice_no) : '<span class="m-a">no invoice number</span>')
      + ' &middot; received ' + esc(r.received_date || "&mdash;")
      + (r.doc_type && r.doc_type !== "invoice" ? ' &middot; <b>' + esc(r.doc_type) + '</b>' : '')
      + '</div>'
      + '<div style="margin-top:3px"><button class="pfill" onclick="invViewDoc(' + invArg(r.id) + ')">View</button>'
      + '<span id="pg-' + esc(r.id) + '"></span></div></td>'
      + '<td class="r" style="vertical-align:top;white-space:nowrap"><b>'
      + (r.amount == null ? '&mdash;' : fmt(Number(r.amount))) + '</b></td>'
      + '<td style="vertical-align:top">' + sel
      + '<div class="sub" style="margin-top:3px">' + why + '</div></td>'
      + '</tr>';
  });
  v.innerHTML = h + '</tbody></table></div>';
}

function invToggleSel(id){
  _inb.sel[id] = !!(document.getElementById("cb-" + id) || {}).checked;
  invPaintInbound();
}

/* The front office's correction. Staging is NOT releasing — this records the intended desk and
   the invoice stays on this screen until the batch goes. */
function invStageOne(id){
  if(_inb.busy) return;
  var r = _inb.rows.filter(function(x){ return x.id === id; })[0] || {};
  var jobNo = (document.getElementById("ib-" + id) || {}).value || "";
  if(!jobNo) return;
  _inb.busy = true;
  invInboundPost("stage", { id:id, job_no:jobNo, source:"manual", version:r.version })
    .then(function(x){
      _inb.busy = false;
      var m = document.getElementById("inb-msg");
      if(!x.ok || (x.data && x.data.error)){
        if(m) m.innerHTML = '<span class="m-r">' + esc((x.data && x.data.error) || "Could not stage that.") + '</span>';
        return;
      }
      renderInbound();
    });
}

function invClearStage(id){
  if(_inb.busy) return;
  var r = _inb.rows.filter(function(x){ return x.id === id; })[0] || {};
  _inb.busy = true;
  invInboundPost("stage", { id:id, clear:true, source:"manual", version:r.version })
    .then(function(x){
      _inb.busy = false;
      var m = document.getElementById("inb-msg");
      if(!x.ok || (x.data && x.data.error)){
        if(m) m.innerHTML = '<span class="m-r">' + esc((x.data && x.data.error) || "Could not clear that.") + '</span>';
        return;
      }
      renderInbound();
    });
}

function invStageInbound(){
  if(_inb.busy) return;
  _inb.busy = true;
  var m = document.getElementById("inb-msg");
  if(m) m.textContent = "Reading the job name off each invoice\u2026";
  invInboundPost("stage_inbound", {}).then(function(x){
    _inb.busy = false;
    if(!x.ok || (x.data && x.data.error)){
      if(m) m.innerHTML = '<span class="m-r">' + esc((x.data && x.data.error) || "Could not stage.") + '</span>';
      return;
    }
    renderInbound();
  });
}

/* RELEASE THE BATCH — the moment this work becomes a PM's. Anything without a desk is held back
   by the server and reported, never swept along to land nowhere. */
function invReleaseBatch(){
  if(_inb.busy) return;
  var ids = Object.keys(_inb.sel).filter(function(k){ return _inb.sel[k]; });
  var withDesk = _inb.rows.filter(function(x){ return _inb.sel[x.id] && x.staged_pm; });
  if(!withDesk.length) return;
  if(!confirm("Release " + withDesk.length + " invoice(s) to their desks?\n\n"
      + "They appear on each PM's page for review. Anything without a desk stays here.")) return;
  _inb.busy = true;
  var m = document.getElementById("inb-msg");
  if(m) m.textContent = "Releasing\u2026";
  invInboundPost("release", { ids: ids }).then(function(x){
    _inb.busy = false;
    if(!x.ok || (x.data && x.data.error)){
      if(m) m.innerHTML = '<span class="m-r">' + esc((x.data && x.data.error) || "Release failed.") + '</span>';
      return;
    }
    var d = x.data;
    if(m) m.innerHTML = '<span class="m-g">Released ' + d.released + '</span>'
      + (d.held ? ' <span class="m-a">&middot; ' + d.held + ' held back (no desk)</span>' : '');
    setTimeout(renderInbound, 900);
  });
}

/* THE FRONT-OFFICE ROUTING QUEUE (Keith, 2026-08-12).
   "A user from the front office logs in ... their role is to review and route where needed —
   then push to the individual PM queue."

   So an invoice has two homes, and `assigned_pm` is the boundary between them: no PM means it is
   still in the front-office pool; a PM means it is on that desk. Pushing is not a new concept —
   it is `assign`, which already sets the PM, clears the `unrouted` finding and records who did
   it. What is new is that the row arrives with the answer already worked out.

   Nothing here is auto-pushed. The system proposes, a person releases: routing a payable to the
   wrong desk is how an invoice sits unlooked-at for a fortnight, and the classifier's own
   confidence is not worth that. Accepting the proposal is one click; overriding it is two. */
function invRoutingPanel(){
  var who = _inv.who || {};
  if(who.scope !== "all") return "";
  var pending = _inv.rows.filter(function(r){ return !r.assigned_pm && !invDone(r); });
  if(!pending.length) return "";

  var h = '<div class="panel"><div class="h">Needs routing &middot; ' + pending.length
    + ' &middot; ' + fmt(pending.reduce(function(a,r){ return a + (Number(r.amount)||0); }, 0)) + '</div>'
    + '<div class="sub">Arrived and not yet on anyone&rsquo;s desk. The job is resolved from what the '
    + 'vendor printed, and the desk follows from the job &mdash; check it and push.</div>'
    + '<table class="tbl"><tbody>';

  pending.forEach(function(r){
    var pms = who.pms || [];
    var sel = '<select id="rt-' + esc(r.id) + '" style="width:150px">'
      + '<option value="">Choose a desk&hellip;</option>'
      + pms.map(function(p){
          return '<option value="' + esc(p) + '"' + (r.suggested_pm === p ? " selected" : "") + '>' + esc(p) + '</option>';
        }).join("")
      + '</select>';
    h += '<tr><td style="vertical-align:top;min-width:180px"><b>' + esc(r.vendor_name || "&mdash;") + '</b>'
      + '<div class="sub">' + esc(r.invoice_no || "") + '</div></td>'
      + '<td class="r" style="vertical-align:top;white-space:nowrap"><b>' + fmt(Number(r.amount) || 0) + '</b></td>'
      + '<td style="vertical-align:top">'
      + (r.job_no
          ? '<span class="sub">' + esc(r.job_no) + (invJobName(r.job_no) ? ' &middot; ' + esc(invJobName(r.job_no)) : '') + '</span>'
          : '<span class="m-a">no job &mdash; the vendor printed &ldquo;' + esc(r.job_text || "nothing") + '&rdquo;</span>')
      + '<div style="margin-top:4px;display:flex;gap:5px;flex-wrap:wrap;align-items:center">' + sel
      + '<button class="pfill" onclick="invPushToPm(' + invArg(r.id) + ',' + r.version + ')">Push to desk</button>'
      + '</div>'
      + '<div id="inv-err-' + esc(r.id) + '" class="sub" style="margin-top:3px">' + invRowMsg(r.id) + '</div>'
      + '<div class="sub" style="margin-top:3px">'
      + (r.suggested_pm
          ? 'Suggested: <b>' + esc(r.suggested_pm) + '</b> &mdash; the PM on this job in Procore'
          : '<span class="m-a">No suggestion &mdash; ' + esc(r.suggested_via || "could not resolve") + '</span>')
      + '</div></td></tr>';
  });
  return h + '</tbody></table></div>';
}

/* Push = assign. Deliberately the SAME typed, audited operation a PM correction uses, so the
   fact trail does not distinguish "the front office routed it" from "someone fixed it" by having
   two different write paths — only by the actor already recorded on the event. */
function invPushToPm(id, ver){
  if(_inv.busy) return;
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0] || {};
  var pm = (document.getElementById("rt-" + id) || {}).value || "";
  if(!pm){ invErr(id, "Choose a desk before pushing."); return; }
  if(!r.job_no && !confirm("This invoice has no job yet.\n\nPush it to " + pm + " anyway? They will have to set the job themselves.")) return;
  _inv.busy = true;
  invPost("assign", { id: id, job_no: r.job_no || null, assigned_pm: pm, source: "manual", version: ver })
    .then(function(x){ invAfter(id, x); });
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
    var fam = _inv.families[r.job_text || ""];
    /* A SPLIT THAT DOES NOT SHOW ON THE ROW AFTERWARDS GETS DONE TWICE. The queue has always
       returned `lines`; nothing rendered them, so a document coded across five units looked
       exactly like one nobody had touched. */
    if(!r._split && r.lines && r.lines.length) h += invSplitSummary(r);
    else h += (fam && fam.candidates && fam.candidates.length)
      ? invUnitPicker(r, fam)
      : '<input id="job-' + esc(r.id) + '" placeholder="Job no" value="" style="width:110px" '
        + 'title="' + esc(r.job_text||"nothing printed") + '">';
  }
  h += '<span id="cccell-' + esc(r.id) + '">' + invCodeSelect(r) + '</span>'
    + '<select id="ms-' + esc(r.id) + '" style="width:92px" '
    + 'onchange="invRepaintCode(' + invArg(r.id) + ')"><option value="">Mat/Sub</option>'
    + '<option value="mat"' + (r.mat_or_sub === "mat" ? " selected" : "") + '>Material</option>'
    + '<option value="sub"' + (r.mat_or_sub === "sub" ? " selected" : "") + '>Sub</option></select>'
    + '<button class="pfill" onclick="invSave(' + invArg(r.id) + "," + r.version + ')">Save</button>'
    + '</div>'
    + '<div id="rem-' + esc(r.id) + '" class="sub" style="margin-top:3px">' + invRemainingHtml(r) + '</div>'
    + (function(){ var f = invFilingHtml(r);
        return f ? '<div class="sub" style="margin-top:3px">' + f + '</div>' : ''; })();

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
    + '<div id="inv-err-' + esc(r.id) + '" class="sub">' + invRowMsg(r.id) + '</div>'
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
      /* THE DOCUMENT ITSELF WHEN THE SERVER COULD NAME IT, the batch folder only when it could
         not — and it SAYS which. Keith, 2026-08-31, walking Logan through his first batch:
         *"the View button opens the sharepoint folder where the batch lives - it should open the
         actual invoice preview."* A folder opening silently is indistinguishable from a broken
         button; a folder opening with a reason beside it is a fallback. */
      if(r.data.uri){
        if(w) w.location = r.data.uri;
        if(el) el.innerHTML = r.data.is_document ? ""
          : ' <span class="sub m-r">' + esc(r.data.note
              || "opened the batch folder — no direct link to this page") + '</span>';
      }
      else { if(w) w.close(); if(el) el.innerHTML = ' <span class="sub">'
        + esc(r.data.note || "no scan stored") + '</span>'; }
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
/* ⛔ THE ROW COULD RENDER A FAILURE AND HAD NO WAY TO RENDER A SUCCESS, so a save that worked was
   pixel-identical to a dead button. Keith, piloting Logan's desk 2026-08-26: *"pushing save here
   does not do anything - at least it does feel like it does."* It had saved.
   It says WHAT WAS RECORDED, not "Saved" — the point is to show the thing that landed, because the
   one control that did visibly move on that screen (the budget line) moves on the picker's own
   `onchange`, before Save is pressed, which reads as "it already did whatever it does". */
var INV_SAID_MS = 7000;
function invSaid(id, msg){
  _inv.said[id] = { msg: msg, at: Date.now() };
  setTimeout(function(){
    var s = _inv.said[id];
    if(s && (Date.now() - s.at) >= INV_SAID_MS - 50){ delete _inv.said[id]; invPaint(); }
  }, INV_SAID_MS);
}
/* Rendered FROM STATE at paint time, so it survives the repaint that `invLoad()` performs. */
function invRowMsg(id){
  var s = _inv.said[id];
  if(!s || (Date.now() - s.at) > INV_SAID_MS) return "";
  return '<span class="m-g">&check; ' + esc(s.msg) + '</span>';
}
function invAfter(id, r, said){
  _inv.busy = false;
  if(!r.ok || (r.data && r.data.error)){ invErr(id, (r.data && r.data.error) || r.error || "Failed"); return; }
  if(said) invSaid(id, said);
  invLoad();
}
/* The month is DERIVED from the received date rather than typed. It was a field on the rubber
   stamp because paper cannot derive anything; asking a PM to type it 17 times is the folder
   with extra steps. Editable later if a period ever needs overriding. */
function invMonthFor(r){
  var d = r.cost_month || (r.received_date || r.invoice_date || "");
  return d ? String(d).slice(0, 7) : null;
}
/* ===== "WHICH UNIT?" — THE STICKY NOTE, ON SCREEN =====================================
   The front office writes *Which units?* on a teal Post-it and the question travels to the PM on
   paper. On screen it had been a text box asking Logan Moore to recall that `2518RO20` is the
   duplex at 6516 — which he would not do, and the batch would go back to the folder.

   THE NUMBER IS WHAT A PERSON SAYS. Nobody at RYC calls it 2518RO20; they call it 6516. So the
   chip is the house number and the job number lives on the hover. Chips rather than a dropdown
   because a select hides twenty of the twenty-one behind a click, and seeing the street is the
   entire advantage a person has over the reader here.

   ⚠ IT WRITES THROUGH THE SAME HIDDEN `job-<id>` FIELD THE TEXT BOX USED, so `invSave` is
   untouched and a unit still reaches the ledger through `ryc_assign_invoice` — the one typed,
   audited operation. A picker with its own save path would be a second way to assign a job, and
   the first divergence between them would be silent. Nothing is written until Save: the unit and
   the cost code are one decision and they travel together. */
/* ⚠ 2048 AND 6508 ARE THE SAME LENGTH AND DIFFERENT STREETS. When the candidates are a whole
   desk rather than one community — which is what a shared cost gets — twenty-eight bare house
   numbers in a row is worse than the text box it replaced. So chips are grouped under the street
   they stand on, and only when there are enough of them to be confusing. The tag is read off
   RYC's own job names, not invented: `… WPC`, `… Chestnut`, `… Midd …`. */
function invUnitStreet(name){
  var n = String(name || "");
  if(/\bWPC\b/i.test(n))      return "Whispering Pine Ct (Goshen)";
  if(/Chestnut/i.test(n))     return "Southfield Village (South Bend)";
  if(/\bMidd\b/i.test(n))     return "Middlebury";
  return "Other";
}
function invUnitChips(candidates, render){
  if(candidates.length <= 8) return candidates.map(render).join("");
  var order = [], groups = {};
  candidates.forEach(function(c){
    var g = invUnitStreet(c.name);
    if(!groups[g]){ groups[g] = []; order.push(g); }
    groups[g].push(c);
  });
  if(order.length < 2) return candidates.map(render).join("");
  return order.map(function(g){
    return '<span style="width:100%;height:0"></span>'
      + '<span class="sub" style="width:100%;margin:2px 0 1px">' + esc(g) + '</span>'
      + groups[g].map(render).join("");
  }).join("");
}
function invUnitLabel(name){
  var m = String(name||"").match(/\d{2,5}/);
  if(!m) return String(name||"").replace(/^Greencroft\s*/i, "");
  // Middlebury has two lots per number (Pkwy and Crystal Rg) — the number alone is not the answer.
  var tail = String(name).slice(m.index + m[0].length).replace(/\s+/g, " ").trim();
  return /pkwy|crystal|lot/i.test(tail) ? (m[0] + " " + tail) : m[0];
}
function invUnitPicker(r, fam){
  if(r._split) return invSplitPicker(r, fam);
  var h = '<input type="hidden" id="job-' + esc(r.id) + '" value="">'
    + '<div class="sub" style="width:100%;margin-bottom:3px">' + esc(fam.label)
    + ' &mdash; which unit?</div>'
    + '<div id="units-' + esc(r.id) + '" style="display:flex;gap:3px;flex-wrap:wrap;width:100%">';
  h += invUnitChips(fam.candidates, function(c){
    return '<button class="pfill' + (r._unit === c.no ? " on" : "")
      + '" style="padding:2px 8px" title="' + esc(c.no + " · " + c.name) + '" '
      + 'onclick="invPickUnit(' + invArg(r.id) + ',' + invArg(c.no) + ',this)">'
      + esc(invUnitLabel(c.name)) + '</button>';
  });
  h += '<span style="width:100%;height:0"></span>';
  /* THE TWO ENDINGS FOR A COST THAT IS GENUINELY SHARED, and neither is a default.
     Keith, 2026-08-26, asked which one Logan should get: *"Both — Logan chooses per invoice."*
     A $670 dumpster and a $9,443 flooring invoice are not the same decision, and a tool that
     picks for him gets the cheap one right and the expensive one wrong. Offered LAST and set
     apart on their own line: a shared-cost button sitting first in the row is a shared-cost
     button that gets pressed to finish the row. */
  h += '<button class="pfill" style="padding:2px 8px" '
    + 'title="One invoice, one payable, coded across several units — the lines must foot to '
    + fmt(Number(r.amount)||0) + '" '
    + 'onclick="invSplitStart(' + invArg(r.id) + ')">Split across units&hellip;</button>';
  if(fam.misc){
    h += '<button class="pfill' + (r._unit === fam.misc.no ? " on" : "")
      + '" style="padding:2px 8px;margin-left:3px" title="' + esc(fam.misc.no + " · " + fam.misc.name) + '" '
      + 'onclick="invPickUnit(' + invArg(r.id) + ',' + invArg(fam.misc.no) + ',this)">'
      + 'Shared &rarr; ' + esc(fam.misc.name) + '</button>';
  }
  return h + '</div>';
}

/* ===== SPLIT — ONE DOCUMENT, MANY UNITS ==============================================
   ⚠ THE SPLIT IS NOT NEW AND THAT IS THE POINT. `ryc_invoice_lines` has carried a per-line
   `job_no` since the register was built, for the case its own header names — Beer & Slabaugh
   billing three jobs on one page — and `ryc_code_invoice` already refuses lines that do not foot
   to the document (RY40H). It was reachable from nothing. The same vendor bills Greencroft one
   30-yard container against a street of duplexes, so the shape the schema was designed around is
   the shape Logan meets every week, and the only missing piece was a way to say it.

   NOTHING HERE COMPUTES A TOTAL THE SERVER WILL NOT RE-CHECK. The footing readout is a courtesy
   so the arithmetic is visible while it is being done; RY40H is the control, and it runs on
   figures this screen cannot influence. A client-side total that agreed with itself and disagreed
   with the invoice is exactly the false green this module has been bitten by. */
/* What the document was actually split into, read back from the stored lines rather than from
   whatever this screen last had in memory — the same reason the SharePoint copies are proved by
   read-back. `lines` has been in the queue payload since the register was built. */
function invSplitSummary(r){
  var h = '<input type="hidden" id="job-' + esc(r.id) + '" value="">'
    + '<div class="sub" style="width:100%">Split across ' + r.lines.length + ' units: ';
  h += r.lines.map(function(l){
    return esc(invUnitLabel(invJobName(l.job_no) || l.job_no || "?")) + ' ' + fmt(Number(l.amount)||0);
  }).join(' &middot; ');
  return h + ' <button class="pfill" style="padding:1px 7px;margin-left:4px" '
    + 'onclick="invSplitStart(' + invArg(r.id) + ')">Change split</button></div>';
}
function invSplitStart(id){
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0];
  if(!r) return;
  /* ⚠ THE SPLIT EDITOR IS DRIVEN BY A COMMUNITY'S CANDIDATE LIST, so without one there is nothing
     to render and setting `_split` would hide the row's only control behind a blank. The general
     many-job split — Beer & Slabaugh billing New Paris, PHM and Shipshewana on one page, which is
     the case `ryc_invoice_lines` was actually written for — needs a picker over all 53 jobs and is
     NOT built here. Refusing loudly beats a dead end. */
  var fam = _inv.families[r.job_text || ""];
  if(!fam || !fam.candidates || !fam.candidates.length){
    invErr(id, "A split needs a list of units to split across, and this invoice names no community. "
      + "Assign it to one job for now.");
    return;
  }
  // Re-opening a stored split starts from what was stored, not from an empty form — and those are
  // real figures somebody decided, so the automatic fill is OFF from the outset.
  var units = [], amt = {}, auto = true;
  if(r.lines && r.lines.length){
    auto = false;
    r.lines.forEach(function(l){
      if(!l.job_no) return;
      units.push(l.job_no); amt[l.job_no] = (Number(l.amount)||0).toFixed(2);
    });
  } else if(r._unit){ units.push(r._unit); }
  r._split = { units: units, amt: amt, auto: auto };
  r._unit = null;
  if(auto && units.length) invSplitEven(id); else invPaint();
}
function invSplitCancel(id){
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0];
  if(r){ r._split = null; }
  invPaint();
}
/* Harvest the boxes into state BEFORE any repaint. Without this the amounts live only in the
   markup and the next repaint eats them — the 2026-08-21 defect, one screen over. */
function invSplitSync(id){
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0];
  if(!r || !r._split) return;
  r._split.units.forEach(function(no){
    var el = document.getElementById("sp-" + id + "-" + no);
    if(el) r._split.amt[no] = el.value;
  });
}
/* ⛔ THE SPLIT OPENED ON "$0 of $670" IN RED — an error state before anyone had done anything
   wrong, which is a bad first thing to show a PM who has just decided to do the right thing.
   Keith, on the empty boxes: *"$0.00 gets entered into box."* Picking units now fills them evenly
   straight away, so the default is a valid split he adjusts rather than a refusal he clears.
   ⚠ IT ONLY EVER TOUCHES AMOUNTS NOBODY HAS TYPED. `_split.auto` stays true until a box is edited
   by hand (or the split was re-opened from stored lines, which are real figures); after that,
   adding a unit leaves the other amounts exactly as he set them and only the new one is blank.
   Overwriting a typed allocation to keep it tidy would be the tool deciding how the money splits. */
function invSplitToggle(id, jobNo){
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0];
  if(!r || !r._split) return;
  invSplitSync(id);
  var i = r._split.units.indexOf(jobNo);
  if(i < 0) r._split.units.push(jobNo);
  else { r._split.units.splice(i, 1); delete r._split.amt[jobNo]; }
  if(r._split.auto && r._split.units.length) invSplitEven(id);   // repaints
  else invPaint();
}
/* A hand-typed amount ends the automatic fill, permanently for this split. */
function invSplitTyped(id){
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0];
  if(r && r._split) r._split.auto = false;
  invSplitSync(id);
  invPaint();
}
/* An even split of an odd number of cents. The remainder goes onto the FIRST lines a cent at a
   time rather than being rounded away, because $670.00 across 3 units is 223.34/223.33/223.33 and
   a split that totals $669.99 is refused by RY40H — correctly, and with a message about the
   document rather than about arithmetic nobody performed. */
function invSplitEven(id){
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0];
  if(!r || !r._split || !r._split.units.length) return;
  var n = r._split.units.length;
  var cents = Math.round((Number(r.amount) || 0) * 100);
  var base = Math.floor(cents / n), extra = cents - (base * n);
  r._split.units.forEach(function(no, i){
    r._split.amt[no] = ((base + (i < extra ? 1 : 0)) / 100).toFixed(2);
  });
  // Pressing Even is a statement that even is what he wants — so adding a unit re-evens.
  r._split.auto = true;
  invPaint();
}
function invSplitTotal(r){
  var t = 0;
  (r._split ? r._split.units : []).forEach(function(no){
    var v = parseFloat(r._split.amt[no]);
    if(!isNaN(v)) t += Math.round(v * 100);
  });
  return t / 100;
}
function invSplitPicker(r, fam){
  var id = r.id, sp = r._split, amount = Number(r.amount) || 0;
  var total = invSplitTotal(r), off = Math.abs(total - amount) > 0.005;
  var h = '<input type="hidden" id="job-' + esc(id) + '" value="">'
    + '<div class="sub" style="width:100%;margin-bottom:3px">' + esc(fam.label)
    + ' &mdash; split across which units?</div>'
    + '<div style="display:flex;gap:3px;flex-wrap:wrap;width:100%;margin-bottom:4px">';
  h += invUnitChips(fam.candidates, function(c){
    return '<button class="pfill' + (sp.units.indexOf(c.no) >= 0 ? " on" : "")
      + '" style="padding:2px 8px" title="' + esc(c.no + " · " + c.name) + '" '
      + 'onclick="invSplitToggle(' + invArg(id) + ',' + invArg(c.no) + ')">'
      + esc(invUnitLabel(c.name)) + '</button>';
  });
  h += '</div>';
  if(sp.units.length){
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;width:100%;align-items:center">';
    sp.units.forEach(function(no){
      var c = fam.candidates.filter(function(x){ return x.no === no; })[0] || { no:no, name:no };
      h += '<span style="white-space:nowrap"><span class="sub">' + esc(invUnitLabel(c.name))
        + '</span> <input id="sp-' + esc(id) + '-' + esc(no) + '" value="'
        + esc(sp.amt[no] == null ? "" : sp.amt[no]) + '" inputmode="decimal" '
        + 'onchange="invSplitTyped(' + invArg(id) + ')" style="width:78px"></span>';
    });
    h += '</div>';
  }
  h += '<div class="sub" style="width:100%;margin-top:4px">'
    + '<button class="pfill" style="padding:1px 7px" onclick="invSplitEven(' + invArg(id) + ')">Even</button> '
    + '<button class="pfill" style="padding:1px 7px" onclick="invSplitCancel(' + invArg(id) + ')">Cancel split</button> '
    + '<span class="' + (off ? "m-r" : "m-g") + '" style="margin-left:6px">'
    + fmt(total) + ' of ' + fmt(amount)
    + (off ? ' &mdash; must account for the whole document' : ' &check;') + '</span></div>';
  return h;
}
/* ⛔ THE PICK LIVES ON THE ROW, NOT IN THE DOM — 2026-08-21, ON THE OTHER SCREEN, VERBATIM.
   "if you select job then edit the file name - you have to reselect the job again": a selection
   held only in the markup is destroyed by every repaint, and this cell repaints when the budget
   lines land and again when the community list does. A chip that looks chosen while `job-<id>`
   has been rebuilt empty would let Save code an invoice to NO JOB and report success. So the
   answer is written to the row, the chip's `on` state is RENDERED from the row, and `invSave`
   reads the row rather than the field. */
function invPickUnit(id, jobNo, el){
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0];
  if(r) r._unit = jobNo;
  var f = document.getElementById("job-" + id);
  if(f) f.value = jobNo;
  var box = document.getElementById("units-" + id);
  if(box){
    var b = box.getElementsByTagName("button");
    for(var i = 0; i < b.length; i++) b[i].className = "pfill";
  }
  el.className = "pfill on";
}
/* ===== ONE FLUSH, CALLED BY BOTH BUTTONS ==============================================
   ⛔ THE HOLE THIS CLOSES WAS ALREADY WRITTEN DOWN THREE LINES ABOVE `invReview`, AND IT
   RE-OPENED ANYWAY. That comment says Approve must not ignore what is on the screen, because the
   controls are local state until Save is pressed and Approve reads the server. It was made true
   for the cost code and Mat/Sub — as a PATCH TO ONE FUNCTION rather than as a rule — so when the
   unit chip and the split were added later, nobody added them to that flush and Approve went back
   to ignoring the screen. Keith, live: *"Trying to assign one - does not seem to be working."*
   The row's stored state proved it exactly: Mat/Sub and month landed (Approve flushed the coding)
   and the job did not, so `ryc_review_invoice` raised RY40G for want of a job the screen had.

   So the flush is now A FUNCTION BOTH BUTTONS CALL, not a branch inside one of them. A control
   added tomorrow is wired here once and both doors get it.

   `force` is the only difference between them, and it preserves what each already did: Save is an
   explicit act and writes the coding even when nothing is dirty (that is what stamps `cost_month`);
   Approve only writes when something on screen differs from the server. */
function invFlushPending(id, ver, force){
  var r = _inv.rows.filter(function(x){ return x.id === id; })[0] || {};
  var jobEl = document.getElementById("job-" + id);
  // The row is authoritative for a chip pick; the field still carries a typed job number.
  var job = r._unit || (jobEl ? (jobEl.value || "").trim() : "");
  var cc  = (document.getElementById("cc-" + id)||{}).value || "";
  var ms  = (document.getElementById("ms-" + id)||{}).value || "";
  var told = [];
  var msName = ms === "mat" ? "Material" : ms === "sub" ? "Sub" : null;

  /* A SPLIT DOES NOT ASSIGN THE DOCUMENT TO A JOB, BECAUSE IT BELONGS TO SEVERAL. The lines carry
     the jobs and must foot to the invoice (RY40H); `job_no` on the invoice stays null and
     migration 054 clears `job_unassigned` once every line names a unit. Sending an `assign` as
     well would pick one of the units and call it the document's job — which is the single wrong
     number this whole exercise exists to stop producing. */
  if(r._split){
    invSplitSync(id);
    var lines = r._split.units.map(function(no){
      var nm = invJobName(no) || no;
      return { job_no:no, amount:(r._split.amt[no] || "").trim(), job_text:r.job_text || null,
               description:nm, cost_code:cc||null, mat_or_sub:ms||null,
               cost_month:invMonthFor(r), assigned_pm:r.assigned_pm || null };
    });
    if(!lines.length) return Promise.resolve({ error:"Choose the units this invoice is split across." });
    if(lines.some(function(l){ return !l.amount || isNaN(parseFloat(l.amount)); })){
      return Promise.resolve({ error:"Every unit in a split needs an amount. Use Even to fill them in." });
    }
    told.push("split across " + lines.length + " units");
    if(cc) told.push(cc);
    if(msName) told.push(msName);
    return invPost("code", { id:id, month:invMonthFor(r), cost_code:cc||null, mat_or_sub:ms||null,
      lines:lines, version:ver }).then(function(b){
        if(!b.ok || (b.data && b.data.error)) return { failed:b };
        r._split = null;
        return { version:(b.data && b.data.version) || ver, said:told.join(" · ") };
      });
  }

  var jobDirty  = !!job && job !== (r.job_no || "");
  var codeDirty = (cc && cc !== (r.cost_code || "")) || (ms && ms !== (r.mat_or_sub || ""));
  if(!jobDirty && !codeDirty && !force) return Promise.resolve({ version:ver, said:null });

  var step1 = jobDirty
    ? invPost("assign", { id:id, job_no:job, source:"manual", version:ver })
    : Promise.resolve({ ok:true, data:{ version:ver } });
  return step1.then(function(a){
    if(!a.ok || (a.data && a.data.error)) return { failed:a };
    var nv = (a.data && a.data.version) || ver;   // assign bumped it; carry it forward
    if(jobDirty){
      var nm = invJobName(job);
      told.push(nm ? invUnitLabel(nm) + " (" + job + ")" : job);
    }
    if(!codeDirty && !force) return { version:nv, said:told.join(" · ") || null };
    if(cc) told.push(cc);
    if(msName) told.push(msName);
    return invPost("code", { id:id, month:invMonthFor(r), cost_code:cc||null,
      mat_or_sub:ms||null, version:nv }).then(function(b){
        if(!b.ok || (b.data && b.data.error)) return { failed:b };
        return { version:(b.data && b.data.version) || nv, said:told.join(" · ") || null };
      });
  });
}
function invSave(id, ver){
  if(_inv.busy) return;
  _inv.busy = true;
  invFlushPending(id, ver, true).then(function(f){
    if(f.error){ _inv.busy = false; invErr(id, f.error); return; }
    if(f.failed){ invAfter(id, f.failed); return; }
    invAfter(id, { ok:true, data:{} }, f.said || "Saved");
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
/* APPROVE MUST NOT IGNORE WHAT IS ON THE SCREEN. The controls are local state until Save is
   pressed and Approve reads the server, so a PM who chose something and hit Approve was told the
   row lacked it — true of the database and plainly false of the screen.
   ⚠ THIS NO LONGER LISTS WHICH CONTROLS. It calls `invFlushPending`, the one place that knows what
   is pending, precisely because the first version of this fix enumerated the cost code and Mat/Sub
   and was therefore silently wrong the day a unit chip and a split were added. */
function invReview(id, decision, ver){
  if(_inv.busy) return;
  if(decision !== "approved"){
    _inv.busy = true;
    invPost("review", { id:id, decision:decision, version:ver }).then(function(r2){ invAfter(id, r2); });
    return;
  }
  _inv.busy = true;
  invFlushPending(id, ver, false).then(function(f){
    if(f.error){ _inv.busy = false; invErr(id, f.error); return; }
    if(f.failed){ invAfter(id, f.failed); return; }
    return invPost("review", { id:id, decision:decision, version:f.version })
      .then(function(x){ invAfter(id, x, x.ok && !(x.data && x.data.error) ? "Approved" : null); });
  });
}
/* ===== HAND THE BATCH OVER ======================================================
   This replaces `invCloseBatch`, which produced a summary and told the PM it was *"the summary the
   front office receives"* while sending it nowhere.

   ⛔ IT SAYS WHAT IT IS DOING WHILE IT DOES IT. Keith, 2026-08-27: *"the user would expect something
   onscreen letting them know the process is running."* The submit writes a submission row, carries
   his coding onto every document in the scanned folder and queues each page for stamping — several
   round trips, and on a forty-document folder that is not instant. The button goes to "Submitting…"
   before the request leaves, and the panel keeps saying so until the answer lands, because a button
   that looks idle while work is happening is how a person presses it twice. */
function invSubmitBatch(batchId){
  if(!batchId || _inv.submitting[batchId]) return;
  var n = _inv.rows.filter(function(r){ return r.batch_id === batchId; }).length;
  if(!window.confirm("Submit this batch to the front office?\n\n" + n + " invoice(s). Each approved "
      + "page is stamped with your coding, and the folder goes to Erica to reconcile.\n\n"
      + "You cannot take it back from here.")) return;

  _inv.submitting[batchId] = true;
  invPaint();
  invPost("submit_batch", { batch_id: batchId }).then(function(r){
    delete _inv.submitting[batchId];
    if(!r.ok || !r.data || r.data.error){
      /* ⛔ SAY IT ON THE BATCH, NOT IN AN ALERT THAT THE NEXT REPAINT ERASES THE CONTEXT OF. The
         server's refusal names the vendors still outstanding — that is the useful half. */
      _inv.submitError = _inv.submitError || {};
      _inv.submitError[batchId] = (r.data && r.data.error) || r.error || "Could not submit the batch.";
      invPaint();
      return;
    }
    if(_inv.submitError) delete _inv.submitError[batchId];
    _inv.submitted[batchId] = {
      submitted_at: (r.data.submission && r.data.submission.submitted_at) || new Date().toISOString(),
      summary: r.data.summary || null,
      carried: r.data.carried || null,
      already: !!r.data.already,
    };
    /* Reload rather than trusting the local copy: the submit moved server-side state (job numbers
       carried onto documents, stamps queued) and the desk should show what is actually true. */
    invLoad();
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
