"use strict";
/* ryc-invoices/batch.js — "Batch process": a scanned stack of paper invoices in, one named PDF
   per payable filed to a dated SharePoint folder out.

   WHY THIS IS A SEPARATE SCREEN FROM INBOUND
   Inbound is invoices arriving by email that must reach a PM's desk through the register. This
   is a stack the front office has ALREADY WORKED ON PAPER — it never enters the register, has no
   coding to capture, and goes straight to the archive. Same building, different job.

   WHY THE PAGE CANNOT JUST DO IT
   Nothing in a browser here can render a PDF (the Inbound intake panel says so and rejects them),
   nobody in a browser has the delegated SharePoint credential, and the filed vendor spellings
   live in a 2,968-invoice index on keith-agent-01. So this screen starts a JOB, uploads the file
   straight to private storage, and watches a row while the VM does the work — the same split as
   the filing worker.

   ⛔ WHY A "RUNS BY ITSELF" BUTTON STOPS IN THE MIDDLE
   Because on every real batch so far the reader has got boundaries wrong in ways that INVENT
   MONEY, and no later check can catch it: the batch PDF gets deleted and the count nobody took is
   gone with it. Measured, on four batches:
     · Patriot 150494 — p25 is the "Invoice Supporting Detail" page and its $4,444.75 is the
       contract billed-to-date. Read as its own document it is a payable that does not exist.
     · GME M-26070502 — page 1's totals all read "Continued"; read alone it is a $0.00 document
       and the real invoice is split in two.
     · Industrial Door — a $63,450.50 pay application and its own lien waiver read as two
       payables. Filing as-read doubles a $63K bill.
     · M. W. Chupp 13841 — one $43,875 payable read as three.
   So the bar runs the whole chain and stops on ONE screen. Merging is one click. */

var _batch = { id:null, job:null, timer:null, sel:{}, recent:[] };

function batchStop(){ if(_batch.timer){ clearInterval(_batch.timer); _batch.timer = null; } }

/* Matches the archive's own folder convention — "approved 81326" is the 2026-08-13 batch. */
function batchSuggestFolder(){
  var d = new Date();
  return "approved " + (d.getMonth()+1) + "" + d.getDate() + "" + String(d.getFullYear()).slice(2);
}

function renderBatch(){
  batchStop();
  _batch = { id:null, job:null, timer:null, sel:{}, recent:[] };
  // The reconcile panel is per-batch; leaving last batch's rows in memory would paint them under
  // the next one's header for the moment before the fetch returns.
  _recon = { docs: [], targets: _recon ? _recon.targets : null, batchId: null, busy: {} };

  /* ⛔ THIS SCREEN DID NOT OWN ITS OWN HEADER, so arriving from Inbound left the page titled
     "Inbound — Everything that has arrived and not yet been sent to a desk" over the batch
     uploader. Exactly the defect invoices.js:264 already records for Inbound -> PM Desks, and the
     same class as a button that misdescribes its own effect: the header is the reader's answer to
     "where am I". It matters more now that this is where the tool opens (app.js). */
  var _t = document.getElementById("view-title");
  if(_t) _t.textContent = "Batch process";
  var _c = document.getElementById("view-ctx");
  if(_c) _c.innerHTML = "The scanned stack the office has already worked &middot; filed to its own "
    + "SharePoint folder, then reconciled to a job";

  var v = document.getElementById("view");
  v.innerHTML =
    '<div class="panel"><div class="h">Batch process</div>'
    + '<div class="sub">Drop the scanned stack the office has already worked. Pages are rendered and '
    + 'read, you confirm where each document starts and ends, then every payable is filed as its own '
    + 'named PDF in one SharePoint folder.</div>'
    + '<div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">'
    + '<input type="file" id="batchFile" accept="application/pdf">'
    + '<label class="sub">Folder <input id="batchFolder" value="' + esc(batchSuggestFolder()) + '" style="width:180px"></label>'
    /* Each file is named by the RECEIVED stamp read off its own page; this is only the fallback
       for a document whose stamp is missing or illegible, so it says so. */
    + '<label class="sub">If no stamp <input id="batchRecd" type="date" value="' + esc(new Date().toISOString().slice(0,10)) + '"></label>'
    + '<button class="pfill" id="batchGo" onclick="batchStart()">Start</button>'
    + '</div>'
    + '<div id="batchErr" class="sub m-r" style="margin-top:6px"></div></div>'
    + '<div id="batchLive"></div><div id="batchRecent"></div>';
  batchLoadRecent();
}

/* Two refreshes can be in flight at once — Dismiss fires one per click, and the front office
   clicks Dismiss twice in a row. Responses are not ordered, so the FIRST reply can land last and
   repaint a row that has already been dismissed. The row then sits there looking undismissed
   until a manual reload. Seen live 2026-08-20: two batches dismissed, one kept painting until
   refresh. A sequence token means only the newest answer is allowed to draw. */
var _batchRecentSeq = 0;

function batchLoadRecent(){
  var seq = ++_batchRecentSeq;
  invPost("batch_status", {}).then(function(r){
    var el = document.getElementById("batchRecent");
    if(seq !== _batchRecentSeq) return;       // a newer refresh already answered
    if(!r.ok || !r.data.jobs) return;
    _batch.recent = r.data.jobs;              // the twin check in the confirm panel reads this
    if(!el) return;
    /* ⛔ EMPTY MUST REPAINT, NOT RETURN. This used to bail out when the list came back empty,
       leaving the PREVIOUS list painted — so dismissing the last batch left it on screen looking
       exactly like a batch that had not been dismissed. "Nothing to show" is a state to draw. */
    if(!r.data.jobs.length){ el.innerHTML = ""; return; }
    /* COMPLETE BATCHES ARE SET ASIDE, NOT MIXED IN (Keith, 2026-08-20). `reconciled` comes from
       the API so the page never re-derives what "done" means. Outstanding first — that is the
       work; finished ones sit below under their own heading so the board reads as a queue
       rather than a log. */
    var jobs = r.data.jobs;
    var openJobs = jobs.filter(function(j){ return !j.reconciled; });
    var doneJobs = jobs.filter(function(j){ return j.reconciled; });
    var h = "";
    if(openJobs.length) h += batchRecentTable("Batches needing you", openJobs, false);
    if(doneJobs.length) h += batchRecentTable("Complete", doneJobs, true);
    el.innerHTML = h;
  });
}

