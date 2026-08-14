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

var _batch = { id:null, job:null, timer:null, sel:{} };

function batchStop(){ if(_batch.timer){ clearInterval(_batch.timer); _batch.timer = null; } }

/* Matches the archive's own folder convention — "approved 81326" is the 2026-08-13 batch. */
function batchSuggestFolder(){
  var d = new Date();
  return "approved " + (d.getMonth()+1) + "" + d.getDate() + "" + String(d.getFullYear()).slice(2);
}

function renderBatch(){
  batchStop();
  _batch = { id:null, job:null, timer:null, sel:{} };
  var v = document.getElementById("view");
  v.innerHTML =
    '<div class="panel"><div class="h">Batch process</div>'
    + '<div class="sub">Drop the scanned stack the office has already worked. Pages are rendered and '
    + 'read, you confirm where each document starts and ends, then every payable is filed as its own '
    + 'named PDF in one SharePoint folder.</div>'
    + '<div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">'
    + '<input type="file" id="batchFile" accept="application/pdf">'
    + '<label class="sub">Folder <input id="batchFolder" value="' + esc(batchSuggestFolder()) + '" style="width:180px"></label>'
    + '<label class="sub">Received <input id="batchRecd" type="date" value="' + esc(new Date().toISOString().slice(0,10)) + '"></label>'
    + '<button class="pfill" id="batchGo" onclick="batchStart()">Start</button>'
    + '</div>'
    + '<div id="batchErr" class="sub m-r" style="margin-top:6px"></div></div>'
    + '<div id="batchLive"></div><div id="batchRecent"></div>';
  batchLoadRecent();
}

function batchLoadRecent(){
  invPost("batch_status", {}).then(function(r){
    var el = document.getElementById("batchRecent");
    if(!el || !r.ok || !r.data.jobs || !r.data.jobs.length) return;
    var h = '<div class="panel"><div class="h">Recent batches</div><table class="t"><tbody>';
    r.data.jobs.forEach(function(j){
      h += '<tr><td>' + esc(j.folder) + '<div class="sub">' + esc(j.filename) + '</div></td>'
        + '<td class="sub">' + esc(j.status)
        + (j.error ? ' <span class="m-r">' + esc(String(j.error).slice(0,70)) + '</span>' : '') + '</td>'
        + '<td class="r">'
        + (j.folder_url ? '<a href="' + esc(j.folder_url) + '" target="_blank" rel="noopener">Open folder</a> ' : '')
        + '<button class="pfill" onclick="batchWatch(' + invArg(j.id) + ')">View</button>'
        /* A job that never got its file holds its folder name — the uniqueness rule stops two
           live jobs aiming at one SharePoint folder. Without this the name is stuck. */
        + (["new","uploaded","proposed","failed"].indexOf(j.status) >= 0
            ? ' <button class="pfill" onclick="batchCancel(' + invArg(j.id) + ')">Cancel</button>' : '')
        + '</td></tr>';
    });
    el.innerHTML = h + '</tbody></table></div>';
  });
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

function batchBar(j){
  var failed = j.status === "failed", pct = failed ? 100 : batchPct(j);
  var col = failed ? "#c0392b" : (j.status === "filed" ? "#2e7d32" : "#d2601a");
  return '<div style="background:#e9ecef;border-radius:6px;height:10px;overflow:hidden;margin:8px 0">'
    + '<div style="height:100%;width:' + pct + '%;background:' + col + ';transition:width .4s ease"></div></div>'
    + '<div class="sub">' + esc(j.phase_note || j.status) + (failed ? "" : " &middot; " + pct + "%") + '</div>';
}

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
      + '<div style="margin-top:10px"><a class="pfill" href="' + esc(j.folder_url||"#") + '" target="_blank" '
      + 'rel="noopener" style="text-decoration:none;padding:7px 12px">Open the SharePoint folder</a></div>';
    if(f.documents && f.documents.length){
      h += '<table class="t" style="margin-top:10px"><tbody>';
      f.documents.forEach(function(d){
        h += '<tr><td>' + esc(d.name) + '</td><td class="sub r" style="width:50px">' + d.pages + 'p</td>'
          + '<td class="r" style="width:110px">' + fmt(d.amount) + '</td></tr>';
      });
      h += '</tbody></table>';
    }
  }
  el.innerHTML = h + '</div>' + (j.status === "proposed" ? batchConfirmPanel(j) : "");
}

/* MERGE IS THE ONLY EDIT OFFERED, deliberately. Every boundary error on a real batch has been the
   reader SPLITTING one payable, never merging two. And there is no amount box: retyping a figure
   that is printed on the page is exactly the thing the scan is evidence of — the amount comes
   from whichever row is kept. */
function batchConfirmPanel(j){
  var docs = j.proposed || [];
  var cov = batchCoverage(docs, j.page_count || 0);
  var h = '<div class="panel"><div class="h">Confirm the documents &middot; '
    + docs.length + ' of ' + (j.page_count||0) + ' pages</div>'
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
      + '<td>' + esc(d.vendor_canonical || d.vendor_name || "—")
      /* Show the rename and its evidence. The name on the letterhead is not the name the front
         office files under, and a silent substitution is the kind of thing that is discovered
         six months later in a folder listing. */
      + (d.vendor_canonical && d.vendor_canonical !== d.vendor_name
          ? '<div class="sub">filed as this &middot; read as “' + esc(d.vendor_name) + '”'
            + (d.vendor_filed_count ? ' &middot; ' + d.vendor_filed_count + ' in the archive' : '') + '</div>'
          : '')
      + '<div class="sub">' + esc(d.doc_type || "")
      + (d.invoice_no ? " &middot; " + esc(d.invoice_no) : "")
      + (d.job_text ? " &middot; " + esc(String(d.job_text).slice(0,32)) : "") + '</div></td>'
      + '<td class="r" style="width:110px">' + fmt(d.amount || 0) + '</td></tr>';
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
             amount:Number(d.amount)||0, invoice_no:d.invoice_no || null };
  });
  invPost("batch_confirm", { id:j.id, manifest:manifest }).then(function(r){
    btn.disabled = false;
    if(!r.ok){ errEl.textContent = r.error || "Could not confirm."; return; }
    _batch.sel = {}; _batch.job = null;
    batchWatch(j.id);
  });
}