function batchRecentTable(title, jobs, done){
  var h = '<div class="panel"><div class="h">' + esc(title)
    + ' <span class="sub">' + jobs.length + '</span></div>'
    + (done ? '<div class="sub">Every payable in these is assigned to a job or marked RYC '
        + 'Expense. Nothing here is waiting on anybody.</div>' : '')
    + '<table class="t" style="margin-top:6px"><tbody>';
  jobs.forEach(function(j){
      h += '<tr><td>' + esc(j.folder) + '<div class="sub">' + esc(j.filename) + '</div></td>'
        /* SAY HOW MUCH IS LEFT, not just that something is. "3 of 6 reconciled" is the number the
           front office is actually asking the board for. */
        + '<td class="sub">'
        + (j.docs
            ? (j.reconciled
                ? '<b class="m-g">&#10003; ' + j.docs + ' reconciled</b>'
                : '<b class="m-a">' + (j.docs - j.docs_done) + ' of ' + j.docs + ' outstanding</b>')
              + (j.docs_failed ? ' <span class="m-r">&middot; ' + j.docs_failed + ' failed</span>' : '')
            : '')
        + '</td>'
        + '<td class="sub">'
        + (j.status === "proposed"
            ? '<b style="color:#b7791f">' + BATCH_LABEL.proposed + '</b>'
            : esc(BATCH_LABEL[j.status] || j.status))
        + (j.error ? ' <span class="m-r">' + esc(String(j.error).slice(0,70)) + '</span>' : '') + '</td>'
        + '<td class="r">'
        + (j.folder_url ? '<a href="' + esc(j.folder_url) + '" target="_blank" rel="noopener">Open folder</a> ' : '')
        + '<button class="pfill" onclick="batchWatch(' + invArg(j.id) + ')">View</button>'
        /* A job that never got its file holds its folder name — the uniqueness rule stops two
           live jobs aiming at one SharePoint folder. Without this the name is stuck. */
        + (["new","uploaded","proposed","failed"].indexOf(j.status) >= 0
            ? ' <button class="pfill" onclick="batchCancel(' + invArg(j.id) + ')">Cancel</button>' : '')
        /* CLEARING THE BOARD IS NOT DELETING ANYTHING. This hides the row; the batch, its
           verification and its SharePoint folder are all untouched. Offered on everything except
           the states the worker is actively driving — a run that is uploading into SharePoint must
           not vanish from the only screen showing it. */
        + (["rendering","reading","reconciling","filing"].indexOf(j.status) < 0
            ? ' <button class="pfill" onclick="batchDismiss(' + invArg(j.id) + ')">Dismiss</button>' : '')
        + '</td></tr>';
  });
  return h + '</tbody></table></div>';
}

/* The upload goes STRAIGHT to storage, never through the API: Vercel caps a request body around
   4.5MB and a 44-page colour scan is 6MB+, so routing it through the function would fail on the
   real input and pass on every small test. */
function batchStart(){
  var f = document.getElementById("batchFile");
  var file = f && f.files && f.files[0];
  var err = document.getElementById("batchErr");
  var btn = document.getElementById("batchGo");
  err.textContent = "";
  if(!file){ err.textContent = "Choose the scanned PDF first."; return; }
  if(!/\.pdf$/i.test(file.name) && file.type !== "application/pdf"){
    err.textContent = "That is not a PDF. This screen takes the scanner's PDF; loose page images go to Inbound.";
    return;
  }
  var folder = (document.getElementById("batchFolder")||{}).value || "";
  var recd = (document.getElementById("batchRecd")||{}).value || null;
  btn.disabled = true;

  invPost("batch_start", { filename:file.name, folder:folder, received_date:recd })
    .then(function(r){
      if(!r.ok){ err.textContent = r.error || "Could not start."; btn.disabled = false; return; }
      var job = r.data.job;
      document.getElementById("batchLive").innerHTML =
        '<div class="panel"><div class="h">Uploading</div><div class="sub">sending '
        + esc(file.name) + '&hellip;</div></div>';
      return fetch(r.data.upload_url, {
          method:"PUT", headers:{ "Content-Type":"application/pdf" }, body:file
        })
        .then(function(u){
          if(!u.ok) throw new Error("upload failed (" + u.status + ")");
          return invPost("batch_uploaded", { id: job.id });
        })
        .then(function(){ btn.disabled = false; batchWatch(job.id); });
    })
    .catch(function(e){ err.textContent = (e && e.message) || "Upload failed."; btn.disabled = false; });
}

function batchWatch(id){
  _batch.id = id; _batch.sel = {};
  batchStop(); batchPoll();
  _batch.timer = setInterval(batchPoll, 2500);
}

function batchPoll(){
  if(!_batch.id) return;
  invPost("batch_status", { id:_batch.id }).then(function(r){
    if(!r.ok || !r.data.job) return;
    /* Don't stamp on a merge in progress: once the operator is editing the proposal, the row on
       the server is not the truth any more — their screen is, until they confirm it. */
    if(_batch.job && _batch.job.status === "proposed" && r.data.job.status === "proposed") return;
    _batch.job = r.data.job;
    batchPaint();
    if(_batch.job.status === "filed" || _batch.job.status === "failed"){ batchStop(); batchLoadRecent(); }
    if(_batch.job.status === "proposed") batchStop();     // waiting on a person, stop polling
  });
}

/* One bar for the whole chain, weighted by what actually takes the time — reading is minutes and
   everything else is seconds, so a bar with equal steps would jump to 80% and sit there. */
function batchPct(j){
  var s = j.status, n, d;
  if(s === "filed") return 100;
  if(s === "new") return 2;
  if(s === "uploaded") return 6;
  if(s === "rendering") return 12;
  if(s === "reading"){
    n = Number(j.page_count)||0; d = Number(j.pages_read)||0;
    return 15 + (n ? Math.round(45 * d / n) : 0);           // 15 -> 60
  }
  if(s === "proposed") return 62;
  if(s === "confirmed") return 66;
  if(s === "filing"){
    n = Number(j.page_count)||0; d = Number(j.pages_read)||0;
    return 70 + (n ? Math.round(28 * d / n) : 0);           // 70 -> 98
  }
  return 0;
}

/* ⛔ A JOB THAT IS WAITING FOR A PERSON MUST NOT LOOK LIKE A JOB THAT IS RUNNING.
   Keith, 2026-08-14, on a batch that finished reading at 15:22 and sat until 18:29: *"if I click
   view it shows in progress — it was started a few hours ago."* It was not in progress; it was
   done and waiting for him. But `proposed` painted the same moving orange bar at 62% as
   `reading`, so the one state that REQUIRES a human read as the one state that requires nothing.
   The pause is the whole design of this tool; if the pause is invisible the tool is broken. */
function batchBar(j){
  var failed = j.status === "failed";
  var waiting = j.status === "proposed";
  var pct = failed || waiting ? 100 : batchPct(j);
  var col = failed ? "#c0392b" : (j.status === "filed" ? "#2e7d32" : (waiting ? "#b7791f" : "#d2601a"));
  return '<div style="background:#e9ecef;border-radius:6px;height:10px;overflow:hidden;margin:8px 0">'
    + '<div style="height:100%;width:' + pct + '%;background:' + col + ';transition:width .4s ease"></div></div>'
    + (waiting
        ? '<div><b style="color:#b7791f">Waiting for you.</b> Reading finished &mdash; confirm the '
          + 'documents below, then it files. Nothing happens until you do.</div>'
        : '<div class="sub">' + esc(j.phase_note || j.status) + (failed ? "" : " &middot; " + pct + "%") + '</div>');
}

/* The same distinction in the list: "proposed" is a state name, not an instruction. */
var BATCH_LABEL = { "new":"waiting for the file", uploaded:"queued", rendering:"working",
  reading:"reading", proposed:"WAITING FOR YOU", confirmed:"queued for filing",
  filing:"filing", filed:"filed", failed:"stopped" };

function batchPaint(){
  var j = _batch.job, el = document.getElementById("batchLive");
  if(!el || !j) return;
  var h = '<div class="panel"><div class="h">' + esc(j.folder)
    + ' <span class="sub" style="font-weight:400">&middot; ' + esc(j.filename) + '</span></div>'
    + batchBar(j);

  if(j.status === "failed"){
    h += '<div class="sub m-r" style="margin-top:6px"><b>Stopped.</b> ' + esc(j.error || "") + '</div>';
    if(j.folder_url){
      h += '<div style="margin-top:6px"><a href="' + esc(j.folder_url) + '" target="_blank" rel="noopener">'
        + 'Open the folder and check what is in it</a></div>';
    }
  } else if(j.status === "filed"){
    var f = j.filed || {};
    h += '<div style="margin-top:8px"><b>' + (f.files||0) + ' document(s) &middot; '
      + (f.pages_back||0) + ' pages &middot; ' + fmt(f.total||0) + '</b></div>'
      + '<div class="sub">Verified by downloading every file back out of SharePoint — not by trusting '
      + 'the upload’s own 201s.</div>'
      + (f.no_stamp
          ? '<div class="sub m-a">' + f.no_stamp + ' file(s) had no readable RECEIVED stamp and were '
            + 'named with the batch date.</div>'
          : '')
      + '<div style="margin-top:10px"><a class="pfill" href="' + esc(j.folder_url||"#") + '" target="_blank" '
      + 'rel="noopener" style="text-decoration:none;padding:7px 12px">Open the SharePoint folder</a></div>';
    /* THE RECONCILIATION LIVES IN ITS OWN PANEL, loaded from the document rows rather than from the
       verification blob.  records what the machine did; the rows below record what
       a person still owes a decision on, and only one of those two can be edited. */
    var rr = f.reconciliation || {};
    if(rr.read && rr.read !== f.files){
      h += '<div class="sub">Read as ' + rr.read + ' document(s), reconciled to ' + f.files
        + ' before filing.</div>';
    }
    if((rr.pay_app_amounts || []).length){
      h += '<div class="sub m-a">' + rr.pay_app_amounts.length
        + ' pay application amount(s) corrected from the form&rsquo;s own arithmetic.</div>';
    }
  }
  el.innerHTML = h + '</div>' + (j.status === "proposed" ? batchConfirmPanel(j) : "")
    + (j.status === "filed" ? '<div id="batchRecon"></div>' : "");
  if(j.status === "filed" && _recon.batchId !== j.id) reconLoad(j.id);
  else if(j.status === "filed") reconRender();
}

/* MERGE IS THE ONLY EDIT OFFERED, deliberately. Every boundary error on a real batch has been the
   reader SPLITTING one payable, never merging two. And there is no amount box: retyping a figure
   that is printed on the page is exactly the thing the scan is evidence of — the amount comes
   from whichever row is kept. */
function batchConfirmPanel(j){
  var docs = j.proposed || [];
  var cov = batchCoverage(docs, j.page_count || 0);
  /* The folder is unique per live job, but the SCAN is not — start the same PDF twice and you get
     two live jobs that will each file the whole batch into a folder of its own. The uniqueness
     index cannot catch that (the folders differ, which is the point of it), so say it here. */
  var twins = (_batch.recent || []).filter(function(o){
    return o.id !== j.id && o.filename === j.filename
      && ["new","uploaded","rendering","reading","proposed","confirmed","filing"].indexOf(o.status) >= 0;
  });
  var h = '<div class="panel"><div class="h">Confirm the documents &middot; '
    + docs.length + ' of ' + (j.page_count||0) + ' pages</div>'
    + (twins.length
        ? '<div class="m-r" style="margin-bottom:6px"><b>' + esc(j.filename) + ' is already running as '
          + twins.map(function(o){ return '“' + esc(o.folder) + '”'; }).join(", ")
          + '.</b> Filing both puts this same stack in two folders — cancel the one you do not want.</div>'
        : '')
    + '<div class="sub">Every page must belong to exactly one document. Tick two or more rows and '
    + '<b>Merge</b> where the reader has split one payable — a "Continued" page, a supporting-detail '
    + 'page, or a pay application scanned with its own lien waiver. The first ticked row is kept.</div>'
    + '<div style="margin:8px 0"><button class="pfill" onclick="batchMerge()">Merge selected</button> '
    + '<button class="pfill" onclick="batchReset()">Start over</button> '
    + '<span id="batchCov" class="sub">' + (cov.ok ? "" : '<span class="m-r">coverage not clean</span>') + '</span></div>'
    + '<table class="t"><tbody>';
  docs.forEach(function(d, i){
    var span = d.page_from === d.page_to ? ("p" + d.page_from) : ("p" + d.page_from + "–" + d.page_to);
    h += '<tr><td style="width:26px"><input type="checkbox" ' + (_batch.sel[i] ? "checked " : "")
      + 'onchange="batchSel(' + i + ',this.checked)"></td>'
      + '<td class="sub" style="width:74px">' + esc(span) + '</td>'
      + '<td>' + batchVendorCell(d, i)
      + '<div class="sub">' + esc(d.doc_type || "")
      + (d.invoice_no ? " &middot; " + esc(d.invoice_no) : "")
      + (d.job_text ? " &middot; " + esc(String(d.job_text).slice(0,32)) : "") + '</div>'
      /* THE FILENAME'S DATE. It is the office's own RECEIVED stamp, per document — a stack
         routinely spans days. Where no stamp could be read, say so here rather than let the
         batch default go into a filename silently. */
      + (d.received_stamp
          ? '<div class="sub">stamped ' + esc(d.received_stamp) + '</div>'
          : '<div class="sub m-a">no RECEIVED stamp read — will file under the batch date</div>')
      + '</td>'
      /* A row the reader could not price is almost always a continuation page. Say so loudly —
         it cannot be filed, and the fix is to merge it into the document above it. */
      + '<td class="r" style="width:110px">'
      + (d.amount === null || d.amount === undefined || d.amount === ""
          ? '<span class="m-r">no amount</span>'
          : fmt(d.amount))
      + '</td></tr>';
  });
  var total = docs.reduce(function(a,d){ return a + (Number(d.amount)||0); }, 0);
  h += '</tbody></table>'
    + '<div class="sub" style="margin-top:6px">' + docs.length + ' document(s) &middot; ' + fmt(total) + '</div>'
    + '<div style="margin-top:10px"><button class="pfill" id="batchFileBtn" onclick="batchConfirm()">'
    + 'File to SharePoint</button> <span id="batchConfErr" class="sub m-r"></span></div></div>';
  return h;
}

function batchCancel(id){
  invPost("batch_cancel", { id:id }).then(function(r){
    if(!r.ok){ var e = document.getElementById("batchErr"); if(e) e.textContent = r.error || "Could not cancel."; return; }
    if(_batch.id === id){ batchStop(); _batch.job = null; document.getElementById("batchLive").innerHTML = ""; }
    batchLoadRecent();
  });
}

/* Take a finished batch off the board. NOTHING IN SHAREPOINT IS TOUCHED and the batch record is
   kept — this only stops the row being painted, so a two-day-old traceback cannot go on reading
   like a live failure. A batch that was still WAITING is also abandoned by this, because a hidden
   job must never act later; the API says so and the confirmation below repeats it in the words
   that matter to whoever is clicking. */
function batchDismiss(id){
  var j = null, i;
  for(i = 0; i < (_batch.recent || []).length; i++) if(_batch.recent[i].id === id) j = _batch.recent[i];
  var waiting = j && ["new","uploaded","proposed"].indexOf(j.status) >= 0;
  var name = j ? j.folder : "this batch";
  var ask = waiting
    ? 'Dismiss "' + name + '"?\n\nIt has not been filed yet, so dismissing it ABANDONS it — it '
      + 'will never file.\n\nNothing already in SharePoint is deleted.'
    : 'Dismiss "' + name + '"?\n\nThis only clears it from this list. The batch record and its '
      + 'SharePoint folder are left exactly as they are.';
  if(!window.confirm(ask)) return;
  invPost("batch_dismiss", { id:id }).then(function(r){
    var e = document.getElementById("batchErr");
    if(!r.ok){ if(e) e.textContent = r.error || "Could not dismiss."; return; }
    if(e) e.textContent = "";
    if(_batch.id === id){ batchStop(); _batch.job = null; document.getElementById("batchLive").innerHTML = ""; }
    batchLoadRecent();
  });
}

/* THE FILED NAME IS A JUDGEMENT, SO IT IS A CONTROL AND NOT A LABEL.
   The archive keeps "Big C" (34 filed) and "Big C Lumber" (8) as SEPARATE vendors, and "Alpha"
   (87), "Alpha Bldg" (252) and "Alpha Bldg Ctr" (1) as three more — deliberately, because merging
   spellings is a confirmed human decision and an unconfirmed near-match would rename a vendor on
   a guess. So the server offers the related clusters with their counts and the operator picks;
   the default is the exact-key match, or the printed name when the archive has never seen them. */
function batchVendorCell(d, i){
  var chosen = d.vendor_canonical || d.vendor_name || "";
  var opts = d.vendor_options || [];
  var h = "";
  if(opts.length > 1 || (opts.length === 1 && opts[0].spelling !== d.vendor_name)){
    h += '<select onchange="batchVendorPick(' + i + ',this.value)" style="max-width:230px">';
    var seen = {};
    opts.forEach(function(o){
      seen[o.spelling] = 1;
      h += '<option value="' + esc(o.spelling) + '"' + (o.spelling === chosen ? " selected" : "") + '>'
        + esc(o.spelling) + ' — ' + o.count + ' filed</option>';
    });
    if(!seen[d.vendor_name]){
      h += '<option value="' + esc(d.vendor_name || "") + '"' + (chosen === d.vendor_name ? " selected" : "") + '>'
        + esc(d.vendor_name || "—") + ' — as printed</option>';
    }
    h += '</select>';
  } else {
    h += esc(chosen || "—");
    if(!opts.length) h += ' <span class="sub">new vendor — filed as printed</span>';
  }
  if(chosen !== d.vendor_name){
    h += '<div class="sub">read off the document as “' + esc(d.vendor_name || "") + '”</div>';
  }
  return h;
}

function batchVendorPick(i, spelling){
  var docs = (_batch.job && _batch.job.proposed) || [];
  if(docs[i]) docs[i].vendor_canonical = spelling;
}

function batchSel(i, on){ _batch.sel[i] = on; }
function batchReset(){ _batch.sel = {}; _batch.job = null; batchWatch(_batch.id); }

function batchMerge(){
  var docs = (_batch.job.proposed || []).slice();
  var idx = Object.keys(_batch.sel).filter(function(k){ return _batch.sel[k]; })
              .map(Number).sort(function(a,b){ return a - b; });
  var covEl = document.getElementById("batchCov");
  if(idx.length < 2){ if(covEl) covEl.innerHTML = '<span class="m-r">Tick at least two rows to merge.</span>'; return; }
  var froms = idx.map(function(i){ return docs[i].page_from; });
  var tos   = idx.map(function(i){ return docs[i].page_to; });
  var merged = Object.assign({}, docs[idx[0]], {
    page_from: Math.min.apply(null, froms),
    page_to:   Math.max.apply(null, tos),
  });
  var out = [];
  docs.forEach(function(d, i){
    if(i === idx[0]) out.push(merged);
    else if(idx.indexOf(i) === -1) out.push(d);
  });
  out.sort(function(a,b){ return a.page_from - b.page_from; });
  _batch.job.proposed = out;
  _batch.sel = {};
  batchPaint();
}

/* Coverage is checked HERE and again server-side. A page claimed twice is a payable filed twice;
   a page claimed by nothing is a payable that vanishes between the scanner and the archive —
   and neither is detectable afterwards, because the batch PDF gets deleted. */
function batchCoverage(docs, pages){
  var seen = {}, dupes = [], missing = [], p;
  docs.forEach(function(d){
    for(p = d.page_from; p <= d.page_to; p++){ if(seen[p]) dupes.push(p); seen[p] = 1; }
  });
  for(p = 1; p <= pages; p++) if(!seen[p]) missing.push(p);
  return { dupes:dupes, missing:missing, ok: !dupes.length && !missing.length };
}

function batchConfirm(){
  var j = _batch.job, docs = j.proposed || [];
  var errEl = document.getElementById("batchConfErr");
  var cov = batchCoverage(docs, j.page_count || 0);
  if(!cov.ok){
    errEl.innerHTML = cov.dupes.length
      ? "Page " + cov.dupes[0] + " is claimed by two documents."
      : "Pages claimed by no document: " + cov.missing.join(", ");
    return;
  }
  var btn = document.getElementById("batchFileBtn");
  btn.disabled = true; errEl.textContent = "";
  var manifest = docs.map(function(d){
    return { page_from:d.page_from, page_to:d.page_to, vendor_name:d.vendor_name,
             vendor_canonical:d.vendor_canonical || null,
             amount:Number(d.amount)||0, invoice_no:d.invoice_no || null,
             // The office's RECEIVED stamp — this is the date the file is named by. Null falls
             // back to the batch date, and the confirm screen has already said which rows those are.
             received_stamp:d.received_stamp || null };
  });
  invPost("batch_confirm", { id:j.id, manifest:manifest }).then(function(r){
    btn.disabled = false;
    if(!r.ok){ errEl.textContent = r.error || "Could not confirm."; return; }
    _batch.sel = {}; _batch.job = null;
    batchWatch(j.id);
  });
}

/* ===================== RECONCILING A FILED BATCH ================================
   Keith, 2026-08-19: *"this is a reconciliation process for the front office - as part of their
   process each invoice needs to be filed to its proper job folder or assigned as RYC Expense."*

   Filing the batch produced the archive. This is the second half: one row per payable, each ending
   either copied into its job's Vendor Invoices folder or declared RYC Expense. Both are DONE — the
   difference is whether a file moved, not whether a decision was made.

   PAY APPLICATIONS ARE SHOWN SEPARATELY because they are read differently: a pay app's amount is
   the money due THIS period, sitting on a face sheet beside four larger numbers that are not bills.
   A reviewer scanning a mixed list has to re-orient on every row. */
var _recon = { docs: [], targets: null, batchId: null, busy: {} };

function reconLoad(batchId, render){
  _recon.batchId = batchId;
  var need = _recon.targets ? Promise.resolve(null) : invPost("file_targets", {});
  Promise.all([invPost("batch_documents", { id: batchId }), need]).then(function(rs){
    if(rs[0] && rs[0].ok) _recon.docs = rs[0].data.documents || [];
    if(rs[1] && rs[1].ok) _recon.targets = rs[1].data.jobs || [];
    if(render !== false) reconRender();
  });
}

function reconDoc(id){
  for(var i=0;i<_recon.docs.length;i++) if(_recon.docs[i].id === id) return _recon.docs[i];
  return null;
}

/* A pay application and its own lien waiver arrive as one payable, so `pay_application` here means
   "the reconciler kept the pay app as the payable" — the waiver is inside the same PDF. */
function reconIsPayApp(d){ return (d.doc_type || "") === "pay_application"; }

function reconRender(){
  var el = document.getElementById("batchRecon");
  if(!el) return;
  var docs = _recon.docs;
  if(!docs.length){ el.innerHTML = ""; return; }

  var done = 0, expense = 0, failedN = 0;
  docs.forEach(function(d){
    if(d.reconciled_at){ done++; if(d.disposition === "ryc_expense") expense++; }
    else if(d.copy_error && d.copy_error !== "working") failedN++;
  });
  var open = docs.length - done;

  var h = '<div class="panel"><div class="h">Reconcile &middot; ' + docs.length + ' document(s)</div>'
    + '<div class="sub">Every invoice ends in one of two places: copied into its job&rsquo;s Vendor '
    + 'Invoices folder, or marked <b>RYC Expense</b> &mdash; an overhead cost that belongs to no job '
    + 'and is deliberately filed nowhere. The batch folder keeps its copy either way.</div>'
    + '<div style="margin-top:8px"><b>' + done + ' of ' + docs.length + ' done</b>'
    + (expense ? ' <span class="sub">&middot; ' + expense + ' RYC Expense</span>' : '')
    + (open ? ' <span class="m-a">&middot; ' + open + ' outstanding</span>' : '')
    + (failedN ? ' <span class="m-r">&middot; ' + failedN + ' failed</span>' : '')
    + '</div>';

  var pay = docs.filter(reconIsPayApp), inv = docs.filter(function(d){ return !reconIsPayApp(d); });
  if(pay.length) h += reconGroup("Pay applications", pay);
  if(inv.length) h += reconGroup(inv.length === docs.length ? "Invoices" : "Invoices and other documents", inv);
  el.innerHTML = h + '</div>';
}

function reconGroup(title, docs){
  var total = 0;
  docs.forEach(function(d){ total += Number(d.amount || 0); });
  var h = '<div style="margin-top:14px"><b>' + esc(title) + '</b> <span class="sub">'
    + docs.length + ' &middot; ' + fmt(total) + '</span></div>'
    + '<table class="t" style="margin-top:6px"><tbody>';
  docs.forEach(function(d){ h += reconRow(d); });
  return h + '</tbody></table>';
}

function reconRow(d){
  var busy = !!_recon.busy[d.id];
  var doneAt = d.reconciled_at;
  var err = (d.copy_error && d.copy_error !== "working") ? d.copy_error : null;
  var working = d.copy_error === "working" || busy;

  var name = '<div>' + esc(d.file_name) + '</div>'
    + '<div class="sub">' + (d.page_to - d.page_from + 1) + 'p'
    + (d.vendor ? ' &middot; ' + esc(d.vendor) : '')
    + (d.invoice_no ? ' &middot; #' + esc(d.invoice_no) : '')
    /* WHAT THE VENDOR PRINTED, shown even when it resolved — four spellings of one job is a fact
       the front office needs to see, and it is the only way to tell a good match from a lucky one. */
    + (d.job_text ? ' &middot; printed &ldquo;' + esc(String(d.job_text).slice(0, 40)) + '&rdquo;' : '')
    + '</div>';

  /* THE JOB COLUMN. Keith, 2026-08-19: *"Can we add Job name as a column ... We might not know it
     specifically with these batches but moving forward will."* It is a control rather than a label
     because the answer is often already known — the matcher resolved it from the printed text — and
     the front office's job is to confirm or correct it, not to retype it. */
  var job = "";
  if(doneAt){
    /* THREE ENDINGS, AND THE ROW HAS TO SAY WHICH ONE. "filed" is a claim that a copy exists in a
       job folder; for a job with no folder that claim is false, and a false green tick is the
       defect this module has now hit four times. */
    var ended = "filed " + esc(String(doneAt).slice(0,10));
    if(d.disposition === "ryc_expense") ended = "RYC Expense &middot; not filed to a job folder";
    else if(d.disposition === "job_unfiled") ended = "resolved &middot; this job has no SharePoint folder, "
      + "so nothing was copied";
    job = '<div>' + esc(d.job_name || d.job_no || "") + '</div>'
      + '<div class="sub">' + ended + '</div>';
  } else {
    var opts = '<option value="">&mdash; choose a job &mdash;</option>';
    (_recon.targets || []).forEach(function(t){
      opts += '<option value="' + esc(t.no) + '"' + (t.no === d.job_no ? ' selected' : '') + '>'
        + esc(t.name) + (t.no === "RYC-EXPENSE" ? "" : " (" + esc(t.no) + ")") + '</option>';
    });
    job = '<select id="rj_' + esc(d.id) + '" class="pfill" style="max-width:260px"'
      + (working ? ' disabled' : '') + ' onchange="reconRelabel(' + invArg(d.id) + ')">'
      + opts + '</select>'
      + (d.job_stage_error
          ? '<div class="sub m-r">' + esc(d.job_stage_error) + '</div>'
          : (d.job_source === "matched" && d.job_no
              ? '<div class="sub">read off the invoice &mdash; confirm or change it</div>' : ''));
  }

  /* ⛔ THE ROW IS ORDERED BY THE WORK, NOT BY THE DATA (Keith, 2026-08-20, after running a batch
     WITH the front office): *"I felt like there needed to be an order in which files were renamed
     and jobs were changed or assigned... that is the real life flow and we should do the same with
     the UI."*
       look at it  ->  say whose job it is  ->  fix the name  ->  complete it
     Before this, View and Edit name sat in one trailing action cell to the RIGHT of the button
     that ENDS the row, so the two things you do first were the two things furthest from where you
     started reading — and "Edit name" appeared after a control that makes renaming impossible
     (a reconciled document is deliberately refused a rename; the copy in the job folder is filed
     under the name it had). Reading order now matches the order of operations, which is the same
     reason the label tracks the dropdown: the screen should describe the work truthfully. */
  var view = d.sp_url
    ? '<a class="pfill" href="' + esc(d.sp_url) + '" target="_blank" rel="noopener" '
      + 'style="text-decoration:none;padding:6px 10px;white-space:nowrap">View invoice</a>'
    : '<span class="sub">&mdash;</span>';

  var rename = "", act = "";
  if(doneAt){
    /* Done: there is nothing left to rename, so that cell carries WHERE IT LANDED instead. */
    /* ⛔ "OPEN IN JOB FOLDER" OPENED THE INVOICE (Keith, 2026-08-21): *"it should open the sharepoint
       job folder where the invoice landed."* `copied_url` is the UPLOADED FILE's webUrl — the worker
       sends `item.get("webUrl")` — so the link did exactly what View invoice already does, and the
       one thing the label promised (see the folder, see it in context, see what else is in it) was
       the one thing it could not do. A control that misdescribes its own effect, again.

       Trimming the last segment is not a guess: verified against live Graph on 2026-08-21, the
       trimmed file webUrl is byte-identical to the string Graph reports as that folder's own
       webUrl, including names carrying commas and periods. Deriving it here rather than changing
       the worker also repairs every row that was filed before today, with no backfill. */
    var folderUrl = reconFolderUrl(d.copied_url);
    if(folderUrl){
      rename = '<a href="' + esc(folderUrl) + '" target="_blank" rel="noopener">Open in job folder</a>';
    }
    /* Nothing goes in the rename cell for an expense — the job cell already says "RYC Expense .
       not filed to a job folder", and saying it twice reads as two different facts. */
    /* A wrong job WILL happen — Kropp Fire Protection matched Milford Water Utility off a delivery
       address reading "CHORE TIME 410 N. HIGBEE ST. MILFORD". Correcting is a different act from
       repeating: it MOVES the file rather than filing a second copy, and the old placement is kept
       in the row's history. It sits in the completion column because it is what replaces it. */
    act = '<button class="pfill" onclick="reconCorrect(' + invArg(d.id) + ')">Change job</button>';
    if((d.history || []).length){
      act += '<div class="sub">corrected ' + d.history.length + '&times;</div>';
    }
  } else if(working){
    act = _recon.stalled
      ? '<span class="sub m-r">still copying &mdash; the filing worker has not answered. '
        + 'Reload to check.</span>'
      : '<span class="sub">copying to SharePoint&hellip;</span>';
  } else {
    rename = '<button class="pfill" onclick="reconRename(' + invArg(d.id) + ')">Edit name</button>';
    /* THE BUTTON SAYS WHAT THE CLICK WILL DO. With RYC Expense chosen, "File to job" describes
       the opposite of what happens — nothing is copied anywhere. The label tracks the dropdown.
       "Complete:" is the front office's own word for the end of the row (Keith, 2026-08-20) and it
       carries through BOTH labels — dropping it on the expense branch would make the two endings
       look like different kinds of act when they are the same one. */
    var chosen = d.job_no || "";
    act = '<button class="pfill" id="rb_' + esc(d.id) + '" onclick="reconFile(' + invArg(d.id) + ')">'
      + reconFileLabel(chosen) + '</button>';
  }
  /* ⛔ A REFUSAL MUST HAND HER SOMETHING TO DO (Keith, 2026-08-21, reading
     *"only 1 distinctive word matched between 'Huntertown Wastewater Treatment Plan Expansion:
     Phase 3' and '2025/Huntertown WWTP' — too weak to file on"*): *"seems like more of a statement
     than anything ... the user should be able to action it."*
     That text is the matcher's internal score narrated at a person. It says how the algorithm felt
     and names no next step, which is the same failure as a button that misdescribes its own effect:
     the screen is talking about itself instead of about her work. */
  if(err){
    act += '<div class="sub m-r" style="margin-top:4px">' + reconWhy(err) + '</div>';
    if(!doneAt && !working){
      /* TWO REAL ANSWERS TO A REFUSAL, because there are two different reasons for one.
         "Point at the folder" is for a job whose folder exists and simply does not resemble its
         name. "Resolve without filing" is for a job that HAS no folder and never will — measured
         2026-08-21, that is 30 of RYC's 53 active jobs. Offering only one of them would leave half
         the refusals with no honest way out. */
      act += '<div style="margin-top:4px">'
        + '<button class="pfill" onclick="reconPickFolder(' + invArg(d.id) + ')">'
        + 'Point at the folder</button> '
        + '<button class="pfill" onclick="reconNoFile(' + invArg(d.id) + ')">'
        + 'Resolve without filing</button></div>';
    }
  }

  return '<tr><td>' + name + '</td>'
    + '<td class="r" style="width:110px">' + fmt(d.amount) + '</td>'
    + '<td style="width:120px">' + view + '</td>'
    + '<td style="width:300px">' + job + '</td>'
    + '<td style="width:120px">' + rename + '</td>'
    + '<td class="r" style="width:210px">' + act + '</td></tr>';
}

/* The folder a filed copy sits in, from the file's own URL. Returns null rather than a half-URL if
   there is nothing to trim — a link that goes somewhere wrong is worse than no link. */
function reconFolderUrl(fileUrl){
  var u = String(fileUrl || "").split("?")[0].replace(/\/+$/, "");
  if(!/^https?:\/\//i.test(u)) return null;
  var cut = u.lastIndexOf("/");
  if(cut < 0) return null;
  var folder = u.slice(0, cut);
  return /^https?:\/\/[^/]+\/.+/i.test(folder) ? folder : null;
}

/* ONE definition of the completion label, because it is written in two places — once when the row
   is painted and once when the dropdown changes under it (reconRelabel). Two copies is how a
   control starts describing the wrong effect. */
function reconFileLabel(jobNo){
  return jobNo === "RYC-EXPENSE" ? "Complete: Mark RYC Expense" : "Complete: File to Job";
}

/* THE FILER'S REASON, SAID TO A PERSON. The raw strings are diagnostics written for whoever was
   debugging the matcher — distinctive-word counts and folder keys. They are true and they are
   useless at this desk, so each one is restated as what is missing and what she can do about it.
   The original is kept underneath: when the front office reports a problem, the exact refusal is
   what makes it findable, and paraphrasing it away would cost that. */
function reconWhy(err){
  var raw = String(err || "");
  var say = null;
  var m = raw.match(/only \d+ distinctive words? matched .* and '([^']+)'/);
  if(m){
    say = "Couldn&rsquo;t tell which SharePoint folder this job is. The closest is <b>"
      + esc(m[1]) + "</b>.";
  } else if(/^no job folder resembles/.test(raw)){
    say = "There is no SharePoint folder for this job, so there is nothing to copy into.";
  } else if(/job folders match .* equally/.test(raw)){
    say = "More than one SharePoint folder could be this job, so it refused to choose rather than "
      + "risk filing against the wrong budget.";
  } else if(/^no distinctive words/.test(raw)){
    say = "This job&rsquo;s name has nothing distinctive to match a folder on.";
  }
  if(!say) return esc(raw.slice(0, 200));
  return say + ' <span class="sub">(' + esc(raw.slice(0, 160)) + ')</span>';
}

/* POINT AT THE FOLDER, AND THE SYSTEM REMEMBERS. Keith, 2026-08-21: *"the user should be able to
   action it."*

   `resolve_job_folder()` has always consulted a human-confirmed job -> folder map before any
   scoring — and the file it read had never been created, so that override was reachable from
   nowhere. This is its handle. The pin is by JOB, not by document: the next invoice for the same
   job files without asking, which is the difference between fixing it and re-answering it monthly.

   ⚠ IT OUTRANKS THE MATCHER'S SAFETY RULES, so the confirmation says so plainly and the row records
   who set it. The list offered is only what the VM has actually seen in SharePoint — letting her
   type a path would move the failure to the copy instead of ending it. */
function reconPickFolder(id){
  var d = reconDoc(id);
  if(!d) return;
  var sel = document.getElementById("rj_" + id);
  var jobNo = sel ? sel.value : (d.job_no || "");
  if(!jobNo || jobNo === "RYC-EXPENSE"){
    alert("Choose the job first — the folder is remembered against the job, not this one invoice.");
    return;
  }
  var t = (_recon.targets || []).filter(function(x){ return x.no === jobNo; })[0];
  var jobLabel = t ? t.name : jobNo;

  invPost("job_folders", {}).then(function(r){
    if(!r.ok){ alert(r.error || "The folder list could not be read."); return; }
    var folders = (r.data && r.data.folders) || [];
    if(!folders.length){
      alert("No SharePoint folders have been published yet.\n\nRun publish_job_folders.py on the VM.");
      return;
    }
    /* A guess, offered as the default rather than applied: the folder whose name shares the most
       with the job. She is confirming, not hunting through 77 lines. */
    var guess = reconClosestFolder(jobLabel, folders);
    var msg = "Which SharePoint folder is \"" + jobLabel + "\"?\n\n"
      + "This is remembered for the job — every future invoice for it files here without asking, "
      + "and it overrides the automatic matcher.\n\n"
      + (r.data.as_of ? "Folder list published " + String(r.data.as_of).slice(0,10) + ".\n\n" : "")
      + "Type or paste one of:\n" + folders.join("\n");
    var pick = window.prompt(msg, guess || folders[0]);
    if(pick === null) return;
    pick = String(pick).trim();
    if(!pick) return;

    invPost("job_folder_pin", { job_no:jobNo, folder:pick, note:d.copy_error }).then(function(p){
      if(!p.ok){ alert(p.error || "That folder could not be saved."); return; }
      var n = (p.data && p.data.rearmed) || 0;
      /* Say what it actually did. The pin is by job, so it can release invoices she is not looking
         at, and a silent side effect on other rows is worse than a noisy one. */
      alert(jobLabel + " will file to:\n" + pick
        + (n ? "\n\n" + n + " invoice(s) for this job are filing now." : ""));
      reconLoad(_recon.batchId);
      if(n) reconPoll(10);
    });
  });
}

/* The best guess at which folder a job is, by shared words. Only ever a DEFAULT in the prompt —
   nothing is pinned without a person accepting it. */
function reconClosestFolder(jobName, folders){
  var stop = { the:1, of:1, and:1, a:1, an:1, at:1, "in":1, on:1, "for":1, llc:1, inc:1, co:1,
    project:1, phase:1, "new":1, addition:1, town:1, city:1, county:1, school:1 };
  function words(s){
    return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter(function(w){ return w && !stop[w] && !/^\d+$/.test(w); });
  }
  var want = words(jobName), best = null, bestN = 0;
  folders.forEach(function(f){
    var have = words(f.indexOf("/") >= 0 ? f.slice(f.indexOf("/") + 1) : f);
    var n = 0;
    want.forEach(function(w){ if(have.indexOf(w) >= 0) n++; });
    if(n > bestN){ bestN = n; best = f; }
  });
  return bestN ? best : null;
}

/* THE THIRD ENDING. Keith, 2026-08-21: *"We dont want a folder for Brad style projects - we just
   want erica to be able to resolve it without moving a file to sharepoint."*

   Measured against the live folder index the same day: 30 of RYC's 53 Procore-active jobs have no
   SharePoint folder at all — 29 Greencroft unit jobs plus St. Joe County Garages. So this is the
   ordinary case for a whole class of work, not an escape hatch.

   ⚠ IT IS OFFERED ONLY ON A ROW THE FILER HAS ALREADY REFUSED. Put it on every row and it becomes
   the fast way to clear the board, and invoices quietly stop reaching the job folders that do
   exist — which is the entire point of the tool. */
function reconNoFile(id){
  var d = reconDoc(id);
  if(!d) return;
  var sel = document.getElementById("rj_" + id);
  var jobNo = sel ? sel.value : (d.job_no || "");
  if(!jobNo || jobNo === "RYC-EXPENSE"){
    alert("Choose the job this cost belongs to first.\n\nRYC Expense is a different answer — it "
      + "means the cost belongs to no job at all.");
    return;
  }
  var t = (_recon.targets || []).filter(function(x){ return x.no === jobNo; })[0];
  if(!window.confirm('Resolve "' + d.file_name + '" against ' + (t ? t.name : jobNo)
      + ' without filing?\n\nThe cost is recorded against that job. Nothing is copied to '
      + 'SharePoint — the batch folder keeps the only copy. This cannot be undone from here.')) return;

  _recon.busy[id] = true; reconRender();
  invPost("doc_reconcile", { doc_id:id, job_no:jobNo, no_filing:true, reason:d.copy_error })
    .then(function(r){
      delete _recon.busy[id];
      if(!r.ok){ alert(r.error || "Could not resolve it."); reconRender(); return; }
      reconLoad(_recon.batchId);
    });
}

/* One click, one document. The button disappears the moment it is pressed and the server refuses a
   second attempt anyway — `reconciled_at is null` guards the write, so a double-click cannot file
   an invoice into a job folder twice. */
function reconFile(id){
  var d = reconDoc(id);
  if(!d) return;
  var sel = document.getElementById("rj_" + id);
  var jobNo = sel ? sel.value : "";
  if(!jobNo){ alert("Choose a job, or RYC Expense if this is not a job cost."); return; }
  var t = (_recon.targets || []).filter(function(x){ return x.no === jobNo; })[0];
  var label = t ? t.name : jobNo;
  var msg = jobNo === "RYC-EXPENSE"
    ? 'Mark "' + d.file_name + '" as RYC Expense?\n\nIt stays in the batch folder and is NOT copied '
      + 'to any job folder. This cannot be undone from here.'
    : 'File "' + d.file_name + '" to ' + label + '?\n\nA copy goes into that job’s Vendor '
      + 'Invoices folder. The batch folder keeps its copy. This cannot be undone from here.';
  if(!window.confirm(msg)) return;

  _recon.busy[id] = true; reconRender();
  invPost("doc_reconcile", { doc_id:id, job_no:jobNo }).then(function(r){
    delete _recon.busy[id];
    if(!r.ok){ alert(r.error || "Could not file it."); reconRender(); return; }
    /* A job copy is QUEUED, not finished — the VM holds the SharePoint credential. Poll until the
       worker reports where it landed, so the link Keith asked for appears on its own rather than
       after a manual refresh. */
    reconLoad(_recon.batchId);
    if(r.data && r.data.queued) reconPoll(10);
  });
}

/* ⚠ THIS USED TO GIVE UP AFTER 15 SECONDS AND SAY NOTHING. Six ticks at 2.5s, then the row kept
   reading "copying..." forever with nothing still watching it. `batch_worker.py` is a bare `nohup`
   with no supervisor, so "copying" can also mean "the worker is dead" — and the screen asserted a
   live upload either way. Same family as the two-day-old traceback that read as a current error.
   Now: backs off to about a minute, and when it does run out it SAYS SO. */
function reconPoll(left, wait){
  if(left <= 0){ reconStall(); return; }
  _recon.stalled = false;
  wait = wait || 1200;
  setTimeout(function(){
    invPost("batch_documents", { id:_recon.batchId }).then(function(r){
      if(r.ok) _recon.docs = r.data.documents || [];
      if(!reconBusyEditing()) reconRender();
      var pending = _recon.docs.some(function(d){ return d.copy_error === "working"; });
      if(pending) reconPoll(left - 1, Math.min(Math.round(wait * 1.5), 9000));
    });
  }, wait);
}

/* "Nothing came back" is a state to draw, not a reason to stop drawing. */
function reconStall(){
  if(!_recon.docs.some(function(d){ return d.copy_error === "working"; })) return;
  _recon.stalled = true;
  if(!reconBusyEditing()) reconRender();
}

/* THE MASTER EDIT. Deliberately offered only before filing: once a copy exists in a job folder
   under a given name, renaming one of the two copies makes the archive disagree with itself. */
function reconRename(id){
  var d = reconDoc(id);
  if(!d) return;
  var next = window.prompt("File name for this invoice:", d.file_name);
  if(next === null) return;
  next = String(next).trim();
  if(!next || next === d.file_name) return;
  /* Show it immediately — she typed it, so making her watch a round trip to learn what she already
     knows is the "waiting for the UI to catch up" she described. The server still has the last
     word (it appends .pdf and rejects characters SharePoint will not take), so the response is
     applied over the top rather than assumed. */
  var was = d.file_name;
  d.file_name = next;
  reconRender();
  invPost("doc_update", { doc_id:id, file_name:next }).then(function(r){
    var cur = reconDoc(id);
    if(!cur) return;
    if(!r.ok){
      cur.file_name = was;
      reconRender();
      alert(r.error || "Could not rename it.");
      return;
    }
    if(r.data && r.data.document) cur.file_name = r.data.document.file_name;
    reconRender();
  });
}

/* Keep the action button honest as the dropdown changes, and SAVE the choice. */
function reconRelabel(id){
  var sel = document.getElementById("rj_" + id), btn = document.getElementById("rb_" + id);
  if(!sel) return;
  if(btn) btn.textContent = reconFileLabel(sel.value);
  reconStageJob(id, sel.value);
}

/* ⛔ THE JOB SHE PICKED LIVED ONLY IN THE DOM, AND THREE DIFFERENT THINGS PAINTED OVER IT (Keith,
   2026-08-21, watching the front office): *"it seems that if you select job then edit the file name
   - you have reselect the job again ... it's almost like she has to wait a few seconds until the UI
   catches up."*

   It was not lag. `reconRender()` rebuilds every row with `innerHTML =`, and until this change the
   selection existed nowhere else — so the choice was DESTROYED, silently, by:
     - Edit name           (reconRename -> reconLoad -> reconRender)
     - Complete on ANY row (reconFile, twice)
     - THE POLL, EVERY 2.5 SECONDS while any row was copying
   The third is the one she felt. While row 1 was uploading to SharePoint, row 5's selection was
   being wiped on a timer whether or not anybody touched it: pick a job, watch it vanish, pick it
   again. The comment above this function already warned that a re-render throws away unsaved
   selections — that was known, and then three other paths did it anyway.

   The fix is not to repaint less. It is to stop holding her work somewhere a repaint can reach:
   the choice is written to the row the moment she makes it, so every future repaint RESTORES it
   instead of erasing it — including repaints from causes nobody has thought of yet. `doc_update`
   already accepted `job_no`, so this costs no schema change and no new endpoint.

   The local copy is updated BEFORE the request goes out, deliberately: a repaint that fires while
   the save is still in flight must still show what she chose. */
function reconStageJob(id, jobNo){
  var d = reconDoc(id);
  if(!d || d.reconciled_at) return;
  var t = (_recon.targets || []).filter(function(x){ return x.no === jobNo; })[0];
  d.job_no = jobNo || null;
  d.job_name = t ? t.name : null;
  d.job_source = jobNo ? "chosen" : null;
  invPost("doc_update", { doc_id:id, job_no:jobNo }).then(function(r){
    var cur = reconDoc(id);
    if(!cur || cur.reconciled_at) return;
    if(!r.ok){
      /* Say it. A selection that looks saved and is not is worse than one that never took. */
      cur.job_stage_error = r.error || "That job could not be saved — choose it again.";
      reconRender();
      return;
    }
    cur.job_stage_error = null;
    if(r.data && r.data.document){
      cur.job_no = r.data.document.job_no;
      cur.job_name = r.data.document.job_name;
      cur.job_source = r.data.document.job_source;
    }
  });
}

/* A REPAINT MUST NOT REACH IN AND CLOSE A DROPDOWN SHE IS USING. The poll fires on a timer with no
   idea whether somebody is mid-choice; rebuilding the table under an open <select> closes it and
   drops the keystrokes. Skipping the paint costs nothing — the next tick draws it. */
function reconBusyEditing(){
  var a = document.activeElement, el = document.getElementById("batchRecon");
  return !!(a && el && el.contains(a) && (a.tagName === "SELECT" || a.tagName === "INPUT"));
}

/* CHANGE THE JOB ON A DOCUMENT THAT IS ALREADY FILED. Keith, 2026-08-19: *"the user should have the
   ability to edit Job Assignment (in case there is an error)."*

   This is a MOVE. The copy sitting in the wrong job's folder is removed and the document is
   re-filed to the right one — leaving both would reconcile one payable against two job budgets,
   which is worse than the original mistake and much harder to notice.

   Deliberately a separate control from the ordinary flow: the guard that stops a double-click
   filing one payable twice is still in force, and this is the other case. It needs saying out loud
   before it runs, which is why the confirmation names where the file is now and what will happen
   to it. */
function reconCorrect(id){
  var d = reconDoc(id);
  if(!d) return;
  var NL = String.fromCharCode(10);
  var where = d.disposition === "ryc_expense"
    ? "RYC Expense (no copy in any job folder)"
    : "filed to " + (d.job_name || d.job_no);
  var next = window.prompt(
    'Change the job on "' + d.file_name + '".' + NL + NL
      + "It is currently " + where + "." + NL + NL
      + "Type the job number to move it to, or RYC-EXPENSE." + NL
      + "The copy in the current job folder is REMOVED, then re-filed to the new one.",
    d.job_no || "");
  if(next === null) return;
  next = String(next).trim();
  if(!next) return;
  var match = null;
  (_recon.targets || []).forEach(function(t){
    if(t.no.toLowerCase() === next.toLowerCase()) match = t;
  });
  if(!match){ alert(next + " is not a job that can be filed to."); return; }
  if(match.no === d.job_no){ return; }
  invPost("doc_recorrect", { doc_id:id, job_no:match.no }).then(function(r){
    if(!r.ok){ alert(r.error || "Could not change the job."); return; }
    reconLoad(_recon.batchId);
    if(r.data && r.data.queued) reconPoll(8);
  });
}
