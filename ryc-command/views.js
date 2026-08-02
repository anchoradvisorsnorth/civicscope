"use strict";
/* ryc-command/views.js — all view renderers + job-detail drawer
   Split from index.html (Phase 7). Classic scripts, load order: core → views → app. */
/* ===== Command Center ======================================================== */
/* The leadership headline is the contract-weighted aggregate of the SAME trusted row-level
   projection the Portfolio grades — not a separate revised-budget calculation (Codex #4: the
   old 9.3% headline used a different cost basis than the job rows beneath it). Jobs with no
   trusted ERP projection are EXCLUDED, and the coverage is disclosed alongside the number.
   Returns {pct, jobs, of, covered, total} or null. */
function projectedGrossMargin(){
  var tC=0, tPC=0, n=0, m=0, totC=0;
  getActiveJobs().forEach(function(j){
    var c=j.contractValue||0; if(c>0){ totC+=c; m++; }
    var pc=null;
    if(!projMarginSuspect(j) && j.budget && j.budget.projectedCost>0) pc=j.budget.projectedCost;
    // Greencroft board jobs carry no Procore ERP budget — Foundation as-bid + CO cost adj IS
    // their row-level projection everywhere else, so it counts as covered here too.
    if(pc==null && j.program==="greencroft" && j.foundation) pc=gcProjCost(j.foundation);
    if(c>0&&pc>0){ tC+=c; tPC+=pc; n++; }
  });
  // Greencroft leftovers (active in Foundation, not on the Procore board)
  greencroftJobs().forEach(function(f){
    var c=(f.currentContract>0)?f.currentContract:(f.originalContract||0); if(c>0){ totC+=c; m++; }
    var pc=gcProjCost(f); if(c>0&&pc>0){ tC+=c; tPC+=pc; n++; }
  });
  return tC>0?{pct:(tC-tPC)/tC*100, jobs:n, of:m, covered:tC, total:totC}:null;
}
function gmSub(gm){
  if(!gm) return "no trusted projections";
  var covPct=gm.total>0?Math.round(gm.covered/gm.total*100):0;
  return "row-level projections · "+gm.jobs+" of "+gm.of+" jobs ("+covPct+"% of contract)";
}

/* ===== Overview — the BRIEFING, not a second Portfolio (program 6.1) ====================
   Portfolio is the inventory; this is the briefing. They were showing substantially the same
   job list in two arrangements, and Overview was additionally near-identical to the Executive
   Brief. Each now answers a different question:

     Overview          what changed, what needs attention, and WHERE to go next  (working screen)
     Portfolio         what active jobs exist and how each is performing         (inventory)
     Executive Brief   what changed, what decisions matter, what is the outlook  (artifact)

   The difference between Overview and the Brief is not content, it is USE: this one links out
   to the page that owns each item, because the next thing you do is go there. The Brief is
   printed and presented, so it carries its own totals and links to nothing.

   Order is deliberate — what CHANGED leads, because a briefing that opens with a standing
   total tells you nothing you did not already know. Attention is ranked into ONE list rather
   than six equal-weight sections. No source-health cards, no refresh controls, no
   reconciliation prose, no portfolio table, no action register. */
function renderCommand(){
  var haveFnd=!!(foundationData&&foundationData.jobs);
  var haveAr=!!(arData&&arData.invoices);
  var jobs=getActiveJobs();
  var missing=[];
  if(!activeData||!activeData.jobs) missing.push("Procore");
  if(!haveFnd) missing.push("Foundation");
  if(!haveAr) missing.push("AR");
  var warn=missing.length?("<div class=\"warn-banner\">⚠️ "+missing.join(" + ")+" feed unavailable — affected figures show <b>Unavailable</b>, not $0.</div>"):"";

  var lights=jobs.map(function(j){return {j:j,sl:getStoplight(j,j)};});
  var closeouts=lights.filter(function(x){ return isCloseoutOnly(x.j); });
  var closeoutSet=new Set(closeouts.map(function(x){return x.j;}));
  var reds=lights.filter(function(x){return x.sl.color==="red" && !closeoutSet.has(x.j);});
  var ambers=lights.filter(function(x){return x.sl.color==="amber";});
  var fades=gainFadeRows().filter(function(r){return r.src==="erp"&&r.gfPts<=-GF_MOVE_PTS;}).sort(function(a,b){return a.gfPts-b.gfPts;});
  var accts=haveFnd?activeAccountRows():[];
  var payapps=haveFnd?billingStates().due:[];
  var overdue=accts.reduce(function(s2,r){return s2+r.overdue;},0);

  /* ---- 1. WHAT CHANGED (async; the container leads the page) ---- */
  var changed="<div class=\"panel\"><h3>What changed</h3><div id=\"delta-panel\"><div class=\"sub\">Computing from the nightly snapshot trail…</div></div></div>";

  /* ---- 2. NEEDS ATTENTION — one ranked list, grouped by business issue ---- */
  /* Greencroft collapses here too: a briefing that opens with nine near-identical unit jobs
     has buried everything else, and the program is one conversation (3.1). */
  function attn(cls,label,name,jno,detail,val){
    return "<div class=\"q-row "+cls+"\"><div class=\"q-job\">"+esc(name)+"<span class=\"q-jno\">"+esc(jno||"")+"</span></div>"
      +"<div class=\"q-detail\"><b>"+esc(label)+"</b> · "+detail+"</div>"
      +(val!=null?"<div class=\"q-val\">"+val+"</div>":"")+"</div>";
  }
  function collapseGc(items,getJob){
    var gc=items.filter(function(x){return getJob(x).program==="greencroft";});
    var rest=items.filter(function(x){return getJob(x).program!=="greencroft";});
    return {rest:rest,gc:gc};
  }
  var items=[];
  var rSplit=collapseGc(reds,function(x){return x.j;});
  rSplit.rest.forEach(function(x){
    items.push({rank:0,html:attn("red","Risk",x.j.name||"",x.j.projectNumber,
      esc(x.sl.reasons.filter(function(z){return z.level==="red";}).map(function(z){return z.text;}).join(" · "))+" · "+esc(pmName(x.j)||"no PM"),
      fmtCompact(x.j.contractValue))});
  });
  if(rSplit.gc.length>1) items.push({rank:0,html:attn("red","Risk","Greencroft program","",
    rSplit.gc.length+" unit jobs flagged — one program, itemised on Portfolio",
    fmtCompact(rSplit.gc.reduce(function(s2,x){return s2+(x.j.contractValue||0);},0)))});
  else rSplit.gc.forEach(function(x){ items.push({rank:0,html:attn("red","Risk",x.j.name||"",x.j.projectNumber,esc(pmName(x.j)||"no PM"),fmtCompact(x.j.contractValue))}); });

  fades.slice(0,4).forEach(function(r){
    items.push({rank:1,html:attn("fade","Margin",r.name,r.job,
      "fading <b>"+r.gfPts.toFixed(1)+" pts</b> vs as-bid"+(r.burnRisk?" · cost burn ahead of progress":"")+" · "+esc(r.pm),
      fmtCompact(r.gfDollars))});
  });
  closeouts.slice(0,3).forEach(function(x){
    var f=x.j.foundation||{};
    items.push({rank:2,html:attn("closeout","Closeout",x.j.name||"",x.j.projectNumber,
      daysPastFinish(x.j)+"d past finish · <b>"+fmtCompact(f.retainage||0)+"</b> retainage held",
      fmtCompact(x.j.contractValue))});
  });
  var aSplit=collapseGc(ambers,function(x){return x.j;});
  aSplit.rest.slice(0,4).forEach(function(x){
    items.push({rank:3,html:attn("amber","Watch",x.j.name||"",x.j.projectNumber,
      esc(x.sl.reasons.filter(function(z){return z.level==="amber";}).map(function(z){return z.text;}).join(" · ")),
      fmtCompact(x.j.contractValue))});
  });
  if(aSplit.gc.length>1) items.push({rank:3,html:attn("amber","Watch","Greencroft program","",aSplit.gc.length+" unit jobs to watch","")});
  items.sort(function(a,b){return a.rank-b.rank;});
  var attention="<div class=\"panel\"><h3>Needs attention</h3>"
    +"<div class=\"sub\">Ranked worst first, grouped by the kind of problem rather than by which page owns it. Each one is worked on the page named beside it.</div>"
    +(items.length?items.map(function(i){return i.html;}).join(""):"<div class=\"q-empty\">Nothing flagged — no confirmed risk, no material fade, nothing stuck in closeout.</div>")
    +"</div>";

  /* ---- 3. THIS WEEK'S OPERATING PICTURE — compact, each linking to its owning page ---- */
  function card(title,view,value,sub){
    return "<div class=\"kpi\" style=\"cursor:pointer\" role=\"button\" tabindex=\"0\""
      +" onclick=\"setView('"+view+"')\" onkeydown=\"if(event.key==='Enter'||event.key===' '){event.preventDefault();setView('"+view+"');}\">"
      +"<div class=\"kl\">"+title+" &rarr;</div><div class=\"kv\">"+value+"</div><div class=\"ks\">"+(sub||"")+"</div></div>";
  }
  var gm=projectedGrossMargin();
  var fwd=null;
  if(forecastData&&forecastData.projects){
    var sp=fcSpread(forecastData.projects); fwd=0;
    Object.keys(sp.buckets).forEach(function(m){ m=+m; if(m>=sp.nowIdx&&m<sp.nowIdx+12) fwd+=sp.buckets[m].booked; });
  }
  var week="<div class=\"panel\"><h3>This week</h3>"
    +"<div class=\"sub\">Where the work is. Each card opens the page that owns it.</div>"
    +"<div class=\"kpi-strip k4\">"
    +card("Billing &amp; Cash","billing",haveFnd?String(payapps.length):"—",
          haveFnd?("pay apps to process · "+fmtCompact(overdue)+" overdue AR"):"Foundation feed down")
    +card("Margin &amp; Risk","margin",gm?gm.pct.toFixed(1)+"%":"—",
          fades.length?(fades.length+" jobs fading vs as-bid"):"nothing fading")
    +card("Forecast","forecast",fwd!=null?fmtCompact(fwd):"—","booked, next 12 months")
    +card("Preconstruction","estimating",bcData&&bcData.published?String(bcData.published.length):"—","projects out to bid")
    +"</div><div id=\"brief-pipeline-mini\" class=\"sub\" style=\"margin-top:8px\"></div></div>";

  /* ---- 4. COVERAGE EXCEPTION — only when it changes how the numbers read ---- */
  var cov="";
  if(haveFnd&&activeData&&activeData.jobs){
    var roll=companyRollup();
    if(roll.coverageGap.n||roll.unclassified.n){
      cov="<div class=\"panel\"><h3>Coverage</h3><div class=\"sub\">"
        +(roll.coverageGap.n?("<b>"+roll.coverageGap.n+"</b> active jobs carrying "+fmtCompact(roll.coverageGap.contract)+" are not on the Procore board, so they are absent from stage, margin and field figures above. "):"")
        +(roll.unclassified.n?("<b>"+roll.unclassified.n+"</b> have no contract value recorded and are excluded from every company total. "):"")
        +"Full partition on Portfolio.</div></div>";
    }
  }
  /* A delayed feed is the one plumbing fact a briefing needs — healthy feeds stay silent. */
  var staleFeeds=[];
  [["Procore",!!activeData,activeData&&activeData.refreshed],["Foundation",!!foundationData,foundationData&&foundationData.refreshed],["AR",!!arData,arData&&arData.refreshed]]
    .forEach(function(x){ if(x[1]&&x[2]&&(Date.now()-new Date(x[2]))/3600000>30) staleFeeds.push(x[0]+" stale ("+ageTxt(x[2])+")"); });
  var staleWarn=staleFeeds.length?("<div class=\"warn-banner\">⚠️ Data delayed: "+staleFeeds.join(" · ")+" — details in Data Trust.</div>"):"";

  return warn+staleWarn+changed+attention+week+cov;
}

/* Computed change layer (Codex Step 4): week-over-week movement derived from the nightly
   Foundation snapshot trail (ryc_foundation_history via ?asof=) — billed, cost recorded,
   contract changes, new/closed jobs. Nothing here is manually maintained; there is no action
   register to keep current. Fails silent: no history → no panel, never an error surface. */
/* Typed delta computation (R5 #3 + #6): ONE cached DATA object keyed on both snapshots —
   Overview and the Executive Brief both render from it; HTML is never cached. */
var _deltaData=null;   // {key, data|null}
function computeDeltas(cb){
  if(!(foundationData&&foundationData.jobs)){ cb(null); return; }
  var asof=new Date(Date.now()-7*86400000).toISOString().slice(0,10);
  var cacheKey=String(foundationData.refreshed||"")+"|"+asof;
  if(_deltaData&&_deltaData.key===cacheKey){ cb(_deltaData.data); return; }
  fetch(CRM+"/api/ryc-foundation?asof="+asof).then(function(r){ return r.json(); }).then(function(old){
    if(!old||!old.jobs||!Object.keys(old.jobs).length){ _deltaData={key:cacheKey,data:null}; cb(null); return; }
    var cur=foundationData.jobs;
    // Comparability gate (R5 #3): the baseline is ONE coherent run (the API guarantees it and
    // echoes snapshotRun); absence still only means "job appeared/closed" when both sides look
    // complete. A materially smaller side = probable partial ingestion → $ deltas over shared
    // jobs still render, but new/closed classification is REFUSED and says so.
    var curN=Object.keys(cur).length, oldN=old.jobCount||Object.keys(old.jobs).length;
    var comparable=!!old.snapshotRun && oldN>=curN*0.85 && curN>=oldN*0.85;
    var billed=0,cost=0,shared=0,contractChanges=[],movers=[],newJobs=[],closed=[];
    Object.keys(cur).forEach(function(k){
      var c=cur[k],o=old.jobs[k];
      if(!o){ if(comparable&&c.jobStatus==="A"&&((c.currentContract||0)>0||(c.originalContract||0)>0)) newJobs.push(c); return; }
      shared++;
      var db=(c.totalInvoiced||0)-(o.totalInvoiced||0); if(isFinite(db)) billed+=db;
      var dc=(c.totalCosts||0)-(o.totalCosts||0); if(isFinite(dc)){ cost+=dc; if(dc>1000) movers.push({j:c,d:dc}); }
      var dk=(c.currentContract||0)-(o.currentContract||0);
      if(Math.abs(dk)>25000) contractChanges.push({j:c,d:dk});
    });
    if(comparable) Object.keys(old.jobs).forEach(function(k){ var o=old.jobs[k]; if(o.jobStatus==="A"&&(!cur[k]||cur[k].jobStatus==="C")) closed.push(o); });
    movers.sort(function(a,b){ return b.d-a.d; });
    contractChanges.sort(function(a,b){ return Math.abs(b.d)-Math.abs(a.d); });
    var data={ asof:asof, snapshotRun:old.snapshotRun||null, oldN:oldN, curN:curN, shared:shared, comparable:comparable,
      billed:billed, cost:cost, contractChanges:contractChanges, movers:movers, newJobs:newJobs, closed:closed,
      baseLabel: old.snapshotRun?new Date(old.snapshotRun).toLocaleDateString("en-US",{month:"short",day:"numeric"}):asof };
    _deltaData={key:cacheKey,data:data}; cb(data);
  }).catch(function(){ cb(null); });
}
function loadCommandDeltas(){
  var el=document.getElementById("delta-panel"); if(!el) return;
  el.innerHTML="<div class=\"sub\">Computing from nightly snapshots…</div>";
  computeDeltas(function(d){
    if(!d){ var e2=document.getElementById("delta-panel"); if(e2) e2.innerHTML=""; return; }
    var el2=document.getElementById("delta-panel"); if(!el2) return;
    function li(name,jno,txt,val){ return "<div class=\"q-row info\"><div class=\"q-job\">"+esc(name)+"<span class=\"q-jno\">"+esc(jno||"")+"</span></div><div class=\"q-detail\">"+txt+"</div><div class=\"q-val\">"+val+"</div></div>"; }
    var html="<div class=\"sub\">Since the "+d.baseLabel+" snapshot ("+d.oldN+" jobs &rarr; "+d.curN+"). Derived from the nightly trail, never hand-maintained.</div>"
      +"<div class=\"q-row info\"><div class=\"q-job\">Week totals</div><div class=\"q-detail\"><b>"+fmtCompact(d.billed)+"</b> billed · <b>"+fmtCompact(d.cost)+"</b> cost recorded"
      +(d.newJobs.length?(" · <b>"+d.newJobs.length+"</b> new job"+(d.newJobs.length===1?"":"s")):"")
      +(d.closed.length?(" · <b>"+d.closed.length+"</b> closed"):"")+"</div></div>"
      +(d.comparable?"":"<div class=\"q-row info\"><div class=\"q-job\">Coverage</div><div class=\"q-detail\">Baseline and current snapshots differ too much in coverage ("+d.oldN+" vs "+d.curN+" jobs) — probable partial ingestion, so jobs are NOT classified as new/closed. $ deltas above cover the "+d.shared+" jobs present in both.</div></div>");
    d.contractChanges.slice(0,5).forEach(function(x){ html+=li(x.j.description||"",x.j.jobNo,"contract "+(x.d>0?"+":"")+fmtCompact(x.d)+" this week",fmtCompact(x.j.currentContract)); });
    d.newJobs.slice(0,5).forEach(function(c){ html+=li(c.description||"",c.jobNo,"NEW in Foundation this week"+(c.pmName?(" · "+esc(c.pmName)):""),fmtCompact(c.currentContract||c.originalContract)); });
    d.closed.slice(0,5).forEach(function(o){ html+=li(o.description||"",o.jobNo,"closed in Foundation this week","—"); });
    d.movers.slice(0,3).forEach(function(x){ html+=li(x.j.description||"",x.j.jobNo,"cost recorded "+fmtCompact(x.d)+" this week",""); });
    el2.innerHTML=html;
  });
}

/* ===== Portfolio (Phase 2 — light operator table) ============================ */
var pfSort={col:"contract",dir:-1}, pfFilter="active", pfSearch="", _pfRows=[];
function attrEsc(s){ return esc(s).replace(/"/g,"&quot;"); }
function srcLink(url,label){ if(!url) return ""; return " <a class=\"srclink\" href=\""+attrEsc(url)+"\" target=\"_blank\" rel=\"noopener\" title=\"Open in "+attrEsc(label)+"\" onclick=\"event.stopPropagation()\">"+esc(label)+" &#8599;</a>"; }
function billingByJob(){ var m={}; if(foundationData&&foundationData.jobs){ activeAccountRows().forEach(function(r){ m[String(r.job)]=r; }); } return m; }
function confOf(j){
  var n=(j.revisedContract>0?1:0)+(j.foundation?1:0)+((j.budget&&j.budget.original>0)?1:0);
  return n>=3?{cls:"ok",txt:"full",rank:3}:n===2?{cls:"mid",txt:"partial",rank:2}:{cls:"low",txt:"low",rank:1};
}
function buildPfRows(){
  var bb=billingByJob();
  return ((activeData&&activeData.jobs)||[]).map(function(j){
    var sl=getStoplight(j,j);
    var b=bb[String(j.projectNumber)]||null;
    var conf=confOf(j);
    return { name:j.name||"", jno:j.projectNumber||"", pm:pmName(j)||"", client:j.client||"", stage:j.stage||"",
      stageConflict:stageConflict(j), procoreUrl:procoreUrl(j),
      // program + the RAW inputs a valid aggregate needs (a mean of percentages is not one)
      pgm:j.program||null, projCost:(j.budget&&j.budget.projectedCost>0)?j.budget.projectedCost:null,
      closeoutStage:!!CLOSEOUT_STAGES[j.stage],
      contract:j.contractValue||0, conflict:(j.flags||[]).some(function(f){return f.type==="contract";}),
      ctd:(j.costToDate!=null?j.costToDate:null), pct:j.pctComplete,
      mtd:projectedMargin(j), mtdSuspect:projMarginSuspect(j), cm:asBidMargin(j),
      needsInv:b?b.under:0, overdue:b?b.overdue:0,
      status:isCloseoutOnly(j)?"closeout":sl.color,
      reasons:sl.reasons.map(function(r){return r.text;}).join(" · "),
      conf:conf, confRank:conf.rank };
  });
}
/* ===== Greencroft rollup (usability program 3.1) =====================================
   Greencroft is one program carrying 30+ small unit jobs. Rendered as individual rows they
   dominate any leadership scan of the board purely by count, which is the complaint the
   brief raises. This is a PRESENTATION grouping and nothing else: every job keeps its
   identity, its numbers, its status and its route, and lives one disclosure click away.

   Aggregates are computed from RAW INPUTS, never by averaging percentages — a mean of
   per-job margins is not the program's margin. Projected margin is
   (sum contract - sum projected cost) / sum contract over the jobs that HAVE a projected
   cost, and the row says how many that is, because an aggregate over partial coverage that
   does not disclose its coverage is exactly the kind of confident-but-wrong number this
   program exists to remove.

   Mixed statuses are shown as a DISTRIBUTION ("2 red · 9 green"), never collapsed into one
   status that would be true of almost none of the constituent jobs. */
var gcOpen = false;
function toggleGcRollup(){ gcOpen = !gcOpen; updatePTable(); }
function gcAggregate(rows){
  var contract=0, ctd=0, needsInv=0, overdue=0, costed=0, projCost=0, contractOfCosted=0;
  var status={red:0,amber:0,green:0,gray:0,closeout:0};
  rows.forEach(function(r){
    contract+=r.contract||0; ctd+=r.ctd||0; needsInv+=r.needsInv||0; overdue+=r.overdue||0;
    if(r.projCost!=null && r.contract>0){ costed++; projCost+=r.projCost; contractOfCosted+=r.contract; }
    if(status[r.status]!=null) status[r.status]++;
  });
  return { n:rows.length, contract:contract, ctd:ctd, needsInv:needsInv, overdue:overdue,
    costed:costed, margin:(contractOfCosted>0)?((contractOfCosted-projCost)/contractOfCosted*100):null,
    pct:(contract>0)?(ctd/contract*100):null, status:status };
}
function gcStatusSummary(st){
  var order=[["red","red","m-r"],["amber","amber","m-a"],["closeout","closeout","m-m"],["green","on track","m-g"],["gray","pre-con","m-m"]];
  var bits=order.filter(function(x){ return st[x[0]]>0; })
    .map(function(x){ return "<span class=\""+x[2]+"\">"+st[x[0]]+" "+x[1]+"</span>"; });
  return bits.length?bits.join(" · "):"<span class=\"m-m\">—</span>";
}
function gcRollupRow(rows){
  var a=gcAggregate(rows);
  var bill="";
  if(a.needsInv>1000) bill="<span class=\"m-a\">inv "+fmtCompact(a.needsInv)+"</span>";
  if(a.overdue>0) bill+=(bill?" · ":"")+"<span class=\"m-r\">od "+fmtCompact(a.overdue)+"</span>";
  if(!bill) bill="<span class=\"m-m\">—</span>";
  var mCell=(a.margin!=null)
    ? ("<span class=\""+(a.margin>=10?"m-g":a.margin>=5?"m-a":"m-r")+"\">"+a.margin.toFixed(1)+"%</span>"
       + "<div class=\"cell-sub\">"+a.costed+" of "+a.n+" costed</div>")
    : "<span class=\"m-m\">—</span><div class=\"cell-sub\">no projected costs</div>";
  return "<tr class=\"gc-roll\" tabindex=\"0\" role=\"button\" aria-expanded=\""+(gcOpen?"true":"false")
    +"\" aria-label=\"Greencroft program, "+a.n+" jobs — expand\" onclick=\"toggleGcRollup()\""
    +" onkeydown=\"if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleGcRollup();}\">"
    +"<td><div class=\"jname\">"+(gcOpen?"▾":"▸")+" Greencroft program</div>"
    +"<div class=\"jno\">"+a.n+" unit jobs · presentation grouping only</div></td>"
    +"<td>"+esc(rows[0]&&rows[0].pm||"—")+"</td><td>—</td>"
    +"<td class=\"r\">"+fmtCompact(a.contract)+"</td>"
    +"<td class=\"r\">"+fmtCompact(a.ctd)+"</td>"
    +"<td class=\"r\">"+(a.pct!=null?Math.round(a.pct)+"%":"—")+"</td>"
    +"<td class=\"r\">"+mCell+"</td>"
    +"<td>"+bill+"</td>"
    +"<td>"+gcStatusSummary(a.status)+"</td>"
    +"<td><span class=\"conf mid\">rollup</span></td></tr>";
}
function pfSetSort(col){ if(pfSort.col===col) pfSort.dir=-pfSort.dir; else pfSort={col:col,dir:(col==="name"||col==="pm"||col==="stage"||col==="status")?1:-1}; updatePTable(); }
function pfSetFilter(k){ pfFilter=k; updatePTable(); }
function pfSearchInput(v){ pfSearch=v.toLowerCase(); updatePTable(); }
function statusPill(s,reasons){
  var t=attrEsc(reasons||"");
  if(s==="gray") return "<span class=\"pill dot\" style=\"background:#eceff4;color:#7c8699\" title=\""+t+"\">Pre-Con</span>";
  if(s==="closeout") return "<span class=\"pill dot\" style=\"background:rgba(20,160,140,.13);color:#0f9080\" title=\""+t+"\">Closeout</span>";
  var map={red:["r","Action"],amber:["a","Watch"],green:["g","On track"]};
  var m=map[s]||["g",s];
  return "<span class=\"pill "+m[0]+" dot\" title=\""+t+"\">"+m[1]+"</span>";
}
/* ONE row renderer, used by top-level rows AND by a rollup's expanded children, so a
   grouped job is never rendered by a second, subtly different code path (3.1). `child`
   only indents the name; every number, flag, status and route is identical. */
function pfRowHtml(r, child){
  var tb="";
    // Colour now grades PROJECTED margin at completion, so being early in a job no longer
    // reads as green. Negative projected margin is unambiguously red — unless the projected
    // cost is flagged suspect, in which case it is shown ungraded rather than alarmed.
    var mcls=(r.mtd==null||r.mtdSuspect)?"m-m":r.mtd>=10?"m-g":r.mtd>=5?"m-a":"m-r";
    var bill="";
    if(r.needsInv>1000) bill="<span class=\"m-a\">inv "+fmtCompact(r.needsInv)+"</span>";
    if(r.overdue>0) bill+=(bill?" · ":"")+"<span class=\"m-r\">od "+fmtCompact(r.overdue)+"</span>";
    if(!bill) bill="<span class=\"m-m\">—</span>";
    tb+="<tr class=\"ryc-row"+(child?" gc-child":"")+"\" tabindex=\"0\" role=\"button\" data-jno=\""+attrEsc(r.jno)+"\" aria-label=\"Open job detail: "+attrEsc(r.name)+"\">"
      +"<td><div class=\"jname\">"+(child?"<span class=\"gc-tick\">└</span> ":"")+esc(r.name)+"</div><div class=\"jno\">"+esc(r.jno)+(r.client?" · "+esc(r.client):"")+srcLink(r.procoreUrl,"Procore")+"</div></td>"
      +"<td>"+esc(r.pm||"—")+"</td><td>"+esc(r.stage||"—")+(r.stageConflict?" <span title=\"Procore stage says Pre-Construction but the job shows real cost activity — stage is stale; update it in Procore (see Data exceptions)\" style=\"color:#c07f1a;cursor:help\">⚑</span>":"")+"</td>"
      +"<td class=\"r\">"+fmtCompact(r.contract)+(r.conflict?" <span title=\"Procore and Foundation contracts diverge — see Data conflicts on the Command Center\" style=\"color:#c07f1a\">⚑</span>":"")+"</td>"
      +"<td class=\"r\">"+(r.ctd!=null?fmtCompact(r.ctd):"—")+"</td>"
      +"<td class=\"r\">"+(r.pct!=null?Math.round(r.pct)+"%":"—")+"</td>"
      +"<td class=\"r\">"+marginCell(r.mtd,r.mtdSuspect,r.cm)+"</td>"
      +"<td>"+bill+"</td>"
      +"<td>"+statusPill(r.status,r.reasons)+"</td>"
      +"<td><span class=\"conf "+r.conf.cls+"\">"+r.conf.txt+"</span></td>"
      +"</tr>";
  return tb;
}
function updatePTable(){
  var rows=_pfRows.slice();
  if(pfFilter==="active") rows=rows.filter(function(r){return !r.closeoutStage;});
  else if(pfFilter!=="all") rows=rows.filter(function(r){return r.status===pfFilter;});
  if(pfSearch) rows=rows.filter(function(r){ return (r.name+" "+r.jno+" "+r.pm+" "+r.client+" "+r.stage).toLowerCase().indexOf(pfSearch)>-1; });
  var c=pfSort.col, d=pfSort.dir;
  rows.sort(function(a,b){ var va=a[c], vb=b[c];
    if(typeof va==="string"||typeof vb==="string"){ va=(va==null?"":String(va)).toLowerCase(); vb=(vb==null?"":String(vb)).toLowerCase(); return va<vb?-d:va>vb?d:0; }
    va=(va==null?-Infinity:va); vb=(vb==null?-Infinity:vb); return (va-vb)*d; });
  /* Greencroft's unit jobs leave the flat list and become one expandable row (3.1). The
     grouping is by the program flag procore-refresh.js already stamps — never by name
     similarity, which the brief explicitly rules out as a way to invent groups. */
  var gcRows=rows.filter(function(r){ return r.pgm==="greencroft"; });
  var useRoll=gcRows.length>1 && pfFilter!=="all";
  if(useRoll) rows=rows.filter(function(r){ return r.pgm!=="greencroft"; });
  var tb="";
  if(useRoll){
    tb+=gcRollupRow(gcRows);
    if(gcOpen) gcRows.forEach(function(r){ tb+=pfRowHtml(r,true); });
  }
  rows.forEach(function(r){ tb+=pfRowHtml(r,false); });
  var tC=rows.reduce(function(s,r){return s+r.contract;},0), tD=rows.reduce(function(s,r){return s+(r.ctd||0);},0);
  var el=document.getElementById("ptbody"); if(el) el.innerHTML=tb;
  var ft=document.getElementById("ptfoot"); if(ft) ft.innerHTML="<tr><td>"+rows.length+" jobs</td><td></td><td></td><td class=\"r\">"+fmtCompact(tC)+"</td><td class=\"r\">"+fmtCompact(tD)+"</td><td></td><td></td><td></td><td></td><td></td></tr>";
  var pc=document.getElementById("pcount"); if(pc) pc.textContent=rows.length+" of "+_pfRows.length+" jobs shown";
  Array.prototype.forEach.call(document.querySelectorAll(".ptable th[data-col]"),function(th){
    th.innerHTML=th.getAttribute("data-lbl")+(th.getAttribute("data-col")===pfSort.col?" <span class=\"arr\">"+(pfSort.dir>0?"▲":"▼")+"</span>":"");
  });
  Array.prototype.forEach.call(document.querySelectorAll(".pfill"),function(bn){ bn.className="pfill"+(bn.getAttribute("data-f")===pfFilter?" on":""); });
}
function renderPortfolio(){
  _pfRows=buildPfRows();
  var pills=[["active","Active"],["all","All"],["red","Red"],["amber","Amber"],["closeout","Closeout"],["green","Green"],["gray","Pre-Con"]];
  var bar="<div class=\"pbar\">"
    +"<input id=\"psearch\" type=\"text\" placeholder=\"Search job, PM, client, stage…\" oninput=\"pfSearchInput(this.value)\" value=\""+attrEsc(pfSearch)+"\">"
    +pills.map(function(p){ return "<button class=\"pfill\" data-f=\""+p[0]+"\" onclick=\"pfSetFilter('"+p[0]+"')\">"+p[1]+"</button>"; }).join("")
    +"<span class=\"pcount\" id=\"pcount\"></span></div>";
  var cols=[["name","Job"],["pm","PM"],["stage","Stage"],["contract","Contract"],["ctd","Cost to date"],["pct","%"],["mtd","Proj. margin"],["needsInv","Billing"],["status","Status"],["confRank","Conf"]];
  var head="<tr>"+cols.map(function(cd){ var right=["contract","ctd","pct","mtd"].indexOf(cd[0])>-1?" class=\"r\"":""; return "<th"+right+" data-col=\""+cd[0]+"\" data-lbl=\""+cd[1]+"\" onclick=\"pfSetSort('"+cd[0]+"')\">"+cd[1]+"</th>"; }).join("")+"</tr>";
  /* Greencroft leftovers band (2026-07-21): since the program's promotion to the board,
     greencroftJobs() = only units active in Foundation but NOT active in Procore. The
     promoted units render as normal table rows above. */
  var gc=greencroftJobs().slice().sort(function(a,b){return ((b.currentContract||b.originalContract||0)-(a.currentContract||a.originalContract||0));});
  var gcSec="";
  if(gc.length){
    var gcC=0,gcCtd=0,gcInv=0;
    gc.forEach(function(f){ gcC+=(f.currentContract>0)?f.currentContract:(f.originalContract||0); gcCtd+=(f.totalCosts||0); gcInv+=(f.totalInvoiced||0); });
    var gcRows=gc.map(function(f){
      var c=(f.currentContract>0)?f.currentContract:(f.originalContract||0);
      var pos=(f.totalInvoiced||0)-(f.totalCosts||0);
      return "<tr class=\"static\"><td><div class=\"jname\">"+esc(f.description||"")+"</div><div class=\"jno\">"+esc(f.jobNo||"")+(f.pmName?" · "+esc(f.pmName):"")+"</div></td>"
        +"<td>"+esc(f.customerName||"—")+"</td>"
        +"<td class=\"r\">"+(c>0?fmtCompact(c):"<span class=\"m-m\">—</span>")+"</td>"
        +"<td class=\"r\">"+fmtCompact(f.totalCosts||0)+"</td><td class=\"r\">"+fmtCompact(f.totalInvoiced||0)+"</td>"
        +"<td class=\"r\">"+(pos>=0?("<span class=\"m-g\">+"+fmtCompact(pos)+"</span>"):("<span class=\"m-a\">"+fmtCompact(pos)+"</span>"))+"</td></tr>";
    }).join("");
    gcSec="<div style=\"margin-top:18px\"><div class=\"vhead\">Greencroft — off-board units</div>"
      +"<div class=\"vsub\">"+gc.length+" unit jobs active in Foundation but not active in Procore (the rest of the program lives in the main table above) · <b>"+fmtCompact(gcC)+"</b> contract · "+fmtCompact(gcCtd)+" cost to date · "+fmtCompact(gcInv)+" billed. Foundation-sourced — no stage/stoplight tracking. Lines also appear on the <b>Work on Hand</b> view.</div>"
      +"<details class=\"lgcy\"><summary>Per-unit detail — "+gc.length+" jobs</summary>"
      +"<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Job</th><th>Customer</th><th class=\"r\">Contract</th><th class=\"r\">Cost to date</th><th class=\"r\">Billed</th><th class=\"r\">Billed − cost</th></tr></thead><tbody>"+gcRows+"</tbody>"
      +"<tfoot><tr><td>"+gc.length+" jobs</td><td></td><td class=\"r\">"+fmtCompact(gcC)+"</td><td class=\"r\">"+fmtCompact(gcCtd)+"</td><td class=\"r\">"+fmtCompact(gcInv)+"</td><td class=\"r\">"+fmtCompact(gcInv-gcCtd)+"</td></tr></tfoot></table></div></details></div>";
  }
  /* WHAT THIS BOARD IS, AND IS NOT (program 0.2/5.1). The table below is the Procore-managed
     board. Construction Services (under $150k) and jobs the board does not carry are real
     company revenue and are stated here rather than left to be inferred from an absence. */
  var roll=companyRollup();
  var csJobs=[];
  Object.values((foundationData&&foundationData.jobs)||{}).forEach(function(f){
    if(f.jobStatus==="A" && segmentOf(f)==="construction_services") csJobs.push(f);
  });
  csJobs.sort(function(a2,b2){ return (jobContractValue(b2)||0)-(jobContractValue(a2)||0); });
  var csSec=csJobs.length
    ?("<details class=\"lgcy\" style=\"margin-top:14px\"><summary>Construction Services — "+csJobs.length
      +" active jobs under "+fmtCompact(CS_THRESHOLD)+" · "+fmtCompact(roll.services.contract)+" contract</summary>"
      +"<div class=\"vsub\" style=\"margin-top:6px\">Real company revenue that mostly never enters Procore, so it carries an honest, narrower metric set rather than manufactured zeros: contract, cost and billings from Foundation, and no stage, stoplight or projected margin — those come from field tracking these jobs do not have.</div>"
      +"<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Job</th><th>PM</th><th class=\"r\">Contract</th><th class=\"r\">Cost to date</th><th class=\"r\">Billed</th></tr></thead><tbody>"
      +csJobs.slice(0,25).map(function(f){
        return "<tr class=\"static\"><td><div class=\"jname\">"+esc(f.description||"")+"</div><div class=\"jno\">"+esc(f.jobNo||"")+"</div></td>"
          +"<td>"+esc(f.pmName||"—")+"</td><td class=\"r\">"+fmtCompact(jobContractValue(f)||0)+"</td>"
          +"<td class=\"r\">"+fmtCompact(f.totalCosts||0)+"</td><td class=\"r\">"+fmtCompact(f.totalInvoiced||0)+"</td></tr>";
      }).join("")+"</tbody></table></div>"
      +(csJobs.length>25?"<div class=\"vsub\" style=\"margin-top:6px\">Top 25 by contract shown.</div>":"")+"</details>")
    :"";
  var coverage="<div class=\"vsub\" style=\"margin-top:12px\"><b>Company coverage.</b> "+cohortNote(roll)
    +"<br>The table above is the Procore-managed board only. Construction Services and any job the board does not carry are broken out below — they are not missing, and they are not part of this table's totals.</div>";

  document.getElementById("view").innerHTML=bar
    +"<div class=\"ptable-wrap\"><table class=\"ptable\"><thead>"+head+"</thead><tbody id=\"ptbody\"></tbody><tfoot id=\"ptfoot\"></tfoot></table></div>"
    +coverage+csSec
    +"<div style=\"margin-top:10px;font-size:11.5px;color:#67718a\">Contract = Procore Revised Contract Amount (⚑ = diverges from Foundation) · Cost to date = Foundation actuals · Margin = margin to date on cost basis, \"bid\" = contracted margin · Billing = needs invoicing / overdue AR (Foundation) · Click a row (or press Enter) for the job detail drawer.</div>"
    +gcSec;
  var tbody=document.getElementById("ptbody");
  tbody.addEventListener("click",function(e){ var tr=e.target.closest("tr[data-jno]"); if(tr) openDrawer(tr.getAttribute("data-jno"),tr); });
  tbody.addEventListener("keydown",function(e){ if(e.key==="Enter"||e.key===" "){ var tr=e.target.closest("tr[data-jno]"); if(tr){ e.preventDefault(); openDrawer(tr.getAttribute("data-jno"),tr); } } });
  updatePTable();
}

/* ===== Billing & Cash (Phase 4 — light operator worklist) ==================== */
var blShowAll=false;
function agingBucket(d){ return d<=30?0:d<=90?1:d<=180?2:3; }
/* WORK ON HAND USES THIS ONE. It stays exactly as it was: wired, focusable and clickable,
   but WITHOUT the `ryc-row` affordance class — which is how the shared 1.1 row pattern
   reaches every other table in Command and none of Work on Hand. Protection by markup,
   not by a fork of the CSS. scripts/guard-woh-parity.js fails the build if that slips. */
function rowAttr(jno){ return jobByNo(jno)?(" data-jno=\""+attrEsc(jno)+"\" tabindex=\"0\" role=\"button\""):" class=\"static\""; }
/* Everything else opts IN to the affordance (resting left edge, hover, focus, chevron). */
function openAttr(jno){ var a=rowAttr(jno); return /data-jno/.test(a)?(" class=\"ryc-row\""+a):a; }
/* One wiring implementation, shared with the Desk (RYCTable, program 1.1). This replaced
   three near-identical copies here — drawer rows, subcontractor rows, completed-job rows —
   each of which had its own click/keydown pair to keep in step with the others. */
function hookDrawerRows(){
  Array.prototype.forEach.call(document.querySelectorAll(".view tbody"),function(tb){
    RYCTable.wire(tb,"data-jno",function(jno,tr){ openDrawer(jno,tr); });
  });
}
/* ===== Pay-app rule (usability program 4.1, tuned in 0.4) ===========================
   THE RULE WAS INVERTED BY EVIDENCE. This page used to lead with `deficit < 0` — under-billed
   jobs. Backtested against 17 weeks of Jason's actual weekly highlighting (1,277 job-weeks,
   430 highlighted rows) that rule recovers only 44%, and 98% of what it MISSES sits on the
   wrong side of zero: jobs carrying a median $36k SURPLUS that he flagged anyway. No
   materiality floor reaches those.

   What separates his rows is TIME. Highlighted jobs sit at a median 29 days since last
   invoice; un-highlighted at 15. RYC bills monthly, so a job not invoiced in about a month is
   due for a pay app whether or not it is currently over-billed.

   The upper bound matters as much as the lower: only 3% of his highlighted rows exceed 60 days
   (against 10% of un-highlighted), and validating an open-ended rule against live data flagged
   jobs 367 and 738 days stale. A job dormant for months is a different problem, so it gets its
   own list rather than padding this one.

       last invoice 21-60 days ago  AND  cost to date >= $1,000
       recall 91% · precision 80% · 5.8 false positives/week   (was 44% / 44% / 13.2)

   Full working: RYC/foundations/prototype/{BACKTEST_FINDINGS.md,tune_payapp.py}. */
var PAYAPP = { minAge: 21, maxAge: 60, minCost: 1000, recall: 91, precision: 80 };

/* Last invoice date per job, from the AR feed — which retains PAID invoices (670 of 906 rows
   are zero-balance, back to 2021), so this is genuinely "when did we last bill this job" and
   not "when did we last bill it and not get paid". Using open invoices only would make every
   promptly-paying job look stale. */
function lastInvoiceByJob(){
  var m={};
  ((arData&&arData.invoices)||[]).forEach(function(v){
    var k=String(v.jobNo||"").trim(); if(!k||!v.invoiceDate) return;
    if(!m[k]||v.invoiceDate>m[k]) m[k]=v.invoiceDate;
  });
  return m;
}
function daysSince(d){
  if(!d) return null;
  var t=RYCFormat.parse(d); if(isNaN(t.getTime())) return null;
  return Math.floor((Date.now()-t)/86400000);
}
/* Every active Foundation job, classified into exactly one billing state. One pass, one place,
   so the three lists below cannot disagree about which bucket a job is in. */
function billingStates(){
  var li=lastInvoiceByJob();
  var out={due:[],stale:[],never:[],recent:[]};
  activeAccountRows().forEach(function(r){
    var last=li[String(r.job)]||null;
    var age=daysSince(last);
    var row=Object.assign({},r,{lastInvoice:last,age:age,
      gc:/greencroft/i.test((r.name||"")+" "+((foundationData&&foundationData.jobs&&foundationData.jobs[r.job]||{}).customerName||""))});
    if(r.cost<PAYAPP.minCost){ out.recent.push(row); return; }
    if(age==null){ out.never.push(row); return; }
    if(age>PAYAPP.maxAge){ out.stale.push(row); return; }
    if(age>=PAYAPP.minAge){ out.due.push(row); return; }
    out.recent.push(row);
  });
  return out;
}
function payappWhy(r){
  var bits=[r.age+" days since last invoice"];
  if(r.under>1000) bits.push("earned-not-billed "+fmtCompact(r.under));
  else if(r.over>1000) bits.push("billed ahead "+fmtCompact(r.over));
  return bits.join(" · ");
}

function renderBilling(){
  var view=document.getElementById("view");
  var haveFnd=!!(foundationData&&foundationData.jobs), haveAr=!!(arData&&arData.invoices);
  if(!haveFnd&&!haveAr){ view.innerHTML="<div class=\"warn-banner\">⚠️ Foundation + AR feeds unavailable — billing cannot be computed. Figures show Unavailable, not $0.</div>"; return; }
  var warn=(!haveFnd||!haveAr)?("<div class=\"warn-banner\">⚠️ "+(!haveFnd?"Foundation":"AR")+" feed unavailable — affected figures show <b>Unavailable</b>, not $0.</div>"):"";

  var st=haveFnd?billingStates():{due:[],stale:[],never:[],recent:[]};
  var accts=haveFnd?activeAccountRows():[];

  /* ---------- 1. PAY APPLICATIONS TO PROCESS, grouped by PM ---------- */
  /* The Greencroft program is 17 of the 26 jobs that qualify today, all under one PM. Listed
     flat it buries the other eight, so it rolls up the same way it does on Portfolio (3.1):
     presentation only, every job still listed and still routable underneath. */
  function payappGroup(rows){
    var byPm={};
    rows.forEach(function(r){ (byPm[r.pm||"(no PM)"]=byPm[r.pm||"(no PM)"]||[]).push(r); });
    return Object.keys(byPm).sort(function(a,b){ return byPm[b].length-byPm[a].length; })
      .map(function(pm){ return {pm:pm,rows:byPm[pm].sort(function(a,b){ return b.age-a.age; })}; });
  }
  function payappRow(r,child){
    return "<tr"+openAttr(r.job)+(child?" class=\"gc-child\"":"")+">"
      +"<td><div class=\"jname\">"+(child?"<span class=\"gc-tick\">└</span> ":"")+esc(r.name)+"</div>"
      +"<div class=\"jno\">"+esc(String(r.job))+"</div></td>"
      +"<td class=\"r\">"+(r.lastInvoice?RYCFormat.date(r.lastInvoice):"<span class=\"m-m\">—</span>")+"</td>"
      +"<td class=\"r\"><b>"+r.age+"d</b></td>"
      +"<td class=\"r\">"+(r.under>0?("<span class=\"m-a\">"+fmtCompact(r.under)+"</span>"):(r.over>0?("<span class=\"m-g\">+"+fmtCompact(r.over)+"</span>"):"<span class=\"m-m\">—</span>"))+(r.exact?"":"<div class=\"cell-sub\">bid-est</div>")+"</td>"
      +"<td class=\"r\">"+fmtCompact(r.contract)+"</td>"
      +"<td style=\"white-space:normal\">"+esc(payappWhy(r))+"</td></tr>";
  }
  var groups=payappGroup(st.due);
  var dueHtml="";
  groups.forEach(function(g){
    var gc=g.rows.filter(function(r){return r.gc;}), rest=g.rows.filter(function(r){return !r.gc;});
    dueHtml+="<tr><td colspan=\"6\" style=\"padding:14px 0 4px\"><b>"+esc(g.pm)+"</b> "
      +"<span class=\"m-m\">· "+g.rows.length+" job"+(g.rows.length===1?"":"s")+"</span></td></tr>";
    rest.forEach(function(r){ dueHtml+=payappRow(r,false); });
    if(gc.length>1){
      var c=gc.reduce(function(s2,r){return s2+(r.contract||0);},0);
      var u=gc.reduce(function(s2,r){return s2+(r.under||0);},0);
      dueHtml+="<tr class=\"gc-roll\" tabindex=\"0\" role=\"button\" aria-expanded=\""+(gcOpen?"true":"false")
        +"\" onclick=\"toggleGcRollup()\" onkeydown=\"if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleGcRollup();}\">"
        +"<td><div class=\"jname\">"+(gcOpen?"▾":"▸")+" Greencroft program</div><div class=\"jno\">"+gc.length+" unit jobs due</div></td>"
        +"<td class=\"r\"><span class=\"m-m\">—</span></td>"
        +"<td class=\"r\"><b>"+Math.round(gc.reduce(function(s2,r){return s2+r.age;},0)/gc.length)+"d</b><div class=\"cell-sub\">avg</div></td>"
        +"<td class=\"r\">"+(u>0?("<span class=\"m-a\">"+fmtCompact(u)+"</span>"):"<span class=\"m-m\">—</span>")+"</td>"
        +"<td class=\"r\">"+fmtCompact(c)+"</td>"
        +"<td style=\"white-space:normal\">All within the "+PAYAPP.minAge+"–"+PAYAPP.maxAge+" day billing window</td></tr>";
      if(gcOpen) gc.forEach(function(r){ dueHtml+=payappRow(r,true); });
    } else { gc.forEach(function(r){ dueHtml+=payappRow(r,false); }); }
  });
  var dueTable=st.due.length
    ?("<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Job</th><th class=\"r\">Last invoice</th><th class=\"r\">Age</th><th class=\"r\">Earned − billed</th><th class=\"r\">Contract</th><th>Why it appears</th></tr></thead><tbody>"+dueHtml+"</tbody></table></div>")
    :"<div class=\"vsub\">Nothing is inside the billing window right now.</div>";

  /* ---------- 2. OVERDUE CUSTOMER PAYMENTS, grouped by responsible PM ---------- */
  var fj=(foundationData&&foundationData.jobs)||{};
  var over=haveAr?arRows("overdue","active"):[];
  var byPm={};
  over.forEach(function(v){
    var j=fj[String(v.jobNo||"")]||{};
    var pm=j.pmName||"(no PM)";
    (byPm[pm]=byPm[pm]||[]).push(Object.assign({},v,{jobName:v.jobName||j.description||""}));
  });
  var pmOrder=Object.keys(byPm).sort(function(a,b){
    var sa=byPm[a].reduce(function(s2,v){return s2+(v.openBalance||0);},0);
    var sb=byPm[b].reduce(function(s2,v){return s2+(v.openBalance||0);},0);
    return sb-sa;
  });
  var arHtml="";
  pmOrder.forEach(function(pm){
    var vs=byPm[pm].sort(function(a,b){ return (b.daysOverdue||0)-(a.daysOverdue||0); });
    var tot=vs.reduce(function(s2,v){return s2+(v.openBalance||0);},0);
    arHtml+="<tr><td colspan=\"5\" style=\"padding:14px 0 4px\"><b>"+esc(pm)+"</b> <span class=\"m-m\">· "
      +vs.length+" invoice"+(vs.length===1?"":"s")+" · <b>"+fmtCompact(tot)+"</b> exposure</span></td></tr>";
    vs.forEach(function(v){
      arHtml+="<tr"+openAttr(String(v.jobNo||""))+">"
        +"<td><div class=\"jname\">"+esc(v.jobName)+"</div><div class=\"jno\">"+esc(String(v.jobNo||""))+(v.customer?" · "+esc(v.customer):"")+"</div></td>"
        +"<td>"+esc(v.payApp?("Pay app "+v.payApp):("Inv "+(v.invoiceNo||"")))+"</td>"
        +"<td class=\"r\">"+RYCFormat.date(v.dueDate)+"</td>"
        +"<td class=\"r\"><span class=\""+((v.daysOverdue||0)>90?"m-r":"m-a")+"\">"+(v.daysOverdue||0)+"d</span></td>"
        +"<td class=\"r\"><b>"+fmtCompact(v.openBalance)+"</b></td></tr>";
    });
  });
  var arTable=over.length
    ?("<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Job</th><th>Invoice</th><th class=\"r\">Due</th><th class=\"r\">Overdue</th><th class=\"r\">Open balance</th></tr></thead><tbody>"+arHtml+"</tbody></table></div>")
    :"<div class=\"vsub\">No overdue AR on active jobs.</div>";

  /* ---------- exceptions: two states that are NOT pay apps ---------- */
  function miniTable(rows,ageLabel){
    return "<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Job</th><th>PM</th><th class=\"r\">"+ageLabel+"</th><th class=\"r\">Cost to date</th><th class=\"r\">Billed</th></tr></thead><tbody>"
      +rows.sort(function(a,b){ return (b.cost||0)-(a.cost||0); }).map(function(r){
        return "<tr"+openAttr(r.job)+"><td><div class=\"jname\">"+esc(r.name)+"</div><div class=\"jno\">"+esc(String(r.job))+"</div></td>"
          +"<td>"+esc(r.pm)+"</td>"
          +"<td class=\"r\">"+(r.age!=null?r.age+"d":"<span class=\"m-m\">never</span>")+"</td>"
          +"<td class=\"r\">"+fmtCompact(r.cost)+"</td><td class=\"r\">"+fmtCompact(r.invoiced)+"</td></tr>";
      }).join("")+"</tbody></table></div>";
  }
  var excSec="";
  if(st.stale.length) excSec+="<details class=\"lgcy\"><summary>Not billed in over "+PAYAPP.maxAge+" days — "+st.stale.length+" job"+(st.stale.length===1?"":"s")+" (a stalled job, not a pay app)</summary>"
    +"<div class=\"vsub\" style=\"margin-top:6px\">Outside the billing window entirely. Jason's weekly list almost never includes these (3% of his flagged rows), so they are a separate question: is the job stalled, retainage-only, or ready to close?</div>"
    +miniTable(st.stale,"Since last invoice")+"</details>";
  if(st.never.length) excSec+="<details class=\"lgcy\"><summary>Cost booked but never invoiced — "+st.never.length+" job"+(st.never.length===1?"":"s")+"</summary>"
    +"<div class=\"vsub\" style=\"margin-top:6px\">A distinct state, not a stale one — there is no last-invoice date to age from, so an age rule would either miss them or misreport them.</div>"
    +miniTable(st.never,"Since last invoice")+"</details>";

  /* ---------- 3. TOTALS AND AGING — after the actionable lists, per the brief ---------- */
  var needsInv=accts.reduce(function(s2,r){return s2+r.under;},0);
  var retainage=accts.reduce(function(s2,r){return s2+(r.retainage||0);},0);
  var buckets=[0,0,0,0];
  over.forEach(function(v){ buckets[agingBucket(v.daysOverdue||0)]+=(v.openBalance||0); });
  var current=buckets[0]+buckets[1], aged=buckets[2]+buckets[3];
  function kpi(l,v,s2,cls){ return "<div class=\"kpi\"><div class=\"kl\">"+l+"</div><div class=\"kv "+(cls||"")+"\">"+v+"</div><div class=\"ks\">"+(s2||"")+"</div></div>"; }
  var strip="<div class=\"kpi-strip k4\">"
    +kpi("Pay apps to process",String(st.due.length),"in the "+PAYAPP.minAge+"–"+PAYAPP.maxAge+" day window",st.due.length?"warn":"")
    +kpi("Overdue AR (active)",haveAr?fmtCompact(current+aged):"Unavailable",haveAr?(fmtCompact(current)+" under 90d · "+fmtCompact(aged)+" aged"):"AR feed down",(current+aged)>0?"bad":"")
    +kpi("Earned, not billed",haveFnd?fmtCompact(needsInv):"Unavailable","across all active jobs","")
    +kpi("Retainage held",haveFnd?fmtCompact(retainage):"Unavailable","active jobs","")
    +"</div>";
  var agingRows=["1–30d","31–90d","91–180d","180d+"].map(function(l,i){
    return "<tr class=\"static\"><td>"+l+"</td><td class=\"r\">"+fmtCompact(buckets[i])+"</td></tr>";
  }).join("");
  var agingTable="<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Age</th><th class=\"r\">Open balance</th></tr></thead><tbody>"+agingRows
    +"</tbody><tfoot><tr><td>Total</td><td class=\"r\">"+fmtCompact(current+aged)+"</td></tr></tfoot></table></div>";

  var legacy=haveAr?arRows("overdue","legacy"):[];
  var legacyTotal=legacy.reduce(function(s2,v){return s2+(v.openBalance||0);},0);
  var lgByJob={};
  legacy.forEach(function(v){ var k=String(v.jobNo||""); if(!lgByJob[k]) lgByJob[k]={jno:k,name:v.jobName||"",total:0,oldest:0}; lgByJob[k].total+=(v.openBalance||0); if((v.daysOverdue||0)>lgByJob[k].oldest) lgByJob[k].oldest=v.daysOverdue||0; });
  var legacySec=legacy.length
    ?("<details class=\"lgcy\"><summary>Legacy / closed-job overdue AR — "+fmtCompact(legacyTotal)+" across "+legacy.length+" invoices (kept off the active view)</summary>"
      +"<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Job</th><th class=\"r\">Overdue</th><th class=\"r\">Oldest</th></tr></thead><tbody>"
      +Object.values(lgByJob).sort(function(a,b){return b.total-a.total;}).slice(0,15).map(function(r){
        return "<tr class=\"static\"><td><div class=\"jname\">"+esc(r.name)+"</div><div class=\"jno\">"+esc(r.jno)+"</div></td><td class=\"r\">"+fmtCompact(r.total)+"</td><td class=\"r\">"+r.oldest+"d</td></tr>";
      }).join("")+"</tbody></table></div></details>")
    :"";

  /* The rule is PROVISIONAL and says so on the page. Decision #13: it runs beside Jason's email
     until RYC agrees with it; presenting a 91%-recall heuristic as authoritative is the exact
     failure the brief warns about. */
  var provisional="<div class=\"warn-banner\" style=\"background:#fdf6ea;border-color:#e8d3ad;color:#7a5a1e\">"
    +"<b>Provisional rule — running alongside Jason's Thursday email, not replacing it.</b> "
    +"A job appears when its last invoice was "+PAYAPP.minAge+"–"+PAYAPP.maxAge+" days ago and it has cost booked. "
    +"Backtested against 17 weeks of his actual highlighting: <b>"+PAYAPP.recall+"% recall, "+PAYAPP.precision+"% precision</b>, "
    +"~6 false positives a week. It will miss some and add some — every row says why it is here.</div>";

  view.innerHTML=warn+provisional
    +"<div class=\"vhead\">Pay applications to process</div>"
    +"<div class=\"vsub\">Grouped by PM, oldest first. RYC bills monthly, so the question is when a job was last invoiced — not whether it is currently under-billed. <b>Earned − billed</b> is shown for context and is not what puts a job on this list.</div>"
    +dueTable+excSec
    +"<div class=\"vhead\">Overdue customer payments</div>"
    +"<div class=\"vsub\">Grouped by the PM responsible for the job, largest exposure first, oldest invoice first within each.</div>"
    +arTable
    +"<div class=\"vhead\">Totals</div>"
    +"<div class=\"vsub\">Summary follows the work, rather than leading with a number nobody can act on.</div>"
    +strip+agingTable+legacySec;
  hookDrawerRows();
}

/* cross-source reconciliation exceptions — used by Margin & Risk and Data Trust */
/* Curated-client vs Foundation-customer guard (2026-07-08 — born from the Walt Disney miss:
   labeled "School City of Mishawaka" for 4 months while Foundation billed PHM). Fires only when
   the two names share no meaningful token AND neither contains the other. Known-legit divergences
   (BOT payer-of-record, SPE billing entities) are allow-listed. Dormant until foundation-refresh
   lands customer_name (DDL pending). */
var CLIENT_DIVERGENCE_OK={"26X012":1,"2513CO04":1}; // Bristol (JBK Investments = BOT payer) · Helix (Orchard on Wallen SPE)
var CLIENT_STOPWORDS={of:1,the:1,a:1,and:1,inc:1,llc:1,corp:1,co:1,city:1,town:1,county:1,village:1,board:1,public:1,works:1,dept:1,department:1,school:1,schools:1,corporation:1,group:1,company:1,indiana:1,michigan:1};
function clientMismatch(j){
  var f=j.foundation;
  if(!f||!f.customerName||!j.client||CLIENT_DIVERGENCE_OK[j.projectNumber]) return false;
  var norm=function(s){return String(s).toLowerCase().replace(/[^a-z0-9]/g,"");};
  var a=norm(j.client), b=norm(f.customerName);
  if(!a||!b||a.indexOf(b)>-1||b.indexOf(a)>-1) return false;
  var toks=function(s){return String(s).toLowerCase().split(/[^a-z0-9]+/).filter(function(t){return t.length>1&&!CLIENT_STOPWORDS[t];});};
  var ta=toks(j.client), tb={}; toks(f.customerName).forEach(function(t){tb[t]=1;});
  return !ta.some(function(t){return tb[t]||Object.keys(tb).some(function(x){return x.indexOf(t)===0||t.indexOf(x)===0;});});
}
function buildExceptions(jobs){
  var exc=[];
  jobs.forEach(function(j){
    var pl=srcLink(procoreUrl(j),"Procore");
    if(clientMismatch(j)) exc.push({jno:j.projectNumber,name:j.name,issue:"Client label mismatch",detail:"Board shows client “"+esc(j.client)+"” but Foundation bills “"+esc(j.foundation.customerName)+"” — verify the CURATED map in procore-refresh.js (or allow-list if the divergence is legit, e.g. BOT payer / SPE)"});
    (j.flags||[]).forEach(function(f){
      if(f.type==="contract") exc.push({jno:j.projectNumber,name:j.name,issue:"Contract conflict",detail:"Board shows "+fmtCompact(j.contractValue)+" vs "+esc(f.text)+" — reconcile CO posting between systems"+pl});
      if(f.type==="closed") exc.push({jno:j.projectNumber,name:j.name,issue:"Lifecycle mismatch",detail:"Foundation shows this job CLOSED; still active on the Procore board"+pl});
    });
    if(stageConflict(j)) exc.push({jno:j.projectNumber,name:j.name,issue:"Stale stage in Procore",detail:"Stage says Pre-Construction but the job is "+Math.round(j.pctComplete)+"% cost-complete"+(j.costToDate!=null?" ("+fmtCompact(j.costToDate)+" spent)":"")+" — update the stage in Procore"+pl});
    if(projMarginSuspect(j)&&j.budget&&j.budget.projectedCost>0){
      var pb=j.budget, pdet;
      if(pb.projCostSuspect) pdet="ERP projected cost "+fmtCompact(pb.projectedCost)+" exceeds revised budget "+fmtCompact(pb.revised)+" by >30% — sub costs may be double-booked in Direct";
      else { var pctd=(j.costToDate!=null)?j.costToDate:pb.direct;
        pdet=(pctd>0&&pb.projectedCost<pctd*0.98)
          ?("ERP projected cost "+fmtCompact(pb.projectedCost)+" is BELOW cost already recorded ("+fmtCompact(pctd)+") — projection invalid on its face")
          :("ERP projected cost "+fmtCompact(pb.projectedCost)+" is "+(pb.revised>0?Math.round(pb.projectedCost/pb.revised*100)+"% of":"below")+" revised budget "+fmtCompact(pb.revised)+" — likely incomplete buyout commitments, not real margin"); }
      exc.push({jno:j.projectNumber,name:j.name,issue:"Projected cost ⚑ verify",detail:pdet+" — margin shown ungraded until verified"+pl});
    }
    if(j.budget&&j.budget.projectedCost==null&&j.stage!=="Pre-Construction") exc.push({jno:j.projectNumber,name:j.name,issue:"Missing projected cost",detail:"No ERP-view Projected Costs on an in-flight job"+pl});
    if(!j.foundation&&j.stage!=="Pre-Construction") exc.push({jno:j.projectNumber,name:j.name,issue:"No Foundation match",detail:"Financials are Procore-only — unverified by accounting"});
  });
  return exc;
}

/* ===== Margin grading — ONE cell, and never colour alone (program 1.3) ==================
   Contract §3: "Color is always accompanied by text or iconography — no color-only semantics."
   The projected-margin cell was the one place left where the GRADE was carried purely by
   colour: 3.2% rendered red and 12% green, identical to a colourblind reader or anyone
   printing in greyscale.

   The fix uses the sub-line the cell already has rather than inventing a glyph vocabulary —
   "as-bid 10.1% · below target" is unambiguous, reads aloud correctly, and costs no space.
   Healthy stays SILENT, per the same section: only the states that want attention say so.

   Severity and confidence remain separate axes. An unverified projection is never graded at
   all — it shows ⚑ and says why, rather than being coloured as though it were known. */
function marginGrade(pct,suspect){
  if(suspect) return {cls:"m-m",word:"projection unverified"};
  if(pct==null) return {cls:"m-m",word:null};
  if(pct<5)  return {cls:"m-r",word:"below target"};
  if(pct<10) return {cls:"m-a",word:"watch"};
  return {cls:"m-g",word:null};                       // healthy is silent
}
function marginCell(pct,suspect,asBid){
  var g=marginGrade(pct,suspect);
  var sub=[];
  if(asBid!=null) sub.push("as-bid "+asBid.toFixed(1)+"%");
  if(g.word) sub.push(g.word);
  var val=suspect?"⚑":(pct!=null?pct.toFixed(1)+"%":"—");
  return "<span class=\""+g.cls+"\""+(g.word?(" title=\""+attrEsc(g.word)+"\""):"")+">"+val+"</span>"
    +(sub.length?"<div class=\"cell-sub\">"+esc(sub.join(" · "))+"</div>":"");
}

/* ===== Margin & Risk (Phase 4 — light operator view) ========================= */
var mgSort="pts";
function mgSetSort(k){ mgSort=k; renderView(); }

function renderMargin(){
  var view=document.getElementById("view");
  var jobs=getActiveJobs();
  var haveFnd=!!(foundationData&&foundationData.jobs);
  var warn=(!activeData||!activeData.jobs)?"<div class=\"warn-banner\">⚠️ Procore feed unavailable.</div>":(!haveFnd?"<div class=\"warn-banner\">⚠️ Foundation feed unavailable — gain/fade falls back to Procore-only figures.</div>":"");

  /* TWO POPULATIONS, NEVER MIXED (3.3: "distinguish forecast risk from data-quality
     uncertainty"). A graded row has a trusted ERP projected cost. A recon row is reconstructed
     from budget growth — a SCENARIO, not a forecast. They used to sit in one table separated
     only by a muted tag, which reads as one ranked list where a third of the rows are guesses. */
  var all=gainFadeRows();
  var graded=all.filter(function(r){return r.src==="erp";});
  var ungraded=all.filter(function(r){return r.src!=="erp";});
  var fading=graded.filter(function(r){return r.gfPts<=-GF_MOVE_PTS;});
  var gaining=graded.filter(function(r){return r.gfPts>=GF_MOVE_PTS;});
  var fadeDollars=fading.reduce(function(s2,r){return s2+r.gfDollars;},0);

  /* Portfolio margin now leads with the COMPARISON the page is about. Both sides are computed
     over the SAME cohort — the graded rows — rather than pairing a projected figure from one
     population with an as-bid figure from another, which would make the delta meaningless. */
  var wC=0,wProj=0,wBid=0;
  graded.forEach(function(r){
    var j=jobByNo(r.job); var c=(j&&j.contractValue)||0; if(!(c>0)) return;
    wC+=c; wProj+=c*r.curMargin; wBid+=c*r.asbidMargin;
  });
  var projPct=wC>0?wProj/wC:null, bidPct=wC>0?wBid/wC:null;
  var deltaPts=(projPct!=null&&bidPct!=null)?(projPct-bidPct):null;

  /* buyout rollup */
  var bo=jobs.filter(function(j){return j.commitments&&j.budget&&((j.budget.revised>0)||(j.budget.original>0));})
    .map(function(j){ var cb=j.budget.revised>0?j.budget.revised:j.budget.original;
      return {j:j,jno:j.projectNumber||"",name:j.name||"",pm:pmName(j)||"(no PM)",pct:j.pctComplete,budget:cb,
        committed:j.commitments.committedTotal,pending:j.commitments.pendingTotal||0,
        uncommitted:cb-j.commitments.committedTotal,cov:cb>0?(j.commitments.committedTotal/cb*100):null}; });
  var boBudget=bo.reduce(function(s2,r){return s2+r.budget;},0);
  var boCommitted=bo.reduce(function(s2,r){return s2+r.committed;},0);
  var boCov=boBudget>0?(boCommitted/boBudget*100):null;

  var exc=buildExceptions(jobs);

  function kpi(l,v,s2,cls){ return "<div class=\"kpi\"><div class=\"kl\">"+l+"</div><div class=\"kv "+(cls||"")+"\">"+v+"</div><div class=\"ks\">"+(s2||"")+"</div></div>"; }
  var strip="<div class=\"kpi-strip k4\">"
    +kpi("Projected margin",projPct!=null?projPct.toFixed(1)+"%":"—",
         bidPct!=null?("as-bid "+bidPct.toFixed(1)+"% · "+(deltaPts>=0?"+":"")+deltaPts.toFixed(1)+" pts"):"no graded jobs",
         (deltaPts!=null&&deltaPts<=-GF_MOVE_PTS)?"bad":((projPct!=null&&projPct<8)?"warn":""))
    +kpi("Net movement vs as-bid",fmtCompact(fadeDollars+gaining.reduce(function(s2,r){return s2+r.gfDollars;},0)),
         fading.length+" fading · "+gaining.length+" gaining",fadeDollars<0?"bad":"")
    +kpi("Worst fade",fading.length?fmtCompact(fading.slice().sort(function(a,b){return a.gfDollars-b.gfDollars;})[0].gfDollars):"—",
         fading.length?esc(fading.slice().sort(function(a,b){return a.gfPts-b.gfPts;})[0].name.slice(0,28)):"nothing fading",fading.length?"bad":"")
    +kpi("Buyout coverage",boCov!=null?boCov.toFixed(0)+"%":"—",fmtCompact(boBudget-boCommitted)+" still to buy","")
    +"</div>";

  /* RANK BY DOLLARS *AND* POINTS (3.3). A 0.8-point slide on an $18M job and a 9-point slide
     on a $200k job are both real and neither dominates the other, so the ranking is a choice
     the reader makes rather than one the page makes for them. */
  function sortRows(rows){
    return rows.slice().sort(function(a,b){
      return mgSort==="dollars" ? (a.gfDollars-b.gfDollars) : (a.gfPts-b.gfPts);
    });
  }
  function gfRow(r,child){
    return "<tr"+openAttr(r.job)+(child?" class=\"gc-child\"":"")+">"
      +"<td><div class=\"jname\">"+(child?"<span class=\"gc-tick\">└</span> ":"")+esc(r.name)+"</div><div class=\"jno\">"+esc(r.job)+" · "+esc(r.pm)+"</div></td>"
      +"<td class=\"r\">"+(r.pct!=null?Math.round(r.pct)+"%":"—")+"</td>"
      +"<td class=\"r\">"+r.asbidMargin.toFixed(1)+"%</td>"
      +"<td class=\"r\">"+marginCell(r.curMargin,false,null)+"</td>"
      +"<td class=\"r\"><span class=\""+(r.gfPts<=-GF_MOVE_PTS?"m-r":r.gfPts>=GF_MOVE_PTS?"m-g":"m-m")+"\">"+(r.gfPts>=0?"+":"")+r.gfPts.toFixed(1)+"</span></td>"
      +"<td class=\"r\"><span class=\""+(r.gfDollars<0?"m-r":r.gfDollars>0?"m-g":"m-m")+"\">"+fmtCompact(r.gfDollars)+"</span></td>"
      +"<td>"+(r.burnRisk?"<span class=\"m-r\">⚠ cost burn</span>":"<span class=\"m-m\">—</span>")+"</td></tr>";
  }
  /* Greencroft rolls up here too (3.1 across all three approved surfaces). */
  var gcSet={}; greencroftBoardJobs().forEach(function(j){ gcSet[String(j.projectNumber)]=1; });
  var gcRows=graded.filter(function(r){return gcSet[String(r.job)];});
  var mainRows=sortRows(graded.filter(function(r){return !gcSet[String(r.job)];}));
  var gfHtml=mainRows.map(function(r){return gfRow(r,false);}).join("");
  if(gcRows.length>1){
    var gd=gcRows.reduce(function(s2,r){return s2+r.gfDollars;},0);
    var gp=gcRows.reduce(function(s2,r){return s2+r.gfPts;},0)/gcRows.length;
    gfHtml+="<tr class=\"gc-roll\" tabindex=\"0\" role=\"button\" aria-expanded=\""+(gcOpen?"true":"false")
      +"\" onclick=\"toggleGcRollup()\" onkeydown=\"if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleGcRollup();}\">"
      +"<td><div class=\"jname\">"+(gcOpen?"▾":"▸")+" Greencroft program</div><div class=\"jno\">"+gcRows.length+" unit jobs</div></td>"
      +"<td class=\"r\"><span class=\"m-m\">—</span></td><td class=\"r\"><span class=\"m-m\">—</span></td><td class=\"r\"><span class=\"m-m\">—</span></td>"
      +"<td class=\"r\"><span class=\"m-m\">"+(gp>=0?"+":"")+gp.toFixed(1)+"</span><div class=\"cell-sub\">mean</div></td>"
      +"<td class=\"r\"><span class=\""+(gd<0?"m-r":"m-g")+"\">"+fmtCompact(gd)+"</span><div class=\"cell-sub\">summed</div></td>"
      +"<td><span class=\"m-m\">—</span></td></tr>";
    if(gcOpen) sortRows(gcRows).forEach(function(r){ gfHtml+=gfRow(r,true); });
  } else { gcRows.forEach(function(r){ gfHtml+=gfRow(r,false); }); }

  var sortBtn=function(k,l){ return "<button class=\"pfill"+(mgSort===k?" on":"")+"\" onclick=\"mgSetSort('"+k+"')\">"+l+"</button>"; };
  var gfTable=graded.length
    ?("<div class=\"pbar\"><span class=\"note\" style=\"margin-right:6px\">Rank by</span>"+sortBtn("pts","Margin points")+sortBtn("dollars","Dollars")+"</div>"
      +"<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Job</th><th class=\"r\">%</th><th class=\"r\">As-bid</th><th class=\"r\">Current</th><th class=\"r\">Δ pts</th><th class=\"r\">Δ $</th><th>Cost burn</th></tr></thead><tbody>"+gfHtml+"</tbody></table></div>")
    :"<div class=\"vsub\">No jobs have a trusted projected cost yet, so nothing can be graded.</div>";

  /* The ungraded population, kept OUT of the ranked list and labelled as what it is. */
  var unHtml=sortRows(ungraded).map(function(r){
    return "<tr"+openAttr(r.job)+"><td><div class=\"jname\">"+esc(r.name)+"</div><div class=\"jno\">"+esc(r.job)+" · "+esc(r.pm)+"</div></td>"
      +"<td class=\"r\">"+(r.pct!=null?Math.round(r.pct)+"%":"—")+"</td>"
      +"<td class=\"r\">"+r.asbidMargin.toFixed(1)+"%</td>"
      +"<td class=\"r\"><span class=\"m-m\">≈"+r.curMargin.toFixed(1)+"%</span></td>"
      +"<td class=\"r\"><span class=\"m-m\">"+(r.gfPts>=0?"+":"")+r.gfPts.toFixed(1)+"</span></td>"
      +"<td class=\"r\"><span class=\"m-m\">"+fmtCompact(r.gfDollars)+"</span></td></tr>";
  }).join("");
  var unSec=ungraded.length
    ?("<details class=\"lgcy\"><summary>"+ungraded.length+" job"+(ungraded.length===1?"":"s")+" cannot be graded — reconstructed from budget growth</summary>"
      +"<div class=\"vsub\" style=\"margin-top:6px\">These have no trusted ERP projected cost, so the movement below is a <b>scenario</b>, not a forecast. It is kept out of the ranked list and out of every total on this page — an uncertain number that sits in a ranking gets read as a certain one. Fixing the projected cost in Procore promotes a job into the graded list.</div>"
      +"<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Job</th><th class=\"r\">%</th><th class=\"r\">As-bid</th><th class=\"r\">≈ Current</th><th class=\"r\">≈ Δ pts</th><th class=\"r\">≈ Δ $</th></tr></thead><tbody>"+unHtml+"</tbody></table></div></details>")
    :"";

  /* buyout table (unchanged in substance) */
  var boHtml=bo.slice().sort(function(a,b){return b.uncommitted-a.uncommitted;}).map(function(r){
    return "<tr"+openAttr(r.jno)+"><td><div class=\"jname\">"+esc(r.name)+"</div><div class=\"jno\">"+esc(r.jno)+" · "+esc(r.pm)+"</div></td>"
      +"<td class=\"r\">"+(r.pct!=null?Math.round(r.pct)+"%":"—")+"</td>"
      +"<td class=\"r\">"+fmtCompact(r.budget)+"</td><td class=\"r\">"+fmtCompact(r.committed)+"</td>"
      +"<td class=\"r\">"+(r.pending>0?fmtCompact(r.pending):"<span class=\"m-m\">—</span>")+"</td>"
      +"<td class=\"r\"><b>"+fmtCompact(r.uncommitted)+"</b></td>"
      +"<td class=\"r\">"+(r.cov!=null?("<span class=\""+(r.cov>=90?"m-g":r.cov>=70?"m-a":"m-r")+"\">"+r.cov.toFixed(0)+"%</span>"):"—")+"</td></tr>";
  }).join("");
  var boFoot="<tr><td>"+bo.length+" jobs</td><td></td><td class=\"r\">"+fmtCompact(boBudget)+"</td><td class=\"r\">"+fmtCompact(boCommitted)+"</td><td></td><td class=\"r\">"+fmtCompact(boBudget-boCommitted)+"</td><td class=\"r\">"+(boCov!=null?boCov.toFixed(0)+"%":"—")+"</td></tr>";
  var boTable=bo.length
    ?("<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Job</th><th class=\"r\">%</th><th class=\"r\">Cost budget</th><th class=\"r\">Committed</th><th class=\"r\">In flight</th><th class=\"r\">Uncommitted</th><th class=\"r\">Coverage</th></tr></thead><tbody>"+boHtml+"</tbody><tfoot>"+boFoot+"</tfoot></table></div>")
    :"<div class=\"vsub\">No commitment data yet — populates with the nightly Procore refresh.</div>";

  /* EXCEPTIONS: a short actionable list, not a wall (3.3). Grouped by what is wrong, with the
     jobs behind a disclosure and the per-field detail on the job page where it belongs. */
  var byIssue={};
  exc.forEach(function(e){ (byIssue[e.issue]=byIssue[e.issue]||[]).push(e); });
  var issues=Object.keys(byIssue).sort(function(a,b){ return byIssue[b].length-byIssue[a].length; });
  var excSec=exc.length
    ?("<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Issue</th><th class=\"r\">Jobs</th><th>Which</th></tr></thead><tbody>"
      +issues.map(function(k){
        var list=byIssue[k];
        return "<tr class=\"static\"><td><b>"+esc(k)+"</b></td><td class=\"r\">"+list.length+"</td>"
          +"<td style=\"white-space:normal\">"+list.slice(0,6).map(function(e){
              return "<a href=\"#\" onclick=\"goJobPage('"+attrEsc(String(e.jno||""))+"');return false\" style=\"color:var(--accent)\">"+esc(e.name||e.jno||"")+"</a>";
            }).join(" · ")+(list.length>6?(" <span class=\"m-m\">+"+(list.length-6)+" more</span>"):"")+"</td></tr>";
      }).join("")+"</tbody></table></div>"
      +"<div class=\"vsub\" style=\"margin-top:8px\">Each job's field-by-field reconciliation lives on its own page — this is the list of what needs fixing, not the fixing itself.</div>")
    :"<div class=\"vsub\">No data exceptions — Procore and Foundation agree everywhere.</div>";

  var fOnly=foundationOnlyNonGC().slice().sort(function(a,b){return (b.currentContract||0)-(a.currentContract||0);});
  var fOnlySec=fOnly.length
    ?("<details class=\"lgcy\"><summary>"+fOnly.length+" active Foundation jobs not on the Procore board — "+fmtCompact(fOnly.reduce(function(s2,f){return s2+(f.currentContract||0);},0))+" of contract value with no field/PM tracking</summary>"
      +"<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Job</th><th>PM</th><th class=\"r\">Contract</th><th class=\"r\">Cost to date</th><th class=\"r\">Billed</th></tr></thead><tbody>"
      +fOnly.slice(0,15).map(function(f){ return "<tr class=\"static\"><td><div class=\"jname\">"+esc(f.description||"")+"</div><div class=\"jno\">"+esc(f.jobNo||"")+"</div></td><td>"+esc(f.pmName||"—")+"</td><td class=\"r\">"+fmtCompact(f.currentContract||0)+"</td><td class=\"r\">"+fmtCompact(f.totalCosts||0)+"</td><td class=\"r\">"+fmtCompact(f.totalInvoiced||0)+"</td></tr>"; }).join("")
      +"</tbody></table></div>"+(fOnly.length>15?"<div class=\"vsub\" style=\"margin-top:6px\">Top 15 by contract shown.</div>":"")+"</details>")
    :"";

  view.innerHTML=warn+strip
    +"<div class=\"vhead\">Where margin is moving</div>"
    +"<div class=\"vsub\">Current projected margin against the margin each job was bid at. Only jobs with a trusted ERP projected cost are ranked here; ⚠ cost burn = cost running ≥"+GF_BURN_PTS+" points ahead of progress.</div>"
    +gfTable+unSec
    +"<div class=\"vhead\">Buyout exposure — committed vs cost budget</div><div class=\"vsub\">Procore sub + PO contracts vs revised cost budget. Uncommitted = still to buy (includes RYC-carried general conditions).</div>"+boTable
    +"<div class=\"vhead\">Data exceptions</div><div class=\"vsub\">Cross-source disagreements to reconcile before quoting these numbers.</div>"+excSec
    +fOnlySec;
  hookDrawerRows();
}

/* ===== Data Trust (Phase 6 — source health + the shared provenance reference) === */
function renderTrust(){
  var view=document.getElementById("view");
  var now=Date.now();
  function health(loaded,ts){
    if(!loaded) return "<span class=\"pill r dot\">Down</span>";
    if(ts&&(now-new Date(ts))/3600000>30) return "<span class=\"pill a dot\">Stale</span>";
    return "<span class=\"pill g dot\">OK</span>";
  }
  function srow(name,provides,cadence,ts,count,loaded){
    return "<tr class=\"static\"><td><div class=\"jname\">"+name+"</div></td><td style=\"white-space:normal\">"+provides+"</td><td>"+cadence+"</td>"
      +"<td>"+(ts?(ageTxt(ts)+"<div class=\"cell-sub\">"+new Date(ts).toLocaleString()+"</div>"):"—")+"</td>"
      +"<td class=\"r\">"+count+"</td><td>"+health(loaded,ts)+"</td></tr>";
  }
  var srcTable="<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Source</th><th>Provides</th><th>Cadence</th><th>Last data</th><th class=\"r\">Records</th><th>Health</th></tr></thead><tbody>"
    +srow("Procore cache","Schedule, %, RFIs, submittals, CO types, revised contracts, budgets, commitments/buyout","Daily 04:00 UTC (11pm ET) + on-demand",activeData&&activeData.refreshed,((activeData&&activeData.jobs)||[]).length+" jobs",!!activeData)
    +srow("Foundation snapshot","Cost to date, billings, retainage, PM names, CO postings, markups","Nightly 09:00 UTC (4am ET)",foundationData&&foundationData.refreshed,(foundationData&&foundationData.jobs?Object.keys(foundationData.jobs).length:0)+" jobs",!!foundationData)
    +srow("Foundation AR","Open / overdue invoices with aging","Nightly 09:00 UTC (same run)",arData&&arData.refreshed,(((arData&&arData.invoices)||[]).length)+" invoices",!!arData)
    +srow("Sub rollup","Actual-by-vendor + PO_Sub subcontracts, 2023+ (Subcontractors view, drawer sub lists)","Nightly (VM, ryc-dashboard-refresh)",subsData&&subsData.generated,(subsData&&subsData.subs?subsData.subs.length+" subs":"—"),!!subsData)
    +srow("Buildr","Client-relations visits + follow-up tasks","Live API on page load",buildrData&&buildrData.refreshed,(buildrData&&buildrData.jobs?Object.keys(buildrData.jobs).length:0)+" projects",!!buildrData)
    +srow("BC bid board","Projects out to bid, trade-package invite coverage, bids received (Estimating view)","Daily 09:30 UTC (VM, bc-bidboard)",bcData&&bcData.generatedAt,(bcData&&bcData.published?bcData.published.length+" out to bid":"—"),!!bcData)
    +srow("Portfolio archive","Completed-job record, pegged at completion (Completed view + sector insights)","Nightly (VM, ryc-dashboard-refresh)",portfolioData&&portfolioData.generated,((portfolioData&&portfolioData.jobs)||[]).length?(((portfolioData&&portfolioData.jobs)||[]).length+" jobs"):"—",!!portfolioData)
    +"</tbody></table></div>"
    +"<div class=\"vsub\" style=\"margin-top:8px\">Stale = no fresh data in 30h (a scheduled run was missed — check the Automation Health card on the CRM dashboard). Foundation is read-only by design; nothing here can write.</div>";

  var exc=buildExceptions(getActiveJobs());
  var byIssue={};
  exc.forEach(function(e){ byIssue[e.issue]=(byIssue[e.issue]||0)+1; });
  var excSummary=exc.length
    ?("<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Exception type</th><th class=\"r\">Jobs</th></tr></thead><tbody>"
      +Object.keys(byIssue).map(function(k){ return "<tr class=\"static\"><td>"+esc(k)+"</td><td class=\"r\">"+byIssue[k]+"</td></tr>"; }).join("")
      +"</tbody></table></div><div class=\"vsub\" style=\"margin-top:8px\">Full job-by-job list with details on <a href=\"#\" onclick=\"setView(&quot;margin&quot;);return false\" style=\"color:var(--accent);font-weight:600\">Margin &amp; Risk → Data exceptions</a>.</div>")
    :"<div class=\"vsub\">No open reconciliation exceptions — Procore and Foundation agree everywhere.</div>";

  view.innerHTML="<div class=\"trust\">"
    +"<div class=\"vhead\">Source health</div><div class=\"vsub\">Every feed this cockpit reads, its cadence, and the age of the data on screen right now. Healthy feeds are silent on the Overview — only delays surface there.</div>"+srcTable
    /* The manual re-pull buttons MOVED to Admin → Integrations & Sync (contract §4: one
       audited home for refresh machinery). They are not duplicated here — two buttons for the
       same job in two places is how a second implementation starts. Coverage context stays,
       because it is about the DATA, which is what this page owns. */
    +"<div class=\"vhead\" style=\"margin-top:18px\">Data controls</div><div class=\"vsub\">Manual re-pulls now live in <b>Admin → Integrations &amp; Sync</b>, alongside each source's run history. Coverage: "+foundationOnlyNonGC().length+" Foundation-only active jobs not on the board · Greencroft: "+greencroftBoardJobs().length+" on board + "+greencroftJobs().length+" Foundation-only.</div>"
    +"<div style=\"margin:8px 0 4px\"><button class=\"pfill\" onclick=\"setView('integrations')\">&#128260; Open Integrations &amp; Sync</button></div>"
    +"<div class=\"vhead\">Reconciliation exceptions</div><div class=\"vsub\">Cross-source disagreements currently open — the audit-layer worklist.</div>"+excSummary
    +"<div class=\"vhead\" style=\"display:flex;align-items:center;gap:10px\">Field provenance reference <button class=\"pfill\" onclick=\"printDS()\">🖨 Print</button></div>"
    +"<div class=\"vsub\">The shared Data Sources dictionary — one definition, loaded by this cockpit and the Foundation query tool. Git-tracked source: RYC_Dashboard_Data_Dictionary.md.</div>"
    +"<div id=\"ds-panel\" style=\"background:#fff;border:1px solid #dfe4ec;border-radius:var(--r);padding:18px 22px\">"
    +(typeof dataSourcesHTML==="function"?dataSourcesHTML():"<div class=\"vsub\">data-sources.js failed to load — provenance reference unavailable.</div>")
    +"</div></div>";
  hookDrawerRows();
}

/* ===== AI Assistant (Phase 6 — the /ryc/foundation NL→SQL, restyled) ========= */
/* ===== INTEGRATIONS & SYNC — the audited home for refresh machinery (contract §4) ==========
   READ-ONLY by design at this stage. The build order is observe-before-control: run history
   has to be proven trustworthy before any button here can be believed. The two refresh
   controls that already exist keep living in Data Trust until the controls step, so this page
   adds NO new manual authority (contract D8 accepted today's exposure, not an expansion).

   Three registry concepts render differently, because conflating them is how a live API ends
   up displaying a fake sync cadence:
     · scheduled ingestion — cadence, freshness, run history
     · live connection     — reachability only; never a cadence
     · outbound action     — audited business action; never a "Run now"
   State is THREE INDEPENDENT DIMENSIONS (last attempt × data freshness × connection). The
   single 30-hour constant this replaces called a healthy weekly source "stale" every week. */
var _syncData=null;
function loadSync(){
  // D8: the interim credential lives in ONE place (RYCAuth), not at every call site.
  return RYCAuth.post("status",{},{url:"/api/ryc-sync-log"})
    .then(function(r){ _syncData=(r.ok&&r.data&&r.data.ok)?r.data:null; return _syncData; });
}
function syncStatePill(s){
  // Color is never the only signal — every pill carries its word (contract §3).
  var st=s.last_attempt_state, map={ok:["ok","g"],failed:["failed","r"],refused:["refused","a"],
    abandoned:["abandoned","a"],dispatch_failed:["never started","r"],running:["running","b"],
    requested:["requested","b"],cancelled:["cancelled","n"]};
  if(!st) return '<span class="pill n">no runs yet</span>';
  var m=map[st]||[st,"n"];
  return '<span class="pill '+m[1]+'">'+m[0]+'</span>'+(s.late_completion?' <span class="pill a">completed late</span>':'');
}
function syncFreshPill(s){
  if(s.kind!=="scheduled") return '<span class="pill n">n/a</span>';
  if(s.data_freshness==="never") return '<span class="pill n">no data yet</span>';
  if(s.data_freshness==="stale") return '<span class="pill a">stale</span>';
  return '<span class="pill g">fresh</span>';
}
/* "Run now" renders ONLY where the registry says manual_control_pre_identity — Procore and
   Foundation, the two controls that already existed in Data Trust. D8 accepted TODAY's
   exposure level under the shared gate, not an expansion to every publisher: without that
   restriction, this page would hand four additional publishers (two of which redeploy
   production) to every gate-holder. The others become available when identity lands, or if
   Keith explicitly widens the scope. */
function syncRunBtn(s){
  if(!s.manual_control_pre_identity) return "";
  if(s.last_attempt_state==="running"||s.last_attempt_state==="requested"){
    // a lease is held — this is a real lock, not a cosmetic disable
    return '<button class="pfill" disabled title="A run is already in flight">&#10227; running…</button>';
  }
  return '<button class="pfill" id="run-'+s.key+'" onclick="syncRunNow(\''+s.key+'\',this)">&#10227; Run now</button>';
}
function syncRunNow(key,btn){
  var svc=(_syncData&&_syncData.services||[]).filter(function(x){return x.key===key;})[0];
  if(!svc) return;
  // A run that publishes an artifact also triggers a production redeploy — that deserves a
  // confirmation stating scope and impact, not a silent click. A ~5s in-place refresh does not.
  if(svc.publishes){
    var msg="Re-run "+svc.label+" now?\n\n"
      +"· Re-pulls: "+(svc.datasets||[]).join(", ")+"\n"
      +"· Publishes the result and triggers a production redeploy (~2-3 min, then ~75s deploy)\n"
      +"· Reads from the source system only — it never writes back to Procore or Foundation";
    if(!confirm(msg)) return;
  }
  if(key==="procore") refreshProcore(btn);
  else if(key==="foundation") refreshFoundation(btn);
  // after either completes, re-read telemetry so the row reflects the run it just triggered
  setTimeout(function(){ if(currentView==="integrations") renderIntegrations(); },8000);
}
function renderIntegrations(){
  var v=document.getElementById("view");
  v.innerHTML='<div class="panel"><div class="sub">Loading sync telemetry…</div></div>';
  loadSync().then(function(){
    if(!_syncData){ v.innerHTML='<div class="panel"><div class="h">Integrations &amp; Sync</div>'
      +'<div class="warn-banner">Sync telemetry is unavailable — this page reports on the machinery, so an outage here does NOT mean the feeds are down. Check Data Trust for source health.</div></div>'; return; }
    var rows=_syncData.services||[];
    var sched=rows.filter(function(s){return s.kind==="scheduled";});
    var live=rows.filter(function(s){return s.kind==="live";});
    var out=rows.filter(function(s){return s.kind==="outbound";});

    var h='<div class="panel"><div class="h">Scheduled ingestion</div>'
      +'<div class="sub">Each service is graded against <b>its own</b> cadence. Last attempt, data freshness and connection are separate facts: an attempt can fail while the data it would have replaced is still current.</div>'
      +'<table class="tbl"><thead><tr><th>Service</th><th>Last attempt</th><th>Data</th><th>Cadence</th>'
      +'<th class="r">Last success</th><th class="r">Records</th><th>Next expected</th><th></th></tr></thead><tbody>';
    sched.forEach(function(s){
      h+='<tr><td><b>'+esc(s.label)+'</b><div class="sub">'+esc((s.datasets||[]).join(" · "))+'</div></td>'
        +'<td>'+syncStatePill(s)+(s.last_error_code?'<div class="sub">'+esc(s.last_error_code)+'</div>':'')+'</td>'
        +'<td>'+syncFreshPill(s)+'</td>'
        +'<td class="sub">'+esc(s.cadence||"—")+'</td>'
        +'<td class="r">'+(s.last_success_at?'<span title="'+esc(s.last_success_at)+'">'+ageTxt(s.last_success_at)+'</span>':'—')+'</td>'
        +'<td class="r">'+(s.count_written!=null?s.count_written:"—")+'</td>'
        +'<td class="sub">'+(s.next_expected_at?fmtDate(s.next_expected_at):"—")+'</td>'
        +'<td>'+syncRunBtn(s)+'<button class="pfill" onclick="showSyncHistory(\''+s.key+'\')">History</button></td></tr>';
    });
    h+='</tbody></table></div>';

    if(live.length){
      h+='<div class="panel"><div class="h">Live connections</div>'
        +'<div class="sub">Queried at page load — there is no sync cadence to be behind, and none is shown.</div><table class="tbl"><tbody>';
      live.forEach(function(s){ h+='<tr><td><b>'+esc(s.label)+'</b></td><td class="sub">live API · no scheduled run</td></tr>'; });
      h+='</tbody></table></div>';
    }
    if(out.length){
      h+='<div class="panel"><div class="h">Outbound actions</div>'
        +'<div class="sub">Writes to a source system, on demand. Audited as an action — never a generic refresh.</div><table class="tbl"><tbody>';
      out.forEach(function(s){ h+='<tr><td><b>'+esc(s.label)+'</b></td><td class="sub">user-triggered</td></tr>'; });
      h+='</tbody></table></div>';
    }
    h+='<div class="panel"><div class="sub"><b>Run now</b> appears only for Procore and Foundation — the two manual controls that already existed. '
      +'The other publishers stay read-only until identity lands or that scope is explicitly widened, because a shared gate cannot tell who is clicking. '
      +'A run that publishes an artifact confirms first: it redeploys production, and it only ever reads from the source system.</div></div>';
    h+='<div id="syncHist"></div>';
    v.innerHTML=h;
  });
}
function showSyncHistory(key){
  var el=document.getElementById("syncHist");
  el.innerHTML='<div class="panel"><div class="sub">Loading run history…</div></div>';
  RYCAuth.post("history",{service:key,limit:20},{url:"/api/ryc-sync-log"}).then(function(rr){
      var d=rr.ok?rr.data:null;
      if(!d||!d.ok){ el.innerHTML='<div class="panel"><div class="sub">History unavailable.</div></div>'; return; }
      var runs=d.runs||[];
      if(!runs.length){ el.innerHTML='<div class="panel"><div class="h">'+esc(key)+' — run history</div><div class="sub">No runs recorded yet. Telemetry starts at the next scheduled run.</div></div>'; return; }
      var h='<div class="panel"><div class="h">'+esc(key)+' — run history</div>'
        +'<table class="tbl"><thead><tr><th>Started</th><th>State</th><th>Trigger</th><th>By</th>'
        +'<th class="r">Read</th><th class="r">Written</th><th>Watermark</th><th>Artifact</th><th>Detail</th></tr></thead><tbody>';
      runs.forEach(function(r){
        var dur=(r.started_at&&r.finished_at)?Math.round((new Date(r.finished_at)-new Date(r.started_at))/1000)+"s":"—";
        h+='<tr><td><span title="'+esc(r.created_at)+'">'+ageTxt(r.created_at)+'</span><div class="sub">'+dur+'</div></td>'
          +'<td>'+syncStatePill({last_attempt_state:r.state,late_completion:r.late_completion})+'</td>'
          +'<td class="sub">'+esc(r.trigger)+'</td>'
          +'<td class="sub">'+esc(r.executed_by_service_id||r.requested_by_display||"—")+'</td>'
          +'<td class="r">'+(r.count_read!=null?r.count_read:"—")+'</td>'
          +'<td class="r">'+(r.count_written!=null?r.count_written:"—")+'</td>'
          +'<td class="sub">'+(r.watermark_after?esc(String(r.watermark_after).slice(0,19)):"—")+'</td>'
          +'<td class="sub" title="'+esc(r.artifact_location||"")+'">'+(r.artifact_hash?esc(r.artifact_hash.slice(0,10)):"—")+'</td>'
          +'<td class="sub">'+esc(r.error_code||"")+(r.error_detail?' — '+esc(String(r.error_detail).slice(0,90)):"")+'</td></tr>';
      });
      h+='</tbody></table><div class="sub" style="margin-top:8px">Run rows are lifecycle-managed; every transition is kept in an append-only event log, so a late completion after an abandonment shows both facts rather than overwriting one with the other.</div></div>';
      el.innerHTML=h;
      el.scrollIntoView({behavior:"smooth",block:"nearest"});
    });
}

/* Same API (/api/ryc-foundation-query), same sessionStorage key (fdn_pw) and recents
   (fdn_recent) as /ryc/foundation — a login or question history carries across both tools.
   The tool password is FOUNDATION_TOOL_PASSWORD (server-side check), separate from the gate. */
var AI_EXAMPLES=[
  "Top 10 active jobs by cost to date",
  "Total billed and total cost for each active job",
  "Which jobs have the most overdue AR?",
  "Current contract value by job including change orders",
  "Retainage held on active jobs",
  "Active jobs by project manager"
];
var _aiLast=null;
function aiCall(payload){
  var body=Object.assign({password:sessionStorage.getItem("fdn_pw")},payload);
  return fetch("/api/ryc-foundation-query",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
    .then(function(r){ return r.json().catch(function(){return {};}).then(function(d){ return {status:r.status,data:d}; }); });
}
function aiDisclaimer(){
  return "<div class=\"warn-banner\" style=\"background:#fdf3ea;border-color:#f0d5bc;color:#8a4b12\"><b>Live Foundation data — raw values.</b> "
    +"This queries Foundation in real time and returns raw numbers; the rest of this cockpit reads a nightly snapshot and applies conventions (contract incl. COs, gross billings, forecast margins) — the two can legitimately differ by up to a day or by definition. Answers reconcile to Foundation; see <a href=\"#\" onclick=\"setView(&quot;trust&quot;);return false\" style=\"color:#8a4b12;font-weight:700\">Data Trust</a> for how each number is defined. Read-only; payroll/employee data blocked.</div>";
}
function renderAI(){
  var view=document.getElementById("view");
  if(!sessionStorage.getItem("fdn_pw")){
    view.innerHTML="<div class=\"ai\">"+aiDisclaimer()
      +"<div class=\"panel\" style=\"max-width:420px\"><h3>Unlock Foundation reports</h3><div class=\"sub\">This tool has its own password (not the dashboard access code).</div>"
      +"<input id=\"ai-pw\" type=\"password\" placeholder=\"Foundation Reports password\" style=\"width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d5dbe6;border-radius:7px;font-size:14px\">"
      +"<div id=\"ai-pw-err\" style=\"color:#d64545;font-size:12px;height:16px;margin-top:6px\"></div>"
      +"<button class=\"ask-btn\" style=\"margin-top:6px\" onclick=\"aiLogin()\">Unlock</button></div></div>";
    var pw=document.getElementById("ai-pw");
    pw.addEventListener("keydown",function(e){ if(e.key==="Enter") aiLogin(); });
    pw.focus();
    return;
  }
  var recents=[];
  try{ recents=JSON.parse(localStorage.getItem("fdn_recent")||"[]"); }catch(e){}
  view.innerHTML="<div class=\"ai\">"+aiDisclaimer()
    +"<div class=\"panel\"><h3>Ask Foundation</h3><div class=\"sub\">Plain English in — Claude writes the SQL, runs it read-only against Foundation live, and shows the result.</div>"
    +"<textarea id=\"ai-q\" rows=\"2\" placeholder=\"e.g. Show total billed and total cost for each active job\"></textarea>"
    +"<div style=\"display:flex;justify-content:flex-end;margin-top:10px\"><button class=\"ask-btn\" id=\"ai-ask\" onclick=\"aiAsk()\">Ask</button></div>"
    +"<div class=\"ai-cards\">"+AI_EXAMPLES.map(function(t){ return "<div class=\"ai-card\" data-q=\""+attrEsc(t)+"\">"+esc(t)+"</div>"; }).join("")+"</div>"
    +(recents.length?("<div class=\"sub\" style=\"margin:12px 0 0\">Recent</div><div class=\"ai-chips\">"+recents.map(function(t){ return "<span class=\"ai-chip\" data-q=\""+attrEsc(t)+"\">"+esc(t)+"</span>"; }).join("")+"</div>"):"")
    +"</div><div id=\"ai-out\"></div></div>";
  Array.prototype.forEach.call(view.querySelectorAll("[data-q]"),function(el){
    el.addEventListener("click",function(){ document.getElementById("ai-q").value=el.getAttribute("data-q"); aiAsk(); });
  });
  var q=document.getElementById("ai-q");
  q.addEventListener("keydown",function(e){ if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)) aiAsk(); });
}
function aiLogin(){
  var pw=document.getElementById("ai-pw").value;
  if(!pw) return;
  sessionStorage.setItem("fdn_pw",pw);
  aiCall({verify:true}).then(function(r){
    if(r.status===200){ renderAI(); }
    else{ sessionStorage.removeItem("fdn_pw"); document.getElementById("ai-pw-err").textContent="Incorrect password."; }
  });
}
function aiIsNum(v){ return v!==null&&v!==""&&!isNaN(Number(v)); }
function aiFmt(v){ return aiIsNum(v)?Number(v).toLocaleString("en-US",{maximumFractionDigits:2}):(v==null?"":v); }
function aiSql(sql){ return sql?("<details><summary>View the SQL Claude wrote</summary><pre>"+esc(sql)+"</pre></details>"):""; }
function aiPushRecent(q){
  var r=[];
  try{ r=JSON.parse(localStorage.getItem("fdn_recent")||"[]"); }catch(e){}
  r=[q].concat(r.filter(function(x){return x!==q;})).slice(0,8);
  localStorage.setItem("fdn_recent",JSON.stringify(r));
}
function aiAsk(){
  var q=(document.getElementById("ai-q").value||"").trim();
  if(!q) return;
  var btn=document.getElementById("ai-ask"), out=document.getElementById("ai-out");
  btn.disabled=true;
  out.innerHTML="<div class=\"panel\" style=\"margin-top:14px\"><span class=\"spin\"></span>&nbsp; Thinking — writing SQL, querying Foundation live…</div>";
  aiCall({question:q}).then(function(r){
    btn.disabled=false;
    if(r.status===401){ sessionStorage.removeItem("fdn_pw"); renderAI(); return; }
    aiPushRecent(q);
    var d=r.data||{};
    if(d.status==="refused"){ out.innerHTML="<div class=\"err-box\"><b>Cannot answer that one.</b><br>"+esc(d.explanation||"")+"</div>"; return; }
    if(d.status==="blocked"){ out.innerHTML="<div class=\"err-box\"><b>Query blocked by the safety guard.</b><br>"+esc(d.error||"")+"</div>"+aiSql(d.sql); return; }
    if(d.status!=="ok"){ out.innerHTML="<div class=\"err-box\"><b>Something went wrong.</b><br>"+esc(d.error||"Unknown error")+"</div>"+(d.sql?aiSql(d.sql):""); return; }
    var cols=d.columns||[], rows=d.rows||[];
    var numCol=cols.map(function(_,i){ return rows.length&&rows.every(function(rr){ return rr[i]==null||aiIsNum(rr[i]); }); });
    var html="";
    if(d.explanation) html+="<div class=\"vsub\" style=\"margin:14px 0 6px\">"+esc(d.explanation)+"</div>";
    html+="<div style=\"display:flex;justify-content:space-between;align-items:center;margin:8px 0 4px\"><span class=\"vsub\" style=\"margin:0\">"+rows.length+" row"+(rows.length===1?"":"s")+(d.truncated?(" (capped at "+d.row_cap+")"):"")+"</span><button class=\"pfill\" onclick=\"aiCSV()\">⬇ CSV</button></div>";
    html+="<div class=\"out-table\"><table><thead><tr>"+cols.map(function(c,i){ return "<th class=\""+(numCol[i]?"num":"")+"\">"+esc(c)+"</th>"; }).join("")+"</tr></thead><tbody>";
    rows.forEach(function(rr){ html+="<tr>"+rr.map(function(v,i){ return "<td class=\""+(numCol[i]?"num":"")+"\">"+esc(aiFmt(v))+"</td>"; }).join("")+"</tr>"; });
    html+="</tbody></table></div>"+aiSql(d.sql);
    out.innerHTML=html;
    _aiLast={cols:cols,rows:rows};
  }).catch(function(e){
    btn.disabled=false;
    out.innerHTML="<div class=\"err-box\"><b>Request failed.</b><br>"+esc(e.message||String(e))+"</div>";
  });
}
function aiCSV(){
  if(!_aiLast) return;
  function qv(v){ v=v==null?"":String(v); return /[\",\n]/.test(v)?("\""+v.replace(/\"/g,"\"\"")+"\""):v; }
  var csv=[_aiLast.cols.map(qv).join(",")].concat(_aiLast.rows.map(function(r){ return r.map(qv).join(","); })).join("\n");
  var a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download="foundation-report.csv"; a.click(); URL.revokeObjectURL(a.href);
}

/* ===== Revenue Forecast (2026-07-07 — Buildr forecast, Steve's report) ======== */
/* Mirrors buildr.app → Analytics → Forecast (the source of Steve's "revenue projections"):
   each open Buildr project's amount spread LINEARLY across start→end by month, grouped
   Booked (active + upcoming/awarded) vs Potential (pursuit). Forward-only — months already
   elapsed are treated as earned and excluded. Probability weighting deliberately omitted
   (RYC keys probability as 0/1 on all but a handful — matches Steve's weighted=0 display).
   Undated projects can't spread; they're surfaced as an explicit bucket, never dropped. */
function fcMonthIdx(d){ return d.getFullYear()*12+d.getMonth(); }
function fcMonthLabel(idx){ var y=Math.floor(idx/12), m=idx%12; return new Date(y,m,1).toLocaleDateString("en-US",{month:"short",year:"numeric"}); }
function fcSpread(projects){
  var nowIdx=fcMonthIdx(new Date());
  var buckets={}, undated=[], horizon=nowIdx;
  projects.forEach(function(p){
    if(!(p.amount>0)) return;
    var cls=(p.status==="pursuit")?"potential":"booked";
    if(!p.startDate||!p.endDate){ undated.push(p); return; }
    /* RYCFormat.parse, not new Date(): Buildr schedule dates are date-only, so UTC-midnight
       parsing put a project starting on the 1st of a month into the PREVIOUS month's
       revenue bucket in Eastern time — silently moving forecast dollars across a period
       boundary, and across a quarter subtotal four times a year (program 1.3). */
    var s=fcMonthIdx(RYCFormat.parse(p.startDate)), e=fcMonthIdx(RYCFormat.parse(p.endDate));
    if(!(e>=s)){ undated.push(p); return; }
    var perMonth=p.amount/(e-s+1);
    for(var m=Math.max(s,nowIdx);m<=e;m++){
      if(!buckets[m]) buckets[m]={booked:0,potential:0};
      buckets[m][cls]+=perMonth;
      if(m>horizon) horizon=m;
    }
  });
  return {buckets:buckets,undated:undated,nowIdx:nowIdx,horizon:horizon};
}
/* Horizon lanes (program 5.4). The page answers "what work may start, when, at what value and
   with what confidence", so it is grouped by WHEN — not by a month-by-month spread, which is
   the arithmetic behind the answer rather than the answer itself. That spread is still here,
   one disclosure down, because it is the shape Steve knows from Buildr's own report. */
var FC_LANES=[
  {key:"now",   label:"Next 90 days",  hint:"starting inside the quarter", lo:0,  hi:3},
  {key:"mid",   label:"3–6 months",    hint:"next planning window",        lo:3,  hi:6},
  {key:"late",  label:"6–12 months",   hint:"this year",                   lo:6,  hi:12},
  {key:"beyond",label:"Beyond 12 months",hint:"long lead",                 lo:12, hi:1e9},
];
function fcLaneOf(p2,nowIdx){
  if(!p2.startDate) return "undated";
  var s2=fcMonthIdx(RYCFormat.parse(p2.startDate));
  var d=s2-nowIdx;
  if(d<0) d=0;                              // already underway counts as immediate
  for(var i=0;i<FC_LANES.length;i++) if(d>=FC_LANES[i].lo && d<FC_LANES[i].hi) return FC_LANES[i].key;
  return "beyond";
}
function renderForecast(){
  var view=document.getElementById("view");
  if(!forecastData||!forecastData.projects){
    view.innerHTML="<div class=\"warn-banner\">⚠️ Buildr forecast feed unavailable — revenue projections cannot be computed. Figures show Unavailable, not $0.</div>";
    return;
  }
  var projects=forecastData.projects;
  var nowIdx=fcMonthIdx(new Date());
  var sp=fcSpread(projects);
  var months=Object.keys(sp.buckets).map(Number).sort(function(a,b){return a-b;});

  /* ---- lanes ---- */
  var lanes={undated:[]};
  FC_LANES.forEach(function(l){ lanes[l.key]=[]; });
  projects.forEach(function(p2){ if(p2.amount>0) lanes[fcLaneOf(p2,nowIdx)].push(p2); });
  function laneTotals(list){
    var b=0,pt=0;
    list.forEach(function(p2){ if(p2.status==="pursuit") pt+=p2.amount||0; else b+=p2.amount||0; });
    return {booked:b,potential:pt,total:b+pt,n:list.length};
  }
  var laneCards=FC_LANES.map(function(l){
    var t=laneTotals(lanes[l.key]);
    return "<div class=\"kpi\"><div class=\"kl\">"+l.label+"</div>"
      +"<div class=\"kv\">"+fmtCompact(t.total)+"</div>"
      +"<div class=\"ks\">"+t.n+" project"+(t.n===1?"":"s")+" · "+fmtCompact(t.booked)+" booked · "+fmtCompact(t.potential)+" potential</div></div>";
  }).join("");
  var uT=laneTotals(lanes.undated);
  var strip="<div class=\"kpi-strip k4\">"+laneCards+"</div>";

  /* ---- the pipeline itself ---- */
  function projRow(p2){
    var dated=p2.startDate&&p2.endDate;
    var conf=(p2.status==="pursuit")
      ? "<span class=\"pill a dot\">Pursuit</span>"
      : "<span class=\"pill g dot\">"+esc(p2.status||"booked")+"</span>";
    return "<tr"+openAttr(p2.projectNumber||"")+">"
      +"<td><div class=\"jname\">"+esc(p2.name)+"</div>"
      +"<div class=\"jno\">"+esc(p2.company||"")+srcLink(buildrUrl(p2.id),"Buildr")+"</div></td>"
      +"<td>"+conf+(p2.stage?"<div class=\"cell-sub\">"+esc(p2.stage)+"</div>":"")+"</td>"
      +"<td>"+(dated?RYCFormat.date(p2.startDate):"<span class=\"m-a\">no start date</span>")+"</td>"
      +"<td>"+(dated?RYCFormat.date(p2.endDate):"<span class=\"m-m\">—</span>")+"</td>"
      +"<td class=\"r\"><b>"+fmtCompact(p2.amount)+"</b></td>"
      +"<td>"+esc(p2.assignedTo||"<span class=\"m-m\">unassigned</span>")+"</td></tr>";
  }
  var pipeHtml="";
  FC_LANES.forEach(function(l){
    var list=lanes[l.key].slice().sort(function(a,b){return (b.amount||0)-(a.amount||0);});
    if(!list.length) return;
    var t=laneTotals(list);
    pipeHtml+="<tr><td colspan=\"6\" style=\"padding:16px 0 4px\"><b>"+l.label+"</b> "
      +"<span class=\"m-m\">· "+l.hint+" · "+t.n+" project"+(t.n===1?"":"s")+" · <b>"+fmtCompact(t.total)+"</b></span></td></tr>";
    list.forEach(function(p2){ pipeHtml+=projRow(p2); });
  });
  var pipeline=pipeHtml
    ?("<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Project</th><th>Confidence</th><th>Expected start</th><th>Expected finish</th><th class=\"r\">Value</th><th>Owner</th></tr></thead><tbody>"+pipeHtml+"</tbody></table></div>")
    :"<div class=\"vsub\">Nothing dated in the pipeline.</div>";

  /* ---- undated: the actionable data-fix queue, and the reason a lane can be wrong ---- */
  var undatedSec="";
  if(lanes.undated.length){
    var uRows=lanes.undated.slice().sort(function(a,b){return (b.amount||0)-(a.amount||0);}).map(function(p2){
      return "<tr class=\"static\"><td><div class=\"jname\">"+esc(p2.name)+srcLink(buildrUrl(p2.id),"Buildr — add dates")+"</div>"
        +"<div class=\"jno\">"+esc(p2.company||"")+(p2.assignedTo?" · "+esc(p2.assignedTo):"")+"</div></td>"
        +"<td>"+esc(p2.status==="pursuit"?(p2.stage||"pursuit"):p2.status)+"</td>"
        +"<td class=\"r\">"+fmtCompact(p2.amount)+"</td></tr>";
    }).join("");
    undatedSec="<div class=\"vhead\">Undated — not in any lane</div>"
      +"<div class=\"vsub\"><b>"+lanes.undated.length+" projects · "+fmtCompact(uT.total)+"</b> carry no start date in Buildr, so they cannot be placed on a horizon and Buildr's own Forecast drops them silently too. Every row links straight to its Buildr card; entering a date pulls it into a lane above.</div>"
      +"<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Project</th><th>Status / stage</th><th class=\"r\">Value</th></tr></thead><tbody>"+uRows+"</tbody></table></div>";
  }

  /* ---- the month spread, kept as the arithmetic behind the lanes ---- */
  var rows="", qB=0,qP=0, tB=0,tP=0, beyondB=0,beyondP=0, lastQ=null;
  var CAP=18, capIdx=sp.nowIdx+CAP-1;
  function qKey(m){ var y=Math.floor(m/12), q=Math.floor((m%12)/3)+1; return "Q"+q+" "+y; }
  function qRow(label,b,p2){ return "<tr style=\"background:#f7f9fc;font-weight:700\"><td>"+label+"</td><td class=\"r\">"+fmtCompact(b)+"</td><td class=\"r\">"+fmtCompact(p2)+"</td><td class=\"r\">"+fmtCompact(b+p2)+"</td></tr>"; }
  var lastIdx=Math.min(sp.horizon,capIdx);
  for(var m=sp.nowIdx;m<=lastIdx;m++){
    var b2=sp.buckets[m]||{booked:0,potential:0};
    var q=qKey(m);
    if(lastQ!==null&&q!==lastQ){ rows+=qRow(lastQ+" subtotal",qB,qP); qB=0;qP=0; }
    lastQ=q;
    qB+=b2.booked; qP+=b2.potential; tB+=b2.booked; tP+=b2.potential;
    rows+="<tr class=\"static\"><td>"+fcMonthLabel(m)+"</td><td class=\"r\">"+(b2.booked>0?fmtCompact(b2.booked):"<span class=\"m-m\">—</span>")+"</td><td class=\"r\">"+(b2.potential>0?fmtCompact(b2.potential):"<span class=\"m-m\">—</span>")+"</td><td class=\"r\"><b>"+fmtCompact(b2.booked+b2.potential)+"</b></td></tr>";
  }
  if(lastQ!==null) rows+=qRow(lastQ+" subtotal",qB,qP);
  months.forEach(function(m2){ if(m2>capIdx){ beyondB+=sp.buckets[m2].booked; beyondP+=sp.buckets[m2].potential; } });
  if(beyondB+beyondP>0){ tB+=beyondB; tP+=beyondP; rows+="<tr class=\"static\"><td>Beyond "+fcMonthLabel(capIdx)+"</td><td class=\"r\">"+fmtCompact(beyondB)+"</td><td class=\"r\">"+fmtCompact(beyondP)+"</td><td class=\"r\"><b>"+fmtCompact(beyondB+beyondP)+"</b></td></tr>"; }
  var periodSec="<details class=\"lgcy\"><summary>Month-by-month spread — the arithmetic behind the lanes</summary>"
    +"<div class=\"vsub\" style=\"margin-top:6px\">Each project's value spread evenly across its start → end months, the same math as Buildr's own Forecast report. Undated projects are excluded from the spread, which is why they are listed separately above.</div>"
    +"<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Period</th><th class=\"r\">Booked</th><th class=\"r\">Potential</th><th class=\"r\">Total</th></tr></thead><tbody>"+rows
    +"</tbody><tfoot><tr><td>Total forward</td><td class=\"r\">"+fmtCompact(tB)+"</td><td class=\"r\">"+fmtCompact(tP)+"</td><td class=\"r\">"+fmtCompact(tB+tP)+"</td></tr></tfoot></table></div></details>";

  /* ---- cross-check vs the board ---- */
  var recon="";
  if(activeData&&activeData.jobs&&foundationData&&foundationData.jobs){
    var woh=wohRows().filter(function(r){return !r.gc;});
    var leftToBill=woh.reduce(function(s2,r){return s2+((r.contract||0)-(r.billed||0));},0);
    var buildrActiveFwd=0;
    var spA=fcSpread(projects.filter(function(p2){return p2.status==="active";}));
    Object.values(spA.buckets).forEach(function(b3){ buildrActiveFwd+=b3.booked; });
    var d2=buildrActiveFwd-leftToBill;
    recon="<div class=\"vhead\">Cross-check — Buildr vs the board</div>"
      +"<div class=\"vsub\">Buildr <b>active</b> forward revenue = <b>"+fmtCompact(buildrActiveFwd)+"</b> vs Procore/Foundation left-to-bill on the "+woh.length+" board jobs = <b>"+fmtCompact(leftToBill)+"</b> · Δ "+fmtCompact(Math.abs(d2))+". "
      +"They measure the same work differently: Buildr covers every active Buildr project including jobs off the board, and spreads linearly from original schedules; left-to-bill is actuals-based. A large gap points at stale Buildr schedules or board coverage — worth a look, not an alarm.</div>";
  }

  view.innerHTML=strip
    +"<div class=\"vhead\">Pipeline by horizon</div>"
    +"<div class=\"vsub\">What may start, when, at what value and with what confidence — straight from Buildr, which BD maintains. Every row links to its Buildr card; rows for jobs already on the board open the job.</div>"
    +pipeline+undatedSec+periodSec+recon;
  hookDrawerRows();
}

/* ===== Estimating — Bid Board (v2.12.0, BuildingConnected) ===================
   Daily VM pull (bc-bidboard-refresh.js) of the LIVE BC bid board: what's out to bid,
   when it's due, and which trade packages have no bid in and no committed bidder —
   the empty-package scramble surfaced BEFORE bid day instead of on it. */
function daysUntil(ts){ // calendar-day diff in local time — Math.ceil on raw ms rounds past-due-within-24h up to 0 ("TODAY")
  if(!ts) return null; var d=new Date(ts); if(isNaN(d.getTime())) return null; var n=new Date();
  return Math.round((new Date(d.getFullYear(),d.getMonth(),d.getDate())-new Date(n.getFullYear(),n.getMonth(),n.getDate()))/86400000);
}
function bcProjUrl(id){ return id?("https://app.buildingconnected.com/projects/"+id):null; }
function dueChip(ts){
  var d=daysUntil(ts);
  if(d==null) return "<span class=\"pill dot\" style=\"background:#eceff4;color:#7c8699\">no due date</span>";
  if(d<0) return "<span class=\"pill dot\" style=\"background:#eceff4;color:#7c8699\">due "+fmtDate(ts)+" · "+Math.abs(d)+"d ago</span>";
  var cls=d<=7?"r":d<=14?"a":"g";
  return "<span class=\"pill "+cls+" dot\">due "+fmtDate(ts)+" · "+(d===0?"TODAY":"in "+d+"d")+"</span>";
}
function renderEstimating(){
  var view=document.getElementById("view");
  if(!bcData||!Object.prototype.toString.call(bcData.published).includes("Array")){
    view.innerHTML="<div class=\"warn-banner\">⚠️ BuildingConnected bid-board feed unavailable (/ryc-data/bc-bidboard.json) — figures show Unavailable, not $0. The daily VM pull (bc-bidboard) may not have run yet.</div>";
    return;
  }
  var pubs=bcData.published;
  // Active bidding vs past-due-but-never-closed (BC board hygiene — same story as Procore dates)
  var active=pubs.filter(function(p){ var d=daysUntil(p.bidsDueAt); return d==null||d>=-3; });
  var stale=pubs.filter(function(p){ var d=daysUntil(p.bidsDueAt); return d!=null&&d<-3; });
  var next=active.filter(function(p){return daysUntil(p.bidsDueAt)!=null;}).sort(function(a,b){return String(a.bidsDueAt).localeCompare(String(b.bidsDueAt));})[0];
  var atRisk=active.reduce(function(s,p){return s+p.atRisk;},0);
  var closed=bcData.recentClosed||[];
  var won=closed.filter(function(c){return c.awarded==="WON";}).length;
  var lost=closed.filter(function(c){return c.awarded==="LOST";}).length;

  function kpi(l,v,s,cls){ return "<div class=\"kpi\"><div class=\"kl\">"+l+"</div><div class=\"kv "+(cls||"")+"\">"+v+"</div><div class=\"ks\">"+(s||"")+"</div></div>"; }
  var strip="<div class=\"kpi-strip k4\">"
    +kpi("Out to bid",String(active.length),active.reduce(function(s,p){return s+p.packages;},0)+" trade packages"+(bcData.draftCount?" · "+bcData.draftCount+" draft":""),"accent")
    +kpi("Next bid due",next?fmtDate(next.bidsDueAt):"—",next?(esc(next.name.slice(0,36))+" · "+(daysUntil(next.bidsDueAt)===0?"TODAY":"in "+daysUntil(next.bidsDueAt)+"d")):"no dated deadlines",(next&&daysUntil(next.bidsDueAt)<=7)?"warn":"")
    +kpi("Packages at risk",String(atRisk),"no bid in · no committed bidder",atRisk>0?"bad":"")
    +kpi("Win rate (180d)",(won+lost)>0?Math.round(won/(won+lost)*100)+"%":"—",won+" won · "+lost+" lost in BuildingConnected","")
    +"</div>";

  function pkgTable(p){
    var rows=p.pkgs.map(function(k){
      var risk=k.bidsReceived===0&&k.bidding===0&&!k.awardedCompany;
      var st=k.awardedCompany?("<span class=\"m-g\">awarded · "+esc(k.awardedCompany)+"</span>")
        :risk?"<span class=\"m-r\">⚠ at risk</span>"
        :(k.bidsReceived>0?"<span class=\"m-g\">"+k.bidsReceived+" bid"+(k.bidsReceived>1?"s":"")+" in</span>":"<span class=\"m-a\">committed only</span>");
      var tr="<tr class=\"static\""+(risk?" style=\"background:#fdf3f0\"":"")+">"
        +"<td><div class=\"jname\" style=\"font-weight:600\">"+esc(k.name)+"</div><div class=\"jno\">"+esc(k.number||"")+"</div></td>"
        +"<td class=\"r\">"+k.invites+"</td><td class=\"r\">"+(k.bidding||"<span class=\"m-m\">—</span>")+"</td>"
        +"<td class=\"r\">"+(k.undecided||"<span class=\"m-m\">—</span>")+"</td><td class=\"r\">"+(k.notBidding||"<span class=\"m-m\">—</span>")+"</td>"
        +"<td class=\"r\">"+(k.bidsReceived||"<span class=\"m-m\">—</span>")+"</td><td>"+st+"</td></tr>";
      // the call sheet: undecided invitees on an empty package — who to chase, by name
      if(risk&&k.undecidedSubs&&k.undecidedSubs.length){
        tr+="<tr class=\"static\" style=\"background:#fdf3f0\"><td colspan=\"7\" style=\"padding:2px 12px 10px;border-top:none\">"
          +"<span style=\"font-size:11px;font-weight:700;color:#b23c17;letter-spacing:.03em\">CHASE ("+k.undecidedSubs.length+(k.undecided>k.undecidedSubs.length?" of "+k.undecided:"")+"):</span> "
          +"<span style=\"font-size:11.5px;color:#6b4a3a\">"+k.undecidedSubs.map(function(s){return esc(s);}).join(" · ")+"</span></td></tr>";
      }
      return tr;
    }).join("");
    return "<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Trade package</th><th class=\"r\">Invited</th><th class=\"r\">Bidding</th><th class=\"r\">Undecided</th><th class=\"r\">Declined</th><th class=\"r\">Bids in</th><th>Status</th></tr></thead><tbody>"+rows+"</tbody></table></div>";
  }
  function projPanel(p){
    var meta=[p.city?esc(p.city+(p.st?", "+p.st:"")):null,p.architect?("Arch: "+esc(p.architect)):null,p.rfisDueAt?("RFIs due "+fmtDate(p.rfisDueAt)):null,p.jobWalkAt?("Job walk "+fmtDate(p.jobWalkAt)):null].filter(Boolean).join(" · ");
    var covPct=p.packages>0?Math.round(p.covered/p.packages*100):null;
    var covCls=covPct==null?"m-m":covPct>=80?"m-g":covPct>=50?"m-a":"m-r";
    return "<div style=\"background:#fff;border:1px solid #dfe4ec;border-radius:var(--r);padding:16px 20px;margin-bottom:14px\">"
      +"<div style=\"display:flex;flex-wrap:wrap;align-items:center;gap:10px\">"
      +"<div style=\"flex:1 1 260px\"><div class=\"jname\" style=\"font-size:15px\">"+esc(p.name)+srcLink(bcProjUrl(p.id),"BuildingConnected")+"</div>"
      +"<div class=\"jno\" style=\"margin-top:2px\">"+meta+"</div></div>"
      +dueChip(p.bidsDueAt)+"</div>"
      +"<div style=\"margin-top:10px;font-size:12.5px;color:#4a5670\"><b>"+p.packages+"</b> packages · <span class=\""+covCls+"\"><b>"+p.covered+"</b> covered ("+(covPct!=null?covPct+"%":"—")+")</span> · <span class=\""+(p.atRisk>0?"m-r":"m-g")+"\"><b>"+p.atRisk+"</b> at risk</span> · "+p.invites+" invites → "+p.bidding+" bidding · "+p.undecided+" undecided · <b>"+p.bidsReceived+"</b> bids in</div>"
      +"<details"+(p.atRisk>0&&daysUntil(p.bidsDueAt)!=null&&daysUntil(p.bidsDueAt)<=14?" open":"")+" style=\"margin-top:8px\"><summary style=\"cursor:pointer;font-size:12px;color:#67718a\">Trade coverage detail — riskiest first</summary>"+pkgTable(p)+"</details>"
      +"</div>";
  }

  var board=active.length?active.map(projPanel).join(""):"<div class=\"vsub\">Nothing currently out to bid in BuildingConnected.</div>";

  var staleSec=stale.length
    ?("<details class=\"lgcy\"><summary>"+stale.length+" published project"+(stale.length>1?"s":"")+" past bid due and never closed out in BC — board hygiene</summary>"
      +"<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Project</th><th>Bids were due</th><th class=\"r\">Packages</th><th class=\"r\">Bids in</th></tr></thead><tbody>"
      +stale.map(function(p){ return "<tr class=\"static\"><td><div class=\"jname\">"+esc(p.name)+srcLink(bcProjUrl(p.id),"BuildingConnected")+"</div></td><td>"+fmtDate(p.bidsDueAt)+" <span class=\"m-a\">("+Math.abs(daysUntil(p.bidsDueAt))+"d ago)</span></td><td class=\"r\">"+p.packages+"</td><td class=\"r\">"+p.bidsReceived+"</td></tr>"; }).join("")
      +"</tbody></table></div><div class=\"vsub\" style=\"margin-top:6px\">Mark these awarded/closed in BuildingConnected so the board reflects reality — same hygiene story as Procore stage/dates.</div></details>")
    :"";

  var drafts=bcData.draftCount?("<div class=\"vsub\" style=\"margin-top:4px\">✏️ "+bcData.draftCount+" draft (not yet published): "+esc((bcData.draftNames||[]).join(" · "))+"</div>"):"";

  var outcomes=closed.length
    ?("<details class=\"lgcy\"><summary>Recent outcomes — "+won+" won · "+lost+" lost (180 days)</summary>"
      +"<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Project</th><th>Closed</th><th>Result</th><th class=\"r\">Value</th></tr></thead><tbody>"
      +closed.map(function(c){ var b=c.awarded==="WON"?"<span class=\"pill g dot\">Won</span>":c.awarded==="LOST"?"<span class=\"pill r dot\">Lost</span>":"<span class=\"pill dot\" style=\"background:#eceff4;color:#7c8699\">—</span>";
        return "<tr class=\"static\"><td><div class=\"jname\">"+esc(c.name)+srcLink(bcProjUrl(c.id),"BC")+"</div></td><td>"+fmtDate(c.closedAt)+"</td><td>"+b+"</td><td class=\"r\">"+(c.value?fmtCompact(c.value):"—")+"</td></tr>"; }).join("")
      +"</tbody></table></div></details>")
    :"";

  view.innerHTML=strip
    +"<div class=\"vhead\">Bid board — projects out to bid</div>"
    +"<div class=\"vsub\">The company-level preconstruction picture, straight from BuildingConnected (read-only, pulled daily; this pull "+(ageTxt(bcData.generatedAt)||"just now")+"). <b>At risk</b> = a trade package with zero bids received and zero subs committed to bidding — the ones that come in empty on bid day unless someone works the phones. "
      +"<b>Command observes preconstruction; the Estimating Desk does the work</b> — adopting an opportunity, pricing it and recording the outcome all happen there, and nothing on this page edits a pursuit.</div>"
    +board+drafts+staleSec+outcomes;
}

/* ===== Work on Hand (own view since v2.18.0; previously inside the Executive Brief) ===== */
/* Work-on-Hand rows — EXACT legacy conventions (columns/sources per Tristan/Steve 2026-07-07):
   Contract Price = Procore Revised Contract Amount; Total Job Costs = Procore ERP Projected Budget;
   Cost to Date + Billings = FOUNDATION. Cost to Complete = Total Job Costs − Cost to Date.
   + Greencroft program rows (2026-07-20): Foundation-sourced — Contract = Foundation
   current contract, Projected Budget Cost = Foundation as-bid cost + CO cost adj (marked F).
   + optional as-of gate (wohAsOf): Cost to Date / Billings restricted to Foundation
   transactions on/before a user-picked date (live ODBC: v_job_history.date_posted,
   v_em_jc_billings.transaction_date — date_posted per Data Dictionary #10, date_booked
   carries future payroll pay-dates). Contract + Projected Budget are NOT gated. */
var wohSort={col:"contract",dir:-1};
var wohAsOf=null; /* {date:"YYYY-MM-DD", cost:{jobNo:sum}, billed:{jobNo:sum}} */
function wohRows(gated){
  var rows=[];
  var gate=gated?wohAsOf:null; /* gate applies ONLY where explicitly requested (WOH view + its CSV) — the Brief always shows current snapshot figures */
  getActiveJobs().forEach(function(j){
    var f=j.foundation, b=j.budget||{};
    var jno=j.projectNumber||"";
    var contract=(j.revisedContract>0)?j.revisedContract:((j.contractValue>0)?j.contractValue:null);
    var ctd=f?f.totalCosts:null;
    var tec=(b.projectedBudget!=null)?b.projectedBudget:null;
    var fTec=false;
    if(tec==null && j.program==="greencroft" && f){ tec=gcProjCost(f); fTec=tec!=null; } // no ERP budget on Greencroft units — Foundation as-bid + CO cost adj, F-marked
    var billed=f?f.totalInvoiced:null;
    if(gate&&f){ ctd=gate.cost[jno]||0; billed=gate.billed[jno]||0; }
    var ctc=(tec!=null&&ctd!=null)?(tec-ctd):null;
    rows.push({jno:jno,name:j.name||(f&&f.description)||jno,contract:contract,ctd:ctd,ctc:ctc,tec:tec,billed:billed,noTec:tec==null,gc:false,fTec:fTec,pgm:j.program||null,budgetUrl:procoreBudgetUrl(j)});
  });
  greencroftJobs().forEach(function(f){
    var jno=f.jobNo||"";
    var contract=(f.currentContract>0)?f.currentContract:((f.originalContract>0)?f.originalContract:null);
    var ctd=f.totalCosts!=null?f.totalCosts:null;
    var tec=gcProjCost(f);
    var billed=f.totalInvoiced!=null?f.totalInvoiced:null;
    if(gate){ ctd=gate.cost[jno]||0; billed=gate.billed[jno]||0; }
    var ctc=(tec!=null&&ctd!=null)?(tec-ctd):null;
    rows.push({jno:jno,name:f.description||jno,contract:contract,ctd:ctd,ctc:ctc,tec:tec,billed:billed,noTec:tec==null,gc:true,budgetUrl:null});
  });
  var c=wohSort.col,d=wohSort.dir;
  rows.sort(function(a,b2){
    var va=a[c],vb=b2[c];
    if(c==="name"){ va=(va||"").toLowerCase(); vb=(vb||"").toLowerCase(); return va<vb?-d:va>vb?d:0; }
    va=(va==null?-Infinity:va); vb=(vb==null?-Infinity:vb); return (va-vb)*d;
  });
  return rows;
}
function wohSetSort(col){ if(wohSort.col===col) wohSort.dir=-wohSort.dir; else wohSort={col:col,dir:col==="name"?1:-1}; renderView(); }
function wohRunAsOf(){
  var inp=document.getElementById("woh-asof");
  var d=inp?inp.value:"";
  if(!d){ alert("Pick a date first."); return; }
  var today=new Date().toISOString().slice(0,10);
  if(d>today){ alert("Future dates can't be gated — pick "+today+" or earlier."); return; }
  var btn=document.getElementById("woh-run");
  if(btn){ btn.disabled=true; btn.textContent="Running…"; }
  fetch("/api/ryc-foundation-asof",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({date:d})})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if(j&&j.cost){ wohAsOf={date:d,cost:j.cost,billed:j.billed||{}}; renderView(); }
      else { if(btn){ btn.disabled=false; btn.textContent="Run"; } alert("As-of query failed: "+((j&&j.error)||"unknown error")); }
    })
    .catch(function(){ if(btn){ btn.disabled=false; btn.textContent="Run"; } alert("Could not reach the as-of endpoint."); });
}
function wohClearAsOf(){ wohAsOf=null; renderView(); }
function renderWOH(){
  var view=document.getElementById("view");
  var haveFnd=!!(foundationData&&foundationData.jobs);
  var warn=haveFnd?"":"<div class=\"warn-banner\">⚠️ Foundation feed unavailable — Cost to Date / Billings show <b>Unavailable</b>, not $0.</div>";
  var rows=wohRows(true);
  var board=rows.filter(function(r){return !r.gc;}), gc=rows.filter(function(r){return r.gc;});
  var fSnap=(foundationData&&foundationData.refreshed)?new Date(foundationData.refreshed).toLocaleString("en-US",{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):null;
  var missingTec=rows.filter(function(r){return r.noTec;}).length;
  var today=new Date().toISOString().slice(0,10);

  var controls="<div class=\"pbar\" style=\"align-items:center\">"
    +"<button class=\"pfill\" onclick=\"refreshFoundation(this)\" title=\"Re-pull Foundation now — catches posting batches since the snapshot\">&#10227; Refresh Foundation</button>"
    +"<button class=\"pfill\" onclick=\"exportWOHCSV()\" title=\"Download in the Work-on-Hand format (Excel Accounting-style values)\">⬇ CSV</button>"
    +"<span style=\"margin-left:auto;display:flex;gap:6px;align-items:center;font-size:12px;color:#4a5670\">Cost/Billings through "
    +"<input id=\"woh-asof\" type=\"date\" max=\""+today+"\" value=\""+(wohAsOf?wohAsOf.date:"")+"\" style=\"padding:5px 8px;border:1px solid #cfd6e2;border-radius:6px;font:inherit;font-size:12px\">"
    +"<button class=\"pfill\" id=\"woh-run\" onclick=\"wohRunAsOf()\" title=\"Re-query Foundation live, counting only cost posted (date_posted) and billings invoiced (transaction_date) on or before this date\">Run</button>"
    +(wohAsOf?"<button class=\"pfill\" onclick=\"wohClearAsOf()\">✕ Clear</button>":"")
    +"</span></div>";

  /* format the gate date from its parts — new Date("YYYY-MM-DD") parses UTC midnight and
     shows the PREVIOUS day in ET (caught live 2026-07-20: 05-25 rendered "May 24") */
  var asOfLabel=wohAsOf?new Date(wohAsOf.date+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}):null;
  var asOfBanner=wohAsOf
    ?("<div class=\"warn-banner\" style=\"background:#eef4fd;border-color:#b9cff2;color:#27476e\">📅 <b>As-of view — Foundation activity through "+asOfLabel+"</b> (live ODBC: cost by <code>date_posted</code>, billings by <code>transaction_date</code>). <b>Highlighted columns</b> reflect the gate — Cost to Date and Billings are the gated sums; Cost to Complete is recomputed off the gated cost. Contract Price and Projected Budget Cost are current values, not gated.</div>")
    :"";

  /* gated-column tint: when the as-of view is active, the columns whose values the gate
     changes (Cost to Date, Billings = gated sums; Cost to Complete = recomputed off the
     gated cost) carry the banner's blue so the affected numbers are unmistakable */
  var GATED={ctd:1,ctc:1,billed:1};
  function colCls(key,base){ var c=base||""; if(wohAsOf&&GATED[key]) c+=(c?" ":"")+"gated"; return c?(" class=\""+c+"\""):""; }
  var cols=[["name","Project Name"],["contract","Contract Price"],["ctd","Cost to Date"],["ctc","Cost to Complete"],["tec","Projected Budget Cost"],["billed","Billings to Date"]];
  var head="<tr>"+cols.map(function(cd){
    var arr=cd[0]===wohSort.col?(" <span class=\"arr\">"+(wohSort.dir>0?"▲":"▼")+"</span>"):"";
    var gate=(wohAsOf&&GATED[cd[0]])?" <span title=\"Gated to the as-of date\">📅</span>":"";
    return "<th"+colCls(cd[0],cd[0]==="name"?"":"r")+" data-col=\""+cd[0]+"\" style=\"cursor:pointer\" onclick=\"wohSetSort('"+cd[0]+"')\">"+cd[1]+gate+arr+"</th>";
  }).join("")+"</tr>";
  var body=rows.map(function(r){
    return "<tr"+rowAttr(r.jno)+"><td>"+esc(r.name)+((r.gc||r.fTec)?" <span class=\"conf mid\" title=\"Greencroft program — Projected Budget Cost is Foundation-sourced: as-bid cost + CO cost adj (no Procore ERP budget on these units)\">F</span>":srcLink(r.budgetUrl,"Budget"))+"</td>"
      +"<td"+colCls("contract","r")+">"+briefDol(r.contract)+"</td><td"+colCls("ctd","r")+">"+briefDol(r.ctd)+"</td>"
      +"<td"+colCls("ctc","r")+">"+briefDol(r.ctc)+"</td><td"+colCls("tec","r")+">"+briefDol(r.tec)+"</td><td"+colCls("billed","r")+">"+briefDol(r.billed)+"</td></tr>";
  }).join("");
  function sum(list,k){ return list.reduce(function(s,r){return s+(r[k]||0);},0); }
  function footRow(label,list,bold){
    return "<tr"+(bold?" style=\"font-weight:700\"":"")+"><td>"+label+"</td><td"+colCls("contract","r")+">"+briefDol(sum(list,"contract"))+"</td><td"+colCls("ctd","r")+">"+briefDol(sum(list,"ctd"))+"</td><td"+colCls("ctc","r")+">"+briefDol(sum(list,"ctc"))+"</td><td"+colCls("tec","r")+">"+briefDol(sum(list,"tec"))+"</td><td"+colCls("billed","r")+">"+briefDol(sum(list,"billed"))+"</td></tr>";
  }
  var foot=footRow(board.length+" board jobs",board,false)
    +(gc.length?footRow(gc.length+" Greencroft",gc,false):"")
    +footRow(rows.length+" jobs total",rows,true);

  view.innerHTML=warn+controls+asOfBanner
    +"<div class=\"vsub\" style=\"margin-top:4px\">The audit table — reconciles to Foundation <b>as of the nightly snapshot"+(fSnap?" ("+fSnap+")":"")+"</b>. Anything posted in Foundation after that time lands here after the next ~5:00 AM ET refresh — reconciling against live Foundation screens? Check for same-day posting batches first. Click a column header to sort"+(wohAsOf?"":" · default: largest contract first")+".</div>"
    +"<div class=\"ptable-wrap\"><table class=\"ptable\"><thead>"+head+"</thead><tbody>"+body+"</tbody><tfoot>"+foot+"</tfoot></table></div>"
    +"<div style=\"margin-top:10px;font-size:11.5px;color:#67718a\"><b>Contract Price</b> (Revised Contract Amount) &amp; <b>Projected Budget Cost</b> (ERP Projected Budget) from Procore; <b>Cost to Date</b> &amp; <b>Billings to Date</b> from Foundation. Cost to Complete = Projected Budget Cost − Cost to Date. Rows marked <span class=\"conf mid\">F</span> are Greencroft program jobs — Foundation-sourced throughout (Projected Budget Cost = as-bid cost + CO cost adj)."
    +(missingTec?" <b>"+missingTec+"</b> job(s) missing a projected budget — Cost to Complete blank for those.":"")+"</div>";
  hookDrawerRows();
}
/* Work on Hand's money cell: the accounting form plus this view's muted-dash markup. The
   NUMBER rule is shared (RYCFormat.accounting); the presentation stays here because the
   <span class="m-m"> is Command's, not the shell's. WOH is a protected surface — if this
   ever renders differently, scripts/guard-woh-parity.js fails the build. */
function briefDol(n){ return n==null?"<span class=\"m-m\">—</span>":RYCFormat.accounting(n); }
/* CSV export — ported from the legacy dashboard's exportWOHCSV (v1.23.1): values in
   Excel "Accounting" style ( $1,234.56 / $(1,234.56) ), UTF-8 BOM, CRLF. Same file shape. */
function exportWOHCSV(){
  var rows=wohRows(true); /* honors the active as-of gate + current sort */
  var header=["Project Name"," Contract Price "," Cost to Date "," Cost to Complete "," Projected Budget Cost "," Billings to Date "];
  function q(v){ var s=(v==null?"":String(v)); return /[",\n\r]/.test(s)?"\""+s.replace(/"/g,"\"\"")+"\"":s; }
  function acct(n){ if(n==null) return ""; var v=Math.abs(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); return n<0?" $("+v+")":" $"+v+" "; }
  var lines=[header.map(q).join(",")];
  rows.forEach(function(r){ lines.push([r.name,acct(r.contract),acct(r.ctd),acct(r.ctc),acct(r.tec),acct(r.billed)].map(q).join(",")); });
  var csv=String.fromCharCode(0xFEFF)+lines.join("\r\n");
  var blob=new Blob([csv],{type:"text/csv;charset=utf-8;"});
  var url=URL.createObjectURL(blob);
  var d=new Date(); var stamp=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  if(wohAsOf) stamp+="-asof-"+wohAsOf.date;
  var a=document.createElement("a"); a.href=url; a.download="ryc-work-on-hand-"+stamp+".csv";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){URL.revokeObjectURL(url);},1000);
}
function briefPresent(){
  if(document.fullscreenElement){ document.exitFullscreen(); return; }
  document.body.classList.add("present");
  var el=document.documentElement;
  if(el.requestFullscreen) el.requestFullscreen().catch(function(){});
}
document.addEventListener("fullscreenchange",function(){ if(!document.fullscreenElement) document.body.classList.remove("present"); });
function renderBrief(){
  var view=document.getElementById("view");
  var haveFnd=!!(foundationData&&foundationData.jobs), haveAr=!!(arData&&arData.invoices);
  var warn=(!haveFnd||!haveAr)?("<div class=\"warn-banner\">⚠️ "+(!haveFnd?"Foundation":"AR")+" feed unavailable — affected figures show <b>Unavailable</b>, not $0. Do not present until resolved.</div>"):"";
  var jobs=getActiveJobs();
  var gm=projectedGrossMargin();
  var woh=wohRows(); /* ungated — the Brief always reads the current snapshot; incl. Greencroft rows */
  var gcN=woh.filter(function(r){return r.gc;}).length;
  var totalContract=woh.reduce(function(s,r){return s+(r.contract||0);},0);
  var ctcRows=woh.filter(function(r){return r.ctc!=null;});
  var ctcSum=ctcRows.reduce(function(s,r){return s+r.ctc;},0);
  var dateStr=new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"});
  var pAge=ageTxt(activeData&&activeData.refreshed), fAge=ageTxt(foundationData&&foundationData.refreshed);

  /* headline band */
  function sb(l,v,s){ return "<div class=\"sb\"><div class=\"l\">"+l+"</div><div class=\"v\">"+v+"</div><div class=\"s\">"+(s||"")+"</div></div>"; }
  var band="<div class=\"stat-band\">"
    +sb("Active work",String(woh.length)+" jobs",fmtCompact(totalContract)+" under contract — incl. "+(woh.filter(function(r){return r.gc||r.pgm==="greencroft";}).length)+" Greencroft"+(gcN?" ("+gcN+" off-board)":""))
    +sb("Cost to complete",fmtCompact(ctcSum),"remaining on "+ctcRows.length+" costed jobs")
    +sb("Projected gross margin",gm?gm.pct.toFixed(1)+"%":"—",gmSub(gm))
    +sb("Billed to date",haveFnd?fmtCompact(woh.reduce(function(s,r){return s+(r.billed||0);},0)):"Unavailable","Foundation, active jobs")
    +"</div>";

  /* attention list: reds + closeout + biggest fades */
  var lights=jobs.map(function(j){return {j:j,sl:getStoplight(j,j)};});
  var closeouts=lights.filter(function(x){return isCloseoutOnly(x.j);});
  var closeoutSet=new Set(closeouts.map(function(x){return x.j;}));
  var reds=lights.filter(function(x){return x.sl.color==="red"&&!closeoutSet.has(x.j);});
  var fades=gainFadeRows().filter(function(r){return r.src==="erp"&&r.gfPts<=-GF_MOVE_PTS;}).sort(function(a,b){return a.gfPts-b.gfPts;});
  var risks=[];
  reds.forEach(function(x){ risks.push({tag:"red",tl:"Risk",name:x.j.name,text:x.sl.reasons.filter(function(r){return r.level==="red";}).map(function(r){return r.text;}).join(" · ")+" — "+(pmName(x.j)||"(no PM)"),val:fmtCompact(x.j.contractValue)}); });
  closeouts.forEach(function(x){ var f=x.j.foundation||{}; risks.push({tag:"co",tl:"Closeout",name:x.j.name,text:daysPastFinish(x.j)+"d past finish, "+fmtCompact(f.retainage||0)+" retainage held — close out to release cash",val:fmtCompact(x.j.contractValue)}); });
  fades.slice(0,3).forEach(function(r){ risks.push({tag:"fade",tl:"Fade",name:r.name,text:"margin "+r.gfPts.toFixed(1)+" pts vs as-bid"+(r.burnRisk?", cost burn ahead of progress":"")+" — "+r.pm,val:fmtCompact(r.gfDollars)}); });
  var riskHtml=risks.slice(0,7).map(function(r){
    return "<div class=\"risk\"><span class=\"rtag "+r.tag+"\">"+r.tl+"</span><span class=\"rname\">"+esc(r.name)+"</span><span class=\"rtext\">"+esc(r.text)+"</span><span class=\"rval\">"+r.val+"</span></div>";
  }).join("")||"<div class=\"ssub\">Nothing flagged — no red jobs, closeout aging, or material fades.</div>";

  /* cash watchlist */
  var accts=haveFnd?activeAccountRows():[];
  var needsInv=accts.reduce(function(s,r){return s+r.under;},0);
  var over=haveAr?arRows("overdue","active"):[];
  var buckets=[0,0,0,0]; over.forEach(function(v){ buckets[agingBucket(v.daysOverdue||0)]+=(v.openBalance||0); });
  var curOver=buckets[0]+buckets[1], agedOver=buckets[2]+buckets[3];
  var watch=accts.filter(function(r){return r.under>1000||r.overdue>0;}).sort(function(a,b){return (b.under+b.overdue)-(a.under+a.overdue);}).slice(0,5);
  var watchHtml=watch.map(function(r){
    var bits=[]; if(r.under>0) bits.push("needs invoicing "+fmtCompact(r.under)); if(r.overdue>0) bits.push("overdue AR "+fmtCompact(r.overdue));
    return "<div class=\"risk\"><span class=\"rtag cash\">Cash</span><span class=\"rname\">"+esc(r.name)+"</span><span class=\"rtext\">"+esc(bits.join(" · ")+" — "+r.pm)+"</span><span class=\"rval\">"+fmtCompact(r.under+r.overdue)+"</span></div>";
  }).join("");
  var cashSub=haveFnd&&haveAr
    ?("Needs invoicing <b>"+fmtCompact(needsInv)+"</b> · current overdue (≤90d) <b>"+fmtCompact(curOver)+"</b> · aged overdue <b>"+fmtCompact(agedOver)+"</b> · top 5 below — full detail on Billing &amp; Cash.")
    :"Foundation/AR feed unavailable.";

  /* exceptions + provenance */
  var conflicts=jobs.filter(function(j){return (j.flags||[]).some(function(f){return f.type==="contract";});}).length;

  /* Margin movement (section 4): headline + net trusted fade */
  var fadeDollars=fades.reduce(function(s,r){return s+r.gfDollars;},0);
  var marginSec="<div class=\"ssub\">Projected gross margin <b>"+(gm?gm.pct.toFixed(1)+"%":"—")+"</b> ("+gmSub(gm)+")."
    +(fades.length?(" <b>"+fades.length+"</b> job"+(fades.length===1?"":"s")+" fading vs as-bid, net <b>"+fmtCompact(fadeDollars)+"</b> — worst: "+esc(fades[0].name)+" ("+fades[0].gfPts.toFixed(1)+" pts)."):" No trusted-projection fades this week.")
    +"</div>";

  /* Capacity (section 5, sync half): core jobs per PM */
  var pmCount={};
  jobs.forEach(function(j){ var n=pmName(j)||"(no PM)"; pmCount[n]=(pmCount[n]||0)+1; });
  var pmTop=Object.keys(pmCount).map(function(k){return {pm:k,n:pmCount[k]};}).sort(function(a,b){return b.n-a.n;});
  var capSub=pmTop.length?("<b>"+pmTop.length+"</b> PMs across <b>"+jobs.length+"</b> active jobs — heaviest: "+pmTop.slice(0,3).map(function(x){return esc(x.pm)+" ("+x.n+")";}).join(", ")+". Full picture on PM Load."):"—";

  view.innerHTML=warn+"<div class=\"brief\">"
    +"<div class=\"bh\"><div><h1>Executive Brief</h1><div class=\"bsub\">R. Yoder Construction — active work · as of "+dateStr+" · Procore data "+(pAge||"—")+", Foundation "+(fAge||"—")+"<br><span style=\"font-size:11px\">Self-contained by design: this is the printed and presented artifact, so it carries its own totals and links to nothing. The working version, with every item linked to the page that owns it, is Overview.</span></div></div>"
    +"<div class=\"brief-actions\"><button class=\"pfill\" onclick=\"briefPresent()\">🖥 Present</button><button class=\"pfill\" onclick=\"window.print()\">🖨 Print</button></div></div>"
    +"<div class=\"brief-sec\">"+band+"</div>"
    /* R5 #10 ordering: the brief LEADS with what changed, then what needs a decision. */
    +"<div class=\"brief-sec\"><h2>What changed — last 7 days</h2><div id=\"brief-deltas\"><div class=\"ssub\">Computing from nightly snapshots…</div></div></div>"
    +"<div class=\"brief-sec\"><h2>Decisions &amp; attention</h2><div class=\"ssub\">Real risk, aging closeouts, and the biggest trusted margin fades — the week&#8217;s conversation list.</div>"+riskHtml+"</div>"
    +"<div class=\"brief-sec\"><h2>Billing &amp; cash</h2><div class=\"ssub\">"+cashSub+"</div>"+watchHtml+"</div>"
    +"<div class=\"brief-sec\"><h2>Margin movement</h2>"+marginSec+"</div>"
    +"<div class=\"brief-sec\"><h2>Capacity &amp; pipeline</h2><div class=\"ssub\">"+capSub+"</div><div id=\"brief-pipeline\"><div class=\"ssub\">Reading the Estimating Desk…</div></div></div>"
    +"<div class=\"brief-foot\">"+(conflicts?("<b>"+conflicts+"</b> contract conflict(s) between Procore and Foundation are open — see Margin &amp; Risk → Data exceptions before quoting those jobs. "):"Procore and Foundation contracts agree on every active job. ")
    +"The Work-on-Hand Analysis table lives on the <b>Work on Hand</b> view (sortable, as-of date gate, CSV). "
    +"Decision-layer figures (margins, stoplights, gain/fade) are forecasts; source-of-record figures (cost, billings, AR, Work-on-Hand) mirror Foundation. Full provenance: RYC_Dashboard_Data_Dictionary.md.</div>"
    +"</div>";
  hookDrawerRows();
  fillBriefDeltas();
  fillBriefPipeline();
}

/* Brief section 1 — the same typed delta data the Overview renders (one computation, R5 #6). */
function fillBriefDeltas(){
  computeDeltas(function(d){
    var el=document.getElementById("brief-deltas"); if(!el) return;
    if(!d){ el.innerHTML="<div class=\"ssub\">No snapshot history available for a 7-day comparison.</div>"; return; }
    var lines=[];
    lines.push("<b>"+fmtCompact(d.billed)+"</b> billed · <b>"+fmtCompact(d.cost)+"</b> cost recorded (baseline run "+d.baseLabel+")");
    if(d.newJobs.length) lines.push("<b>New:</b> "+d.newJobs.slice(0,4).map(function(c){return esc(c.description||c.jobNo)+" ("+fmtCompact(c.currentContract||c.originalContract)+")";}).join(" · "));
    if(d.closed.length) lines.push("<b>Closed:</b> "+d.closed.slice(0,4).map(function(o){return esc(o.description||o.jobNo);}).join(" · "));
    if(d.contractChanges.length) lines.push("<b>Contract changes:</b> "+d.contractChanges.slice(0,4).map(function(x){return esc(x.j.description||x.j.jobNo)+" "+(x.d>0?"+":"")+fmtCompact(x.d);}).join(" · "));
    if(!d.comparable) lines.push("<b>Coverage caveat:</b> baseline and current snapshots differ in coverage ("+d.oldN+" vs "+d.curN+" jobs) — new/closed not classified; $ figures cover the "+d.shared+" jobs in both.");
    el.innerHTML=lines.map(function(l){return "<div class=\"ssub\">"+l+"</div>";}).join("");
  });
}
/* Overview's Desk line — the same cross-workspace read the Brief uses, into its own node.
   One loader, two mount points: a second copy would be a second thing to keep in step. */
function fillOverviewPipeline(){ return deskPipelineInto("brief-pipeline-mini"); }
/* Brief section 5b — the Desk's open pipeline (cross-workspace read; leadership-safe summary). */
function fillBriefPipeline(){ return deskPipelineInto("brief-pipeline"); }
function deskPipelineInto(nodeId){
  RYCAuth.post("list").then(function(rr){
      var d=rr.ok?rr.data:null;
      var el=document.getElementById(nodeId); if(!el) return;
      if(!d||!d.ok){ el.innerHTML=""; return; }
      var pursuits=d.pursuits||[], runs=d.runs||[];
      var latestByP={};
      runs.forEach(function(r){ var k=r.pursuit_id; if(k&&(!latestByP[k]||(r.created_at||"")>(latestByP[k].created_at||""))) latestByP[k]=r; });
      var open=pursuits.filter(function(p){ var st=(p.workflow||{}).stage||"takeoff"; return st!=="won"&&st!=="lost"; });
      var dueSoon=open.filter(function(p){ var dd=(p.workflow||{}).due_date; if(!dd) return false; var days=(new Date(dd+"T23:59:59")-Date.now())/86400000; return days<=7; });
      var val=open.reduce(function(s,p){ var lr=latestByP[p.id]; return s+((lr&&lr.cost_mid)||0); },0);
      var decided=pursuits.filter(function(p){ var st=(p.workflow||{}).stage; return st==="won"||st==="lost"; });
      var won=decided.filter(function(p){ return (p.workflow||{}).stage==="won"; }).length;
      el.innerHTML="<div class=\"ssub\"><b>Estimating Desk:</b> "+open.length+" open pursuit"+(open.length===1?"":"s")
        +(val?(" (~"+fmtCompact(val)+" conceptual)"):"")
        +(dueSoon.length?(" · <b>"+dueSoon.length+"</b> due within 7 days"):"")
        +(decided.length?(" · record to date "+won+"W–"+(decided.length-won)+"L"):" · no decided bids yet")
        +".</div>";
    }).catch(function(){ var el=document.getElementById(nodeId); if(el) el.innerHTML=""; });
}

/* ===== Job detail drawer (Phase 3a — existing data only; commitments arrive in 3b) ===== */
function jobByNo(jno){
  var jobs=(activeData&&activeData.jobs)||[];
  for(var i=0;i<jobs.length;i++){ if(String(jobs[i].projectNumber||"").trim()===String(jno).trim()) return jobs[i]; }
  return null;
}
function reconRow(label,pv,fv,fmtFn){
  var f=fmtFn||fmtCompact;
  var pTxt=(pv!=null&&pv!==0)?f(pv):"—", fTxt=(fv!=null&&fv!==0)?f(fv):"—";
  if(pv==null||fv==null||pv===0||fv===0) return "<tr><td>"+label+"</td><td class=\"r\">"+pTxt+"</td><td class=\"r\">"+fTxt+"</td><td class=\"r\">—</td></tr>";
  var d=pv-fv, big=Math.abs(d)>50000&&Math.abs(d)>Math.max(Math.abs(pv),Math.abs(fv))*0.02;
  var dTxt=big?("<span title=\"Diverges — reconcile\">⚑ "+fmtCompact(d)+"</span>"):("✓ "+(Math.abs(d)<1000?"match":fmtCompact(d)));
  return "<tr><td>"+label+"</td><td class=\"r\">"+pTxt+"</td><td class=\"r\">"+fTxt+"</td><td class=\"r "+(big?"dv":"ok")+"\">"+dTxt+"</td></tr>";
}
function jobSections(j){
  var f=j.foundation||null, b=j.budget||{}, sl=getStoplight(j,j);
  var status=isCloseoutOnly(j)?"closeout":sl.color;
  var reasons=sl.reasons.map(function(r){return r.text;}).join(" · ");
  var bill=billingByJob()[String(j.projectNumber)]||null;
  var gf=gainFadeFor(j);
  // Suspect-aware here too (Codex R4 #6: the drawer showed a raw fake-high "Proj. margin"
  // while the Portfolio row for the same job was ungraded, and its ⚑ checked only the
  // producer flag). One trust rule everywhere: projMarginSuspect().
  var mtdSus=projMarginSuspect(j), mtd=mtdSus?null:projectedMargin(j), cm=asBidMargin(j), burn=contractLessCostToDatePct(j);
  var dpf=daysPastFinish(j);
  var pAge=ageTxt(activeData&&activeData.refreshed), fAge=ageTxt(foundationData&&foundationData.refreshed), aAge=ageTxt(arData&&arData.refreshed);

  /* header */
  var subBits=[esc(j.projectNumber||"")];
  if(j.client) subBits.push(esc(j.client));
  if(pmName(j)) subBits.push("PM "+esc(pmName(j)));
  if(j.superintendent&&j.superintendent.name) subBits.push("Super "+esc(j.superintendent.name));
  var head="<div class=\"dw-head\"><div><h3>"+esc(j.name||"")+"</h3>"
    +"<div class=\"dw-sub\">"+subBits.join(" · ")+(j.address?"<br>"+esc(j.address):"")+"</div>"
    +"<div style=\"margin-top:8px\">"+statusPill(status,reasons)+" <span style=\"color:#67718a;font-size:11.5px;margin-left:6px\">"+esc(j.stage||"")+(stageConflict(j)?" <span title=\"Stage is stale — job shows real cost activity\" style=\"color:#c07f1a\">⚑</span>":"")+"</span>"
    +srcLink(procoreUrl(j),"Procore")+srcLink(buildrUrl(buildrIdFor(j.projectNumber)),"Buildr")+"</div>"
    +(reasons?"<div class=\"dw-reason\">"+esc(reasons)+"</div>":"")
    +"</div><button class=\"dw-close\" onclick=\"closeDrawer()\" aria-label=\"Close\">&times;</button></div>";

  /* financial snapshot */
  function stat(l,v,s){ return "<div class=\"dw-stat\"><div class=\"l\">"+l+"</div><div class=\"v\">"+v+"</div>"+(s?"<div class=\"s\">"+s+"</div>":"")+"</div>"; }
  var snap="<div class=\"dw-sec\"><h4>Financial snapshot</h4><div class=\"dw-stats\">"
    +stat("Contract",fmtCompact(j.contractValue),j.revisedContract>0?"Procore revised":"Foundation")
    // burn belongs here, beside the dollars it describes — not masquerading as margin
    +stat("Cost to date",j.costToDate!=null?fmtCompact(j.costToDate):"—",(f?"Foundation actuals":"Procore direct")+(burn!=null?" · "+(100-burn).toFixed(0)+"% of contract spent":""))
    +stat("Complete",j.pctComplete!=null?Math.round(j.pctComplete)+"%":"—",dpf>0?dpf+"d past finish":"")
    +stat("Proj. margin",(function(){var g=marginGrade(mtd,mtdSus);return "<span class=\""+g.cls+"\">"+(mtdSus?"⚑":(mtd!=null?mtd.toFixed(1)+"%":"—"))+"</span>";})(),
      (mtdSus?"projection unverified — not graded":[(cm!=null?"as-bid "+cm.toFixed(1)+"%":null),
        (mtd!=null&&cm!=null?((mtd-cm)>=0?"+":"")+(mtd-cm).toFixed(1)+" pts":null),
        marginGrade(mtd,mtdSus).word].filter(Boolean).join(" · ")))
    +stat("Proj. cost (ERP)",b.projectedCost>0?fmtCompact(b.projectedCost):"—",mtdSus&&b.projectedCost>0?"⚑ verify — outside trust band or below cost to date":"")
    +stat("Gain / fade",gf?(gf.gfPts>=0?"+":"")+gf.gfPts.toFixed(1)+" pts":"—",gf?((gf.src==="recon"?"≈ budget-based scenario · ":"")+fmtCompact(gf.gfDollars)+(gf.burnRisk?" · cost-burn risk":"")):"insufficient data")
    +"</div></div>"
    +"<div id=\"bid-record\"></div>";

  /* Procore vs Foundation reconciliation */
  var recon;
  if(f){
    recon="<div class=\"dw-sec\"><h4>Procore ⇄ Foundation reconciliation</h4>"
      +"<table class=\"dwt\"><tr><th></th><th class=\"r\">Procore</th><th class=\"r\">Foundation</th><th class=\"r\">Δ</th></tr>"
      +reconRow("Contract",j.revisedContract>0?j.revisedContract:null,f.currentContract)
      +reconRow("Original contract",j.procoreContractValue,f.originalContract)
      +reconRow("Cost to date",b.direct,f.totalCosts)
      +reconRow("Original budget / cost",b.original,f.originalCost)
      +reconRow("CO net value",(j.changeOrders&&j.changeOrders.netValue)||null,(f.changeOrders&&f.changeOrders.incomeAdj)||null)
      +"</table><div class=\"dw-note\">⚑ = diverges by more than $50K and 2% — reconcile before quoting either number. Procore cost is budget direct; Foundation cost is posted job cost (all classes, no committed).</div></div>";
  } else {
    recon="<div class=\"dw-sec\"><h4>Procore ⇄ Foundation reconciliation</h4><div class=\"dw-note\">No Foundation match for job number "+esc(j.projectNumber||"—")+" — Procore-only job. Financials here are Procore budget figures, unverified by accounting.</div></div>";
  }

  /* billing & AR */
  var billing="";
  if(f){
    var invs=((arData&&arData.invoices)||[]).filter(function(v){ return String(v.jobNo||"")===String(j.projectNumber) && (v.category==="overdue"||v.category==="open") && (v.openBalance||0)>0; })
      .sort(function(a,c){ return (c.daysOverdue||0)-(a.daysOverdue||0); });
    var invRows=invs.slice(0,12).map(function(v){
      var od=(v.daysOverdue||0)>0;
      return "<tr><td>"+esc(v.payApp?("Pay app "+v.payApp):("Inv "+(v.invoiceNo||"")))+"</td><td>"+fmtDate(v.invoiceDate)+"</td><td>"+fmtDate(v.dueDate)+"</td>"
        +"<td class=\"r\">"+fmtCompact(v.openBalance)+"</td><td class=\"r "+(od?"dv":"")+"\">"+(od?(v.daysOverdue+"d overdue"):"current")+"</td></tr>";
    }).join("");
    billing="<div class=\"dw-sec\"><h4>Billing &amp; AR</h4><div class=\"dw-stats\">"
      +stat("Billed to date",fmtCompact(f.totalInvoiced||0),"")
      +stat("Needs invoicing",bill?fmtCompact(bill.under):"—",bill?(bill.exact?"exact (OH/Profit markups)":"bid-est fallback"):"")
      +stat("Retainage held",fmtCompact(f.retainage||0),"")
      +"</div>"
      +(invs.length?("<table class=\"dwt\" style=\"margin-top:10px\"><tr><th>Invoice</th><th>Invoiced</th><th>Due</th><th class=\"r\">Open balance</th><th class=\"r\">Age</th></tr>"+invRows+"</table>"
        +(invs.length>12?"<div class=\"dw-note\">+ "+(invs.length-12)+" more open invoices.</div>":"")):"<div class=\"dw-note\" style=\"margin-top:8px\">No open or overdue invoices.</div>")
      +"</div>";
  }

  /* commitments / buyout (Procore v1.1 contracts — unlocked 2026-07-07, Phase 3b) */
  var buyout="";
  var cm2=j.commitments;
  if(cm2&&cm2.count>0){
    var costBudget=(b.revised>0?b.revised:(b.original>0?b.original:null));
    var uncommitted=(costBudget!=null)?(costBudget-cm2.committedTotal):null;
    var covPct=(costBudget>0)?(cm2.committedTotal/costBudget*100):null;
    var cRows=(cm2.rows||[]).slice(0,10).map(function(r){
      return "<tr><td>"+esc(r.vendor||r.title||"—")+(r.vendor?"<div class=\"cell-sub\" style=\"white-space:normal\">"+esc(r.title||"")+"</div>":"")+"</td>"
        +"<td>"+(r.kind==="po"?"PO":"Sub")+"</td><td>"+esc(r.status||"—")+"</td>"
        +"<td class=\"r\">"+fmtCompact(r.total)+"</td></tr>";
    }).join("");
    var more=cm2.rows.length>10?("<div class=\"dw-note\">+ "+(cm2.rows.length-10)+" more commitments totaling "+fmtCompact(cm2.rows.slice(10).reduce(function(s,r){return s+r.total;},0))+".</div>"):"";
    buyout="<div class=\"dw-sec\"><h4>Commitments &amp; buyout (Procore)</h4><div class=\"dw-stats\">"
      +stat("Committed",fmtCompact(cm2.committedTotal),cm2.subcontracts+" subs · "+cm2.purchaseOrders+" POs"+(cm2.pendingTotal>0?" · <b>"+fmtCompact(cm2.pendingTotal)+" in flight</b>":""))
      +stat("Uncommitted budget",uncommitted!=null?fmtCompact(uncommitted):"—",costBudget!=null?"of "+fmtCompact(costBudget)+" cost budget":"no budget")
      +stat("Buyout coverage",covPct!=null?covPct.toFixed(0)+"%":"—","committed / cost budget")
      +"</div>"
      +"<table class=\"dwt\" style=\"margin-top:10px\"><tr><th>Vendor / commitment</th><th>Type</th><th>Status</th><th class=\"r\">Committed</th></tr>"+cRows+"</table>"+more
      +"<div class=\"dw-note\">Committed = Approved/Complete contracts at revised value (approved CCOs included); \"in flight\" = out for signature / processing. Uncommitted budget includes RYC-carried costs — RYC self-performs nothing, so on a fully bought-out job this trends toward general conditions. Sub pay apps live in Foundation, not Procore.</div></div>";
  } else if(!j.commitmentsTracked){
    buyout="<div class=\"dw-sec\"><h4>Commitments &amp; buyout (Procore)</h4><div class=\"dw-note\">No commitment data for this job yet — buyout pull runs with the nightly Procore refresh (unlocked 2026-07-07).</div></div>";
  }

  /* subs on this job (inverted from the nightly Foundation actual-by-vendor rollup) */
  var jobSubsSec="";
  var jn=String(j.projectNumber||"");
  var jobSubs=jn?((subsData&&subsData.subs)||[]).map(function(sv){
    var hit=(sv.jobs||[]).filter(function(x){ return String(x.jobNo)===jn; })[0];
    return hit?{name:sv.name,actual:hit.actual||0,committed:hit.committed||0}:null;
  }).filter(function(x){ return x&&(x.actual>0||x.committed>0); })
    .sort(function(a,c){ return c.actual-a.actual; }):[];
  if(jobSubs.length){
    var jsRows=jobSubs.slice(0,12).map(function(sv){
      var v=(sv.committed>0&&sv.actual>0)?(sv.committed-sv.actual):null;
      return "<tr><td>"+esc(sv.name)+"</td><td class=\"r\">"+(sv.committed?fmtCompact(sv.committed):"—")+"</td><td class=\"r\">"+fmtCompact(sv.actual)+"</td><td class=\"r\">"+(v==null?"—":((v>=0?"+":"")+fmtCompact(v)))+"</td></tr>";
    }).join("");
    jobSubsSec="<div class=\"dw-sec\"><h4>Subcontractors on this job (Foundation actual)</h4>"
      +"<table class=\"dwt\"><tr><th>Subcontractor</th><th class=\"r\">Committed</th><th class=\"r\">Actual</th><th class=\"r\">Δ</th></tr>"+jsRows+"</table>"
      +"<div class=\"dw-note\">"+(jobSubs.length>12?("Top 12 of "+jobSubs.length+" shown. "):"")+"Posted vendor cost from the nightly rollup (each vendor's top jobs — small line items may be missing). Full ledger: Subcontractors view.</div></div>";
  }

  /* cost breakdown (Foundation, by class) */
  var costSec="";
  if(f&&f.costBreakdown){
    var cbKeys=Object.keys(f.costBreakdown).sort(function(a,c){ return f.costBreakdown[c]-f.costBreakdown[a]; });
    var cbTotal=cbKeys.reduce(function(s,k){ return s+(f.costBreakdown[k]||0); },0);
    if(cbTotal>0){
      var cbRows=cbKeys.map(function(k){ var v=f.costBreakdown[k]||0; return "<tr><td>"+esc(k)+"</td><td class=\"r\">"+fmtCompact(v)+"</td><td class=\"r\">"+(v/cbTotal*100).toFixed(0)+"%</td></tr>"; }).join("");
      costSec="<div class=\"dw-sec\"><h4>Cost to date by class (Foundation)</h4><table class=\"dwt\"><tr><th>Class</th><th class=\"r\">Posted</th><th class=\"r\">Share</th></tr>"+cbRows+"</table></div>";
    }
  }

  /* change orders */
  var coSec="";
  var co=j.changeOrders;
  if((co&&co.count)||(f&&f.changeOrders&&f.changeOrders.count)){
    var chips="";
    if(co&&co.byType){ chips=Object.keys(co.byType).map(function(k){ return "<span class=\"dw-chip\">"+esc(k)+" &middot; "+co.byType[k]+"</span>"; }).join(""); }
    coSec="<div class=\"dw-sec\"><h4>Change orders</h4><div class=\"dw-stats\">"
      +stat("Procore COs",co?String(co.count):"—",co?("net "+fmtCompact(co.netValue||0)):"")
      +stat("Foundation CO income",f&&f.changeOrders?fmtCompact(f.changeOrders.incomeAdj||0):"—",f&&f.changeOrders?(f.changeOrders.count+" posted"):"")
      +stat("Foundation CO cost",f&&f.changeOrders?fmtCompact(f.changeOrders.costAdj||0):"—","")
      +"</div>"+(chips?"<div style=\"margin-top:9px\">"+chips+"</div>":"")+"</div>";
  }

  /* field & schedule */
  var field="<div class=\"dw-sec\"><h4>Field &amp; schedule (Procore)</h4><div class=\"dw-stats\">"
    +stat("Start",fmtDate(j.start),"")
    +stat("Projected finish",fmtDate(j.projectedFinish||j.completionDate),dpf>0?("<span style=\"color:#c07f1a\">"+dpf+"d past</span>"):(j.projectedFinish?Math.abs(dpf)+"d out":""))
    +stat("RFIs open",j.rfis?(j.rfis.open+" <span style=\"color:#8b95ab;font-size:12px\">/ "+j.rfis.total+"</span>"):"—","")
    +stat("Submittals open",j.submittals?(j.submittals.open+" <span style=\"color:#8b95ab;font-size:12px\">/ "+j.submittals.total+"</span>"):"—","")
    +stat("Work type",esc(RYCTaxonomy.workLabel(RYCTaxonomy.classify(j).workType)),"")
    +stat("Sector",esc(RYCTaxonomy.sectorLabel(RYCTaxonomy.classify(j).sector)),"")
    +"</div></div>";

  /* source trail */
  var trail="<div class=\"dw-sec\"><h4>Source trail</h4><table class=\"dwt\">"
    +"<tr><th>Fields</th><th>Source</th><th class=\"r\">Data age</th></tr>"
    +"<tr><td>Contract (revised)</td><td>Procore prime contract</td><td class=\"r\">"+(pAge||"—")+"</td></tr>"
    +"<tr><td>Cost, billed, retainage, PM, CO postings</td><td>Foundation nightly ODBC</td><td class=\"r\">"+(fAge||"—")+"</td></tr>"
    +"<tr><td>Open / overdue invoices</td><td>Foundation AR feed</td><td class=\"r\">"+(aAge||"—")+"</td></tr>"
    +"<tr><td>Schedule, %, RFIs, submittals, CO types</td><td>Procore daily cache</td><td class=\"r\">"+(pAge||"—")+"</td></tr>"
    +"<tr><td>Commitments / buyout</td><td>Procore sub + PO contracts (daily cache)</td><td class=\"r\">"+(pAge||"—")+"</td></tr>"
    +"</table><div class=\"dw-note\">Full field-by-field provenance: <a href=\"#\" onclick=\"closeDrawer();setView(&quot;trust&quot;);return false\" style=\"color:var(--accent);font-weight:600\">Data Trust</a>.</div></div>";

  return { head:head, snap:snap, recon:recon, billing:billing, buyout:buyout,
           subs:jobSubsSec, cost:costSec, co:coSec, field:field, trail:trail,
           status:status, reasons:reasons };
}

/* ===== 3.2 — the drawer is a PREVIEW; the page is where the depth lives =================
   The drawer had grown into nine stacked sections: reconciliation, every open invoice, every
   commitment, every sub, cost by class, change orders, field stats and a source trail. That is
   a full job page compressed into a sidebar, and it is the "no drawer should require scrolling
   through invoices, commitments, subcontractors, classes, change orders, field status and
   provenance in one stream" the brief names.

   Same content, two depths, ONE set of builders — so the preview can never quietly disagree
   with the page. The drawer answers "is this the job I meant, and is it in trouble?"; the page
   answers everything else, at an address that can be linked, refreshed and bookmarked.

   This also completes the half of 1.2 that was deferred: the preview cap now has a real
   destination to escape to. */
function drawerHtml(j){
  var x=jobSections(j);
  /* The button is unconditional. It used to be gated on jobUrl() already having an id, which
     meant it silently vanished whenever the id cache had not landed — a control that appears
     or not depending on a background fetch is worse than one that resolves on click. */
  var more="<div class=\"dw-sec\"><h4>Full detail</h4>"
    +"<div class=\"dw-note\">Reconciliation, open invoices, commitments, subcontractors, cost by class, change orders, field status and the source trail all live on the job page — this drawer is a preview so it stays scannable.</div>"
    +"<div style=\"margin-top:10px\">"
    +"<button class=\"pfill\" onclick=\"goJobPage('"+attrEsc(String(j.projectNumber))+"')\">Open the full job page &rarr;</button>"
    +"</div></div>";
  return x.head+"<div class=\"dw-body\">"+x.snap+more+"</div>";
}

/* The full page. Sections in the order the brief specifies, each one a real heading rather than
   another block in an unbounded scroll. */
function jobPageHtml(j){
  var x=jobSections(j);
  var back="<div style=\"margin-bottom:12px\"><button class=\"pfill\" onclick=\"goCommandView('portfolio')\">&larr; Portfolio</button>"
    +srcLink(procoreUrl(j),"Procore")+srcLink(buildrUrl(buildrIdFor(j.projectNumber)),"Buildr")+"</div>";
  var head="<div class=\"jobpage-head\"><h2>"+esc(j.name||"")+"</h2>"
    +"<div class=\"jobpage-sub\">"+esc(j.projectNumber||"")
    +(j.client?" · "+esc(j.client):"")+(pmName(j)?" · PM "+esc(pmName(j)):"")
    +(j.superintendent&&j.superintendent.name?" · Super "+esc(j.superintendent.name):"")
    +(j.address?"<br>"+esc(j.address):"")+"</div>"
    +"<div style=\"margin-top:8px\">"+statusPill(x.status,x.reasons)
    +" <span style=\"color:#67718a;font-size:11.5px;margin-left:6px\">"+esc(j.stage||"")+"</span></div>"
    +(x.reasons?"<div class=\"dw-reason\" style=\"margin-top:8px\">"+esc(x.reasons)+"</div>":"")
    +"</div>";
  return back+head+"<div class=\"jobpage\">"
    +x.snap+x.recon+x.billing+x.buyout+x.subs+x.cost+x.co+x.field+x.trail+"</div>";
}

function openDrawer(jno,trigger){
  var j=jobByNo(jno); if(!j) return;
  closeDrawer(true);
  // A job is an addressable thing (contract §3): opening one puts it in the URL by its
  // IMMUTABLE id, so it can be linked, refreshed and backed out of like any other page.
  if(typeof jobUrl==="function" && !window._dwRouting){
    var u=jobUrl(jno);
    if(u && location.pathname!==u) history.pushState({job:jno},"",u);
  }
  var wrap=document.createElement("div"); wrap.id="dwrap";
  wrap.innerHTML="<div class=\"dw-overlay\" onclick=\"closeDrawer()\"></div><aside class=\"drawer\" role=\"dialog\" aria-modal=\"true\" aria-label=\"Job detail: "+attrEsc(j.name||jno)+"\">"+drawerHtml(j)+"</aside>";
  document.body.appendChild(wrap);
  // Focus trap, Escape, background scroll lock and focus restore are the shell's (program 1.2).
  RYCDrawer.mount(wrap,{trigger:trigger||null,onClose:onDrawerClosed});
  loadBidRecord(jno);
}

/* Step 5 — the award seam read back the other way: an awarded job shows WHAT RYC BID IT AT.
   First consumer of the Desk's by_job lookup (Codex round-3 noted it had none). Silent when
   the job has no linked pursuit — most jobs predate the Desk. */
var _bidRecCache={};
function loadBidRecord(jno){
  var el=document.getElementById("bid-record"); if(!el) return;
  if(_bidRecCache[jno]!==undefined){ el.innerHTML=_bidRecCache[jno]; return; }
  RYCAuth.post("by_job",{job_no:String(jno)}).then(function(rr){
      // Don't CACHE an outage as "this job has no bid record" — an unreachable lookup is not
      // an authoritative empty answer, and a cached one never retries (finding #5).
      if(!rr.ok){ el.innerHTML=""; return; }
      var d=rr.data;
      var p=d&&d.ok&&d.pursuits&&d.pursuits[0];
      if(!p||!p.latest){ _bidRecCache[jno]=""; el.innerHTML=""; return; }
      var wf=p.workflow||{}, sub=wf.submission||{}, aw=wf.award||{};
      var j=jobByNo(jno), f=j&&j.foundation;
      var conceptual=p.latest.cost_mid||null;
      // THREE separate stories, never collapsed (R5 #5): estimating drift (conceptual→submitted),
      // award variance (submitted→ORIGINAL contract), contract growth (original→current, COs).
      var origContract=(f&&f.originalContract>0)?f.originalContract:((j&&j.procoreContractValue>0)?j.procoreContractValue:null);
      var basis=sub.amount||null;
      var awardVar=(basis&&origContract)?((origContract-basis)/basis*100):null;
      // Implausible link quarantine: a legitimate award lands near the bid; a wild ratio means
      // the pursuit is probably linked to the WRONG job — flag it and grade nothing.
      var suspectLink=awardVar!=null&&Math.abs(awardVar)>25;
      var rows="";
      function br(l,v,s){ return "<tr><td>"+l+"</td><td class=\"r\">"+v+"</td><td class=\"r\" style=\"color:var(--faint)\">"+(s||"")+"</td></tr>"; }
      function pctTxt(x){ return (x>=0?"+":"")+x.toFixed(1)+"%"; }
      if(conceptual) rows+=br("Conceptual estimate",fmt(conceptual),(p.revisions&&p.revisions.length>1)?(p.revisions.length+" revisions"):"");
      if(sub.amount) rows+=br("Submitted bid",fmt(sub.amount),(sub.at||"").slice(0,10)+(conceptual?(" · estimating drift "+pctTxt((sub.amount-conceptual)/conceptual*100)):""));
      if(origContract) rows+=br("Original contract",fmt(origContract),suspectLink?"":(basis?("award variance "+pctTxt(awardVar)+" vs bid"):"no submitted bid recorded — not compared"));
      if(j&&j.contractValue>0&&origContract) rows+=br("Current contract",fmt(j.contractValue),"contract growth "+pctTxt((j.contractValue-origContract)/origContract*100)+" since award (COs)");
      var warn=suspectLink?"<div class=\"dw-note\" style=\"color:var(--amber)\"><b>⚠ Possible wrong job link</b> — the original contract is "+pctTxt(awardVar)+" vs the submitted bid, far outside a plausible award. Excluded from calibration reads; verify the award link on the pursuit (legitimate scope changes can be confirmed there).</div>":"";
      _bidRecCache[jno]="<div class=\"dw-sec\"><h4>Bid record — from the Estimating Desk</h4>"
        +"<table class=\"dwt\"><tr><th></th><th class=\"r\">Amount</th><th class=\"r\"></th></tr>"+rows+"</table>"+warn
        +"<div class=\"dw-note\">Linked "+((aw.linked_at||"").slice(0,10)||"—")+(p.latest.estimator?(" · estimated by "+esc(p.latest.estimator)):"")
        +" · <a class=\"srclink\" href=\"/desk/pursuits/"+p.id+"\" target=\"_blank\" rel=\"noopener\">Open pursuit &#8599;</a></div></div>";
      el.innerHTML=_bidRecCache[jno];
    }).catch(function(){ el.innerHTML=""; });
}
/* Leaving the job leaves its address — but only when the USER closed it, not when the
   router is swapping views (which is already writing the correct URL itself). This is the
   one piece of drawer behaviour that is Command's rather than the shell's. */
function onDrawerClosed(){
  if(!window._dwRouting && typeof currentView!=="undefined" && /^\/command\/jobs\//.test(location.pathname)){
    history.pushState({},"","/command/"+currentView);
  }
}
function closeDrawer(silent){ RYCDrawer.dismiss({silent:!!silent}); }


/* ===== Subcontractors (v2.23.0) — Foundation actual-by-vendor + PO_Sub subcontracts,
   2023+ jobs (/ryc-data/ryc-subcontractors.json, nightly VM rollup). Ported from the legacy
   dashboard's Subcontractors view — the one cutover gap (caught 2026-07-27): spend-ranked
   vendor ledger + per-sub job-history drawer. ===== */
var subsShowAll=false;
function toggleSubsAll(){ subsShowAll=!subsShowAll; renderSubs(); }
/* CURRENT = the sub is on a job the ACTIVE BOARD carries. "Where are they working now" is
   the operational question a spend ranking cannot answer; an all-time job count answers a
   different one (usability program 3.4). jobByNo() is the same board-membership test the
   rest of Command uses, so this can never drift from what Portfolio calls active. */
function subJobSplit(s){
  var cur=[], hist=[];
  (s.jobs||[]).forEach(function(jj){ (jobByNo(jj.jobNo)?cur:hist).push(jj); });
  cur.sort(function(a,b){ return (b.actual||0)-(a.actual||0); });
  hist.sort(function(a,b){ return (b.actual||0)-(a.actual||0); });
  return {cur:cur, hist:hist};
}
function subCurrentCount(s){
  var n=subJobSplit(s).cur.length;
  return n?("<b>"+n+"</b>"):"<span class=\"m-m\">0</span>";
}
function subDeltaCell(d){ return d==null?"<span class=\"m-m\">—</span>":"<span class=\""+(d<0?"m-r":"m-g")+"\">"+(d>=0?"+":"")+fmtCompact(d)+"</span>"; }
function renderSubs(){
  var view=document.getElementById("view");
  if(!subsData||!subsData.subs||!subsData.subs.length){
    view.innerHTML="<div class=\"warn-banner\">&#9888;&#65039; Subcontractor rollup unavailable (/ryc-data/ryc-subcontractors.json) — the nightly Foundation vendor pull hasn't landed. Figures show Unavailable, not $0.</div>";
    return;
  }
  var subs=subsData.subs;
  function kpi(l,v,s,cls){ return "<div class=\"kpi\"><div class=\"kl\">"+l+"</div><div class=\"kv "+(cls||"")+"\">"+v+"</div><div class=\"ks\">"+(s||"")+"</div></div>"; }
  var strip="<div class=\"kpi-strip k4\">"
    +kpi("Sub spend (actual)",fmtCompact(subsData.totalActual),"booked in Foundation · 2023+ jobs","")
    +kpi("Committed (subcontracts)",fmtCompact(subsData.totalCommitted),"signed PO_Sub value","")
    +kpi("Subcontractors",String(subsData.subCount||subs.length),"with booked cost","")
    +kpi("Top sub",esc(((subs[0]&&subs[0].name)||"—").split(/\s+/).slice(0,2).join(" ")),subs[0]?fmtCompact(subs[0].actualCost)+" actual":"","")
    +"</div>";
  var shown=subsShowAll?subs:subs.slice(0,40);
  var rows=shown.map(function(s,i){
    return "<tr class=\"ryc-row\" data-vno=\""+attrEsc(s.vendorNo)+"\" tabindex=\"0\" role=\"button\" title=\"Job history\"><td class=\"r\" style=\"color:#8b95ab\">"+(i+1)+"</td>"
      +"<td><div class=\"jname\">"+esc(s.name)+"</div></td>"
      +"<td class=\"r\">"+subCurrentCount(s)+"<div class=\"cell-sub\">"+(s.actualJobs||s.committedJobs||0)+" all time</div></td>"
      +"<td class=\"r\">"+(s.committed?fmtCompact(s.committed):"<span class=\"m-m\">—</span>")+"</td>"
      +"<td class=\"r\"><b>"+fmtCompact(s.actualCost)+"</b></td>"
      +"<td class=\"r\">"+subDeltaCell(s.variance)+"</td></tr>";
  }).join("");
  var toggle="<button class=\"pfill\" onclick=\"toggleSubsAll()\">"+(subsShowAll?"Show top 40":"Show all "+subs.length)+"</button>";
  view.innerHTML=strip
    +"<div class=\"vhead\" style=\"display:flex;align-items:center;gap:10px\">Top subcontractors — ranked by actual spend "+toggle+"</div>"
    +"<div class=\"vsub\"><b>Actual</b> = subcontractor cost booked in Foundation by vendor across 2023+ jobs. <b>Committed</b> = signed subcontract amount (PO_Sub). Δ = committed − actual: positive = under / in-progress; negative = actual over the subcontract (change orders or T&amp;M). Committed-vs-actual mixes in-progress jobs and T&amp;M (PO-less) subs — read <b>Actual</b> as the spend ranking. The buyout spread vs the original <i>bid</i> carry needs the estimate — a later phase. Click a sub for its job history.</div>"
    +"<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th class=\"r\">#</th><th>Subcontractor</th><th class=\"r\">On now</th><th class=\"r\">Committed</th><th class=\"r\">Actual spend</th><th class=\"r\">Δ vs committed</th></tr></thead><tbody>"+rows+"</tbody></table></div>"
    +(subsShowAll?"":"<div class=\"vsub\" style=\"margin-top:8px\">Top 40 of "+subs.length+" shown.</div>");
  hookSubRows();
}
function hookSubRows(){
  Array.prototype.forEach.call(document.querySelectorAll(".view tbody"),function(tb){
    RYCTable.wire(tb,"data-vno",function(vno,tr){ openSubDrawer(vno,tr); });
  });
}
function openSubDrawer(vno,trigger){
  var s=((subsData&&subsData.subs)||[]).filter(function(x){ return x.vendorNo===vno; })[0];
  if(!s) return;
  closeDrawer(true);
  function stat(l,v,su){ return "<div class=\"dw-stat\"><div class=\"l\">"+l+"</div><div class=\"v\">"+v+"</div>"+(su?"<div class=\"s\">"+su+"</div>":"")+"</div>"; }
  var dhead="<div class=\"dw-head\"><div><h3>"+esc(s.name)+"</h3>"
    +"<div class=\"dw-sub\">Subcontractor · vendor "+esc(s.vendorNo)+" · "+(s.actualJobs||(s.jobs||[]).length)+" jobs with booked cost (2023+)</div></div>"
    +"<button class=\"dw-close\" onclick=\"closeDrawer()\" aria-label=\"Close\">&times;</button></div>";
  var stats="<div class=\"dw-sec\"><h4>Total across RYC (2023+)</h4><div class=\"dw-stats\">"
    +stat("Actual spend",fmtCompact(s.actualCost),"Foundation posted cost")
    +stat("Committed",s.committed?fmtCompact(s.committed):"—","signed subcontracts (PO_Sub)")
    +stat("Δ committed − actual",s.variance==null?"—":((s.variance>=0?"+":"")+fmtCompact(s.variance)),"")
    +"</div></div>";
  var split=subJobSplit(s);
  function jobRow(jj, live){
    var v=(jj.committed>0&&jj.actual>0)?(jj.committed-jj.actual):null;
    var j=live?jobByNo(jj.jobNo):null;
    var sl=j?getStoplight(j,j):null;
    var pm=j?(pmName(j)||""):"";
    return "<tr"+(live?(" data-jno=\""+attrEsc(jj.jobNo)+"\" style=\"cursor:pointer\" title=\"Open this job\""):"")+">"
      +"<td><span class=\"cell-sub\">"+esc(jj.jobNo)+"</span> "+esc(jj.jobName||"")+(pm?"<div class=\"cell-sub\">PM "+esc(pm)+"</div>":"")+"</td>"
      +(live?("<td>"+statusPill(isCloseoutOnly(j)?"closeout":sl.color,sl.reasons.map(function(r){return r.text;}).join(" · "))+"</td>"):"<td><span class=\"m-m\">closed</span></td>")
      +"<td class=\"r\">"+(jj.committed?fmtCompact(jj.committed):"—")+"</td>"
      +"<td class=\"r\">"+fmtCompact(jj.actual)+"</td>"
      +"<td class=\"r\">"+(v==null?"—":((v>=0?"+":"")+fmtCompact(v)))+"</td></tr>";
  }
  var sHead="<tr><th>Job</th><th>Status</th><th class=\"r\">Committed</th><th class=\"r\">Actual</th><th class=\"r\">Remaining</th></tr>";
  var curSec=split.cur.length
    ? ("<table class=\"dwt\">"+sHead+split.cur.map(function(j){return jobRow(j,true);}).join("")+"</table>"
       +"<div class=\"dw-note\">Remaining = committed &minus; actual: positive = still to spend on an in-progress subcontract; negative = actual over the subcontract (change orders or T&amp;M). Click a job to open it.</div>")
    : "<div class=\"dw-note\">Not currently on any job the active board carries.</div>";
  var histSec=split.hist.length
    ? ("<details style=\"margin-top:10px\"><summary class=\"dw-note\" style=\"cursor:pointer\">Earlier jobs &mdash; "+split.hist.length+"</summary>"
       +"<table class=\"dwt\" style=\"margin-top:6px\">"+sHead+split.hist.map(function(j){return jobRow(j,false);}).join("")+"</table></details>")
    : "";
  var jobsSec="<div class=\"dw-sec\"><h4>Currently on "+split.cur.length+" active job"+(split.cur.length===1?"":"s")+"</h4>"
    +curSec+histSec+"</div>";
  var wrap=document.createElement("div"); wrap.id="dwrap";
  wrap.innerHTML="<div class=\"dw-overlay\" onclick=\"closeDrawer()\"></div><aside class=\"drawer\" role=\"dialog\" aria-modal=\"true\" aria-label=\"Subcontractor detail: "+attrEsc(s.name)+"\">"+dhead+"<div class=\"dw-body\">"+stats+jobsSec+"</div></aside>";
  document.body.appendChild(wrap);
  RYCDrawer.mount(wrap,{trigger:trigger||null});
  // a job listed under a sub is a ROUTE to that job, not just a label
  Array.prototype.forEach.call(wrap.querySelectorAll("tr[data-jno]"),function(tr){
    tr.addEventListener("click",function(){ openDrawer(tr.getAttribute("data-jno"),null); });
  });
}

/* ===== Completed (v2.24.0) — the as-built record + sector insights. Restores the legacy
   dashboard's Completed archive + Portfolio Analysis in one view (Keith, 2026-07-28):
   Foundation completed-job record 2023→ (/ryc-data/ryc-portfolio.json, pegged at completion,
   rebuilt nightly w/ Procore enrichment) — performance by sector + work type from ACTUALS,
   plus a browsable job table w/ per-job outcome drawer (buyout by class, subs, field stats).
   Estimating-grade benchmarks (size bands, cost/SF) live on /ryc/estimate Cost Intelligence. ===== */
/* Sector and work type come from the SHARED taxonomy now (program 0.1). The two local
   label maps here and on the Desk had already drifted — this one carried
   municipal_water_wastewater and residential, the Desk's carried residential but not
   water/wastewater, so the same completed job could be filed under different sectors in the
   two workspaces. Legacy stored values normalise on read; see RYCTaxonomy. */
function cplCT(k){ return RYCTaxonomy.sectorLabel(RYCTaxonomy.classify({clientType:k}).sector); }
function cplWT(k){ return RYCTaxonomy.workLabel(k); }
/* A job's two dimensions, normalised — municipal_water_wastewater carries its work type
   inside the sector field, so grouping must read BOTH through the same function. */
function cplDims(j){ return RYCTaxonomy.classify(j); }
var cplFilter="all";
function cplSetFilter(v){ cplFilter=v; renderCompleted(); }
function cplJobs(){ return ((portfolioData&&portfolioData.jobs)||[]).filter(function(j){ return (j.contractFinal||0)>0; }); }
function cplAgg(js){
  var rev=0,cost=0,bidC=0,bidCost=0,buy=0,buySub=0,co=0;
  js.forEach(function(j){
    rev+=j.contractFinal||0; cost+=j.directCost||0;
    bidC+=j.contractOriginal||0; bidCost+=j.originalCost||0;
    if(j.buyout){ buy+=j.buyout.total||0; buySub+=j.buyout.sub||0; }
    co+=j.changeOrders||0;
  });
  var bidM=bidC>0?(bidC-bidCost)/bidC*100:null;
  var actM=rev>0?(rev-cost)/rev*100:null;
  return { n:js.length, rev:rev, bidM:bidM, actM:actM, gf:(bidM!=null&&actM!=null)?actM-bidM:null,
    buy:buy, buySubPct:buy>0?buySub/buy*100:null, coPct:bidC>0?co/bidC*100:null };
}
function cplGfCell(v){ if(v==null) return "<span class=\"m-m\">—</span>"; return "<span class=\""+(v<=-GF_MOVE_PTS?"m-r":v>=GF_MOVE_PTS?"m-g":"m-m")+"\">"+(v>=0?"+":"")+v.toFixed(1)+" pts</span>"; }
function cplSegTable(js,key,labelFn,head){
  var groups={};
  js.forEach(function(j){ var d=cplDims(j); var k=(key==="workType")?d.workType:d.sector; (groups[k]=groups[k]||[]).push(j); });
  var totalRev=js.reduce(function(s,j){ return s+(j.contractFinal||0); },0);
  var rows=Object.keys(groups).map(function(k){ return {label:labelFn(k),a:cplAgg(groups[k])}; })
    .sort(function(x,y){ return y.a.rev-x.a.rev; });
  var body=rows.map(function(r){
    var a=r.a, share=totalRev>0?(a.rev/totalRev*100):0;
    var buyCell=a.buy!==0?(fmtCompact(a.buy)+(a.buySubPct!=null?" <span class=\"cell-sub\">"+Math.round(a.buySubPct)+"% sub</span>":"")):"<span class=\"m-m\">—</span>";
    return "<tr class=\"static\"><td><div class=\"jname\">"+esc(r.label)+"</div>"
      +"<div style=\"background:#edf1f7;border-radius:3px;height:6px;margin-top:5px;max-width:140px\"><div style=\"background:var(--accent);height:6px;border-radius:3px;width:"+Math.min(100,share).toFixed(1)+"%\"></div></div></td>"
      +"<td class=\"r\">"+a.n+"</td><td class=\"r\">"+fmtCompact(a.rev)+"</td><td class=\"r\">"+share.toFixed(0)+"%</td>"
      +"<td class=\"r\">"+pct(a.bidM)+"</td><td class=\"r\">"+pct(a.actM)+"</td><td class=\"r\">"+cplGfCell(a.gf)+"</td>"
      +"<td class=\"r\">"+buyCell+"</td><td class=\"r\">"+pct(a.coPct)+"</td></tr>";
  }).join("");
  return "<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>"+head+"</th><th class=\"r\">Jobs</th><th class=\"r\">Revenue</th><th class=\"r\">Share</th><th class=\"r\">As-bid margin</th><th class=\"r\">Actual margin</th><th class=\"r\">Gain/fade</th><th class=\"r\">Buyout</th><th class=\"r\">CO %</th></tr></thead><tbody>"+body+"</tbody></table></div>"
    /* SAMPLE SIZE IS PART OF THE NUMBER (5.2). A sector margin computed over two jobs is not a
       sector margin, and a table that shows it in the same weight as one computed over thirty
       invites exactly the wrong read. The Jobs column is the denominator; this says so. */
    +"<div class=\"vsub\" style=\"margin-top:6px\">Read the <b>Jobs</b> column as the sample size — rows with fewer than 3 jobs are individual results, not a rate.</div>";
}
function renderCompleted(){
  var view=document.getElementById("view");
  var all=cplJobs();
  if(!all.length){
    view.innerHTML="<div class=\"warn-banner\">&#9888;&#65039; Completed-job archive unavailable (/ryc-data/ryc-portfolio.json) — sector insights cannot be computed. Figures show Unavailable, not $0.</div>";
    return;
  }
  var top=cplAgg(all);
  var fading=all.filter(function(j){ return j.bidMarginPct!=null&&j.projectedMarginPct!=null&&(j.projectedMarginPct-j.bidMarginPct)<=-GF_MOVE_PTS; });
  function kpi(l,v,s,cls){ return "<div class=\"kpi\"><div class=\"kl\">"+l+"</div><div class=\"kv "+(cls||"")+"\">"+v+"</div><div class=\"ks\">"+(s||"")+"</div></div>"; }
  var strip="<div class=\"kpi-strip k4\">"
    +kpi("Completed jobs",String(top.n),"2023&rarr; as-built record","")
    +kpi("Revenue delivered",fmtCompact(top.rev),"final contract value","")
    +kpi("Margin — bid &rarr; actual",(top.bidM!=null?top.bidM.toFixed(1):"—")+"% &rarr; "+(top.actM!=null?top.actM.toFixed(1):"—")+"%","value-weighted"+(top.gf!=null?(" · net "+(top.gf>=0?"+":"")+top.gf.toFixed(1)+" pts"):""),(top.gf!=null&&top.gf<=-GF_MOVE_PTS)?"warn":"")
    +kpi("Jobs that faded",String(fading.length),fading.length?"finished ≥1 pt under their bid margin":"none finished under bid","")
    +"</div>";

  /* INCLUSION BASIS, stated (5.2/0.2). Completed and PM Load draw on different cohorts and
     will never tie out; saying so beats leaving the reader to discover it as a contradiction. */
  var yrs=all.map(function(j){return j.year;}).filter(Boolean).sort();
  var basis="<div class=\"vsub\" style=\"margin-bottom:10px\"><b>What this counts.</b> "
    +all.length+" completed jobs with a final contract value"
    +(yrs.length?(", "+yrs[0]+"–"+yrs[yrs.length-1]):"")
    +", pegged at completion. Foundation is the source. <b>Excludes</b> active work, and excludes completed jobs with no final contract value. "
    +"This is a narrower cohort than PM Load, which counts billed revenue across all active and completed work — the two totals are not comparable and are not meant to be.</div>";
  var seg=basis+"<div class=\"vhead\">Sector performance — completed actuals</div>"
    +"<div class=\"vsub\">Where the margin actually came from. Value-weighted from the pegged completion record: as-bid = original contract vs bid cost; actual = final contract vs final cost. Buyout = estimate minus actual by cost class (positive = bought under the bid carry).</div>"
    +cplSegTable(all,"clientType",cplCT,"Sector")
    +"<div class=\"vhead\">Work type performance</div>"
    +cplSegTable(all,"workType",cplWT,"Work type");

  var types=[["all","All"]].concat(Object.keys(all.reduce(function(m,j){ m[cplDims(j).sector]=1; return m; },{})).sort().map(function(k){ return [k,RYCTaxonomy.sectorLabel(k)]; }));
  var pills="<div class=\"pbar\">"+types.map(function(p){ return "<button class=\"pfill"+(cplFilter===p[0]?" on\" style=\"border-color:var(--accent);color:var(--accent)":"")+"\" onclick=\"cplSetFilter('"+p[0]+"')\">"+p[1]+"</button>"; }).join("")+"<span class=\"pcount\"></span></div>";
  var shown=(cplFilter==="all"?all:all.filter(function(j){ return cplDims(j).sector===cplFilter; }))
    .slice().sort(function(a,b){ return (b.year||0)-(a.year||0)||((b.contractFinal||0)-(a.contractFinal||0)); });
  var rows=shown.map(function(j){
    var gfp=(j.bidMarginPct!=null&&j.projectedMarginPct!=null)?(j.projectedMarginPct-j.bidMarginPct):null;
    return "<tr class=\"ryc-row\" data-cid=\""+attrEsc(j.id)+"\" tabindex=\"0\" role=\"button\" title=\"Job outcome\"><td><div class=\"jname\">"+esc(j.name)+"</div><div class=\"jno\">"+esc(j.id)+(j.pmName?" · "+esc(j.pmName):"")+"</div></td>"
      +"<td>"+esc(j.client||"—")+"</td><td>"+RYCTaxonomy.sectorLabel(cplDims(j).sector)+"</td><td>"+RYCTaxonomy.workLabel(cplDims(j).workType)+"</td>"
      +"<td class=\"r\">"+(j.year||"—")+"</td>"
      +"<td class=\"r\">"+fmtCompact(j.contractFinal)+"</td><td class=\"r\">"+fmtCompact(j.directCost)+"</td>"
      +"<td class=\"r\">"+(j.bidMarginPct!=null?j.bidMarginPct.toFixed(1)+"%":"—")+"</td>"
      +"<td class=\"r\">"+(j.projectedMarginPct!=null?("<span class=\""+(j.projectedMarginPct<0?"m-r":"")+"\">"+j.projectedMarginPct.toFixed(1)+"%</span>"):"—")+"</td>"
      +"<td class=\"r\">"+cplGfCell(gfp)+"</td></tr>";
  }).join("");
  var tbl="<div class=\"vhead\">Completed jobs</div><div class=\"vsub\">Newest first. Click a job for the full outcome — buyout by cost class, subcontractors, field stats.</div>"
    +pills
    +"<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Job</th><th>Client</th><th>Sector</th><th>Work</th><th class=\"r\">Year</th><th class=\"r\">Contract (final)</th><th class=\"r\">Final cost</th><th class=\"r\">As-bid</th><th class=\"r\">Actual</th><th class=\"r\">&Delta; pts</th></tr></thead><tbody>"+rows+"</tbody></table></div>"
    +"<div class=\"vsub\" style=\"margin-top:8px\">"+shown.length+" of "+all.length+" completed jobs shown. Estimating-grade benchmarks (size bands, repeat-profile pricing) live on <a href=\"/ryc/estimate\" style=\"color:var(--accent);font-weight:600\">/ryc/estimate &rarr; Cost Intelligence</a>.</div>";

  view.innerHTML=strip+seg+tbl;
  hookCplRows();
}
function hookCplRows(){
  Array.prototype.forEach.call(document.querySelectorAll(".view tbody"),function(tb){
    RYCTable.wire(tb,"data-cid",function(cid,tr){ openCplDrawer(cid,tr); });
  });
}
function openCplDrawer(cid,trigger){
  var j=cplJobs().filter(function(x){ return x.id===cid; })[0];
  if(!j) return;
  closeDrawer(true);
  function stat(l,v,su){ return "<div class=\"dw-stat\"><div class=\"l\">"+l+"</div><div class=\"v\">"+v+"</div>"+(su?"<div class=\"s\">"+su+"</div>":"")+"</div>"; }
  var gfp=(j.bidMarginPct!=null&&j.projectedMarginPct!=null)?(j.projectedMarginPct-j.bidMarginPct):null;
  var head="<div class=\"dw-head\"><div><h3>"+esc(j.name)+"</h3>"
    +"<div class=\"dw-sub\">"+esc(j.id)+" · "+esc(j.client||"—")+" · "+RYCTaxonomy.sectorLabel(cplDims(j).sector)+" · "+RYCTaxonomy.workLabel(cplDims(j).workType)+(j.pmName?" · PM "+esc(j.pmName):"")+"</div>"
    +"<div style=\"margin-top:8px\"><span class=\"pill g\">Completed"+(j.year?" "+j.year:"")+"</span></div></div>"
    +"<button class=\"dw-close\" onclick=\"closeDrawer()\" aria-label=\"Close\">&times;</button></div>";
  var coFinal=(j.contractFinal||0)-(j.contractOriginal||0);
  var outcome="<div class=\"dw-sec\"><h4>Outcome</h4><div class=\"dw-stats\">"
    +stat("Final contract",fmtCompact(j.contractFinal),coFinal!==0?("bid "+fmtCompact(j.contractOriginal)+" "+(coFinal>0?"+":"")+fmtCompact(coFinal)+" COs"):"no contract growth")
    +stat("Final cost",fmtCompact(j.directCost),j.originalCost?("bid cost "+fmtCompact(j.originalCost)):"")
    +stat("Actual margin",j.projectedMarginPct!=null?j.projectedMarginPct.toFixed(1)+"%":"—",j.bidMarginPct!=null?("bid "+j.bidMarginPct.toFixed(1)+"%"):"")
    +stat("Gain / fade",gfp!=null?((gfp>=0?"+":"")+gfp.toFixed(1)+" pts"):"—",gfp!=null?(gfp<=-GF_MOVE_PTS?"finished under bid margin":gfp>=GF_MOVE_PTS?"beat the bid margin":"held the bid margin"):"")
    +stat("Duration",j.durationMonths?j.durationMonths+" mo":"—",j.actualCompletion?("done "+fmtDate(j.actualCompletion)):"")
    +stat("Change orders",j.coPct!=null?j.coPct.toFixed(1)+"%":"—",j.changeOrders?("net "+fmtCompact(j.changeOrders)):"none posted")
    +"</div></div>";
  var buySec="";
  var bo=j.buyout;
  if(bo&&bo.byClass&&bo.byClass.length){
    var bRows=bo.byClass.slice().sort(function(a,c){ return (c.act||0)-(a.act||0); }).map(function(c){
      var d=(c.est||0)-(c.act||0);
      return "<tr><td>"+esc(c.cls)+"</td><td class=\"r\">"+fmtCompact(c.est)+"</td><td class=\"r\">"+fmtCompact(c.act)+"</td>"
        +"<td class=\"r\"><span class=\""+(d>=0?"m-g":"m-r")+"\">"+(d>=0?"+":"")+fmtCompact(d)+"</span></td></tr>";
    }).join("");
    buySec="<div class=\"dw-sec\"><h4>Buyout — estimate vs actual by cost class</h4>"
      +"<table class=\"dwt\"><tr><th>Class</th><th class=\"r\">Estimate</th><th class=\"r\">Actual</th><th class=\"r\">Buyout</th></tr>"+bRows
      +"<tr><td><b>Total</b>"+(bo.subPct>0?" <span class=\"cell-sub\">"+Math.round(bo.subPct)+"% from subcontract</span>":"")+"</td><td class=\"r\"></td><td class=\"r\"></td><td class=\"r\"><span class=\""+((bo.total||0)>=0?"m-g":"m-r")+"\"><b>"+((bo.total||0)>=0?"+":"")+fmtCompact(bo.total)+"</b></span></td></tr></table>"
      +"<div class=\"dw-note\">Estimate = Foundation job budget by cost class; actual = costs booked. Positive = came in under the bid carry (buyout / savings).</div></div>";
  }
  var subSec="";
  if(j.subs&&j.subs.length){
    var sRows=j.subs.map(function(s){ return "<tr><td>"+esc(s.name)+"</td><td class=\"r\">"+fmtCompact(s.cost)+"</td></tr>"; }).join("");
    subSec="<div class=\"dw-sec\"><h4>Subcontractors on this job (actual spend)</h4><table class=\"dwt\"><tr><th>Subcontractor</th><th class=\"r\">Actual cost</th></tr>"+sRows+"</table></div>";
  }
  var opsSec="";
  if(j.procoreId&&(j.rfis||j.submittals||j.changeEvents||j.sqft)){
    opsSec="<div class=\"dw-sec\"><h4>Field record (Procore)</h4><div class=\"dw-stats\">"
      +(j.rfis?stat("RFIs",String(j.rfis),""):"")
      +(j.submittals?stat("Submittals",String(j.submittals),""):"")
      +(j.changeEvents?stat("Change events",String(j.changeEvents),""):"")
      +(j.sqft?stat("Square feet",j.sqft.toLocaleString("en-US"),""):"")
      +"</div></div>";
  }
  var wrap=document.createElement("div"); wrap.id="dwrap";
  wrap.innerHTML="<div class=\"dw-overlay\" onclick=\"closeDrawer()\"></div><aside class=\"drawer\" role=\"dialog\" aria-modal=\"true\" aria-label=\"Completed job: "+attrEsc(j.name)+"\">"+head+"<div class=\"dw-body\">"+outcome+buySec+subSec+opsSec+"</div></aside>";
  document.body.appendChild(wrap);
  RYCDrawer.mount(wrap,{trigger:trigger||null});
}

/* ===== PM Load (v2.21.0) — per-PM workload history + forward hiring signal.
   Source: /ryc-data/pm-history.json (Foundation ODBC weekly pull — the only system
   with multi-year history; Procore only knows the current board). Tier convention
   (Keith 2026-07-22): flat job counts lie (a $163 repair and an $11M fieldhouse both get a
   job number; Greencroft is 30+ unit jobs under one PM) — so jobs are tiered and counts
   are shown per tier. Palette validated (dataviz 6-check, light surface). */
var PM_TIERS=["core","greencroft","small","service"];
var PM_TIER_COLOR={core:"#9a3412",greencroft:"#4d8fc9",small:"#f26a1b",service:"#2f9d80"};
var PM_TIER_LABEL={core:"Core projects",greencroft:"Greencroft units",small:"Small jobs",service:"Service / T&M"};
var PM_FULL_LOAD=2000000; // annual billed >= $2M = a "full-load" PM-year (filters principals' residual volume)

function pmTipShow(ev,html){
  var t=document.getElementById("pmtip");
  if(!t){ t=document.createElement("div"); t.id="pmtip"; document.body.appendChild(t); }
  t.innerHTML=html; t.style.display="block";
  var x=ev.clientX+14, y=ev.clientY+12;
  if(x+t.offsetWidth>window.innerWidth-8) x=ev.clientX-t.offsetWidth-10;
  if(y+t.offsetHeight>window.innerHeight-8) y=ev.clientY-t.offsetHeight-10;
  t.style.left=x+"px"; t.style.top=y+"px";
}
function pmTipHide(){ var t=document.getElementById("pmtip"); if(t) t.style.display="none"; }
function pmBindTips(root){
  Array.prototype.forEach.call(root.querySelectorAll("[data-tip]"),function(el){
    el.addEventListener("mousemove",function(ev){ pmTipShow(ev,el.getAttribute("data-tip")); });
    el.addEventListener("mouseleave",pmTipHide);
  });
}

function renderPMLoad(){
  var view=document.getElementById("view");
  if(!pmHistData||!pmHistData.jobs){
    view.innerHTML="<div class=\"warn-banner\">&#9888;&#65039; PM history feed unavailable (/ryc-data/pm-history.json) — workload history cannot be computed. Figures show Unavailable, not $0.</div>";
    return;
  }
  var H=pmHistData;
  var nm=function(c){ return (H.pmNames&&H.pmNames[c])||c||"—"; };

  /* ---- annual billed + job counts by tier (from per-job per-year billed) ---- */
  var YEARS=[2021,2022,2023,2024,2025,2026];
  var lastYm=H.monthly.length?H.monthly[H.monthly.length-1].ym:"2026-07";
  var curYr=+lastYm.slice(0,4), curMo=+lastYm.slice(5,7);
  var annualFactor=(curMo>=12)?1:(12/curMo); // annualize the partial current year where marked
  var tierYear={}; // yr -> tier -> {billed,jobs}
  H.jobs.forEach(function(j){
    var by=j.by||{};
    Object.keys(by).forEach(function(y){
      var v=by[y]; y=+y; if(!(v>0)||y<2021) return;
      var t=(tierYear[y]=tierYear[y]||{}); var b=(t[j.t]=t[j.t]||{billed:0,jobs:0});
      b.billed+=v; b.jobs++;
    });
  });

  /* ---- per-PM annual + trailing-12-month billed (from monthly rows) ---- */
  var cutY=(curMo===12)?curYr:curYr-1, cutM=(curMo===12)?1:curMo+1;
  var cutYm=cutY+"-"+("0"+cutM).slice(-2); // first ym inside the TTM window
  var pmYear={}, pmTTM={};
  H.monthly.forEach(function(r){
    if(!r.pm) return;
    var y=+r.ym.slice(0,4);
    (pmYear[r.pm]=pmYear[r.pm]||{})[y]=(pmYear[r.pm][y]||0)+r.billed;
    if(r.ym>=cutYm) pmTTM[r.pm]=(pmTTM[r.pm]||0)+r.billed;
  });

  /* full-load PM-years (annual billed >= $2M; current partial year annualized) */
  var fullYear={}; // yr -> [{pm,billed}] billed annualized for current year
  YEARS.forEach(function(y){
    var list=[];
    Object.keys(pmYear).forEach(function(pm){
      var b=pmYear[pm][y]||0; var ann=(y===curYr)?b*annualFactor:b;
      if(ann>=PM_FULL_LOAD) list.push({pm:pm,billed:ann,raw:b});
    });
    list.sort(function(a,b){return b.billed-a.billed;});
    fullYear[y]=list;
  });
  function avgPerPM(y){ var l=fullYear[y]; if(!l||!l.length) return null; return l.reduce(function(s,r){return s+r.billed;},0)/l.length; }

  /* ---- current bench + active-job tiers per PM (Foundation job_status A) ---- */
  var bench={}; // pm -> {core,gc,smallSvc,mgmt}
  H.jobs.forEach(function(j){
    if(j.s!=="A"||!j.pm) return;
    var b=(bench[j.pm]=bench[j.pm]||{core:0,gc:0,smallSvc:0,mgmt:0});
    if(j.t==="core"){ b.core++; b.mgmt+=(j.c||0); }
    else if(j.t==="greencroft") b.gc++;
    else b.smallSvc++;
  });
  var benchPMs=Object.keys(pmTTM).filter(function(pm){ return (pmTTM[pm]||0)>=PM_FULL_LOAD; });
  var benchAvgTTM=benchPMs.length?benchPMs.reduce(function(s,pm){return s+pmTTM[pm];},0)/benchPMs.length:null;

  /* baseline vs now — the "are we asking more of them" number */
  var base=[avgPerPM(2021),avgPerPM(2022),avgPerPM(2023)].filter(function(v){return v!=null;});
  var baseAvg=base.length?base.reduce(function(s,v){return s+v;},0)/base.length:null;
  var loadX=(baseAvg&&benchAvgTTM)?(benchAvgTTM/baseAvg):null;

  /* sustainable capacity = median full-load PM-year, 2024 -> current (annualized) */
  var capSample=[];
  [2024,2025,curYr].forEach(function(y){ (fullYear[y]||[]).forEach(function(r){ capSample.push(r.billed); }); });
  capSample.sort(function(a,b){return a-b;});
  var capacity=capSample.length?capSample[Math.floor(capSample.length/2)]:null;

  /* forward demand from the Buildr forecast (already loaded for the Forecast view) */
  var fwd12b=null,fwd12p=null;
  if(forecastData&&forecastData.projects){
    var sp=fcSpread(forecastData.projects);
    fwd12b=0; fwd12p=0;
    Object.keys(sp.buckets).forEach(function(m){
      m=+m; if(m>=sp.nowIdx&&m<sp.nowIdx+12){ fwd12b+=sp.buckets[m].booked; fwd12p+=sp.buckets[m].potential; }
    });
  }

  function kpi(l,v,s,cls){ return "<div class=\"kpi\"><div class=\"kl\">"+l+"</div><div class=\"kv "+(cls||"")+"\">"+v+"</div><div class=\"ks\">"+(s||"")+"</div></div>"; }
  var activeCore=0,activeGC=0,mgmtTotal=0;
  Object.keys(bench).forEach(function(pm){ activeCore+=bench[pm].core; activeGC+=bench[pm].gc; mgmtTotal+=bench[pm].mgmt; });
  var strip="<div class=\"kpi-strip k4\">"
    +kpi("Billed per full-load PM (TTM)",benchAvgTTM!=null?fmtCompact(benchAvgTTM):"—",benchPMs.length+" PMs at &ge;"+fmtCompact(PM_FULL_LOAD)+"/yr","accent")
    +kpi("Load vs 2021–23 baseline",loadX?("&times;"+loadX.toFixed(1)):"—",baseAvg!=null?("was "+fmtCompact(baseAvg)+"/PM/yr"):"","")
    +kpi("Core projects in flight",activeCore,activeGC+" Greencroft units · "+fmtCompact(mgmtTotal)+" under mgmt","")
    +kpi("Sustainable capacity / PM",capacity!=null?fmtCompact(capacity):"—","median full-load PM-year, 2024&rarr;now","")
    +"</div>";

  /* ---- Chart 1: annual billed stacked by tier ---- */
  var W=760,CH=250,PAD_T=30,PAD_B=24,bw=74,gapX=(W-YEARS.length*bw)/(YEARS.length+1);
  var maxTot=0;
  YEARS.forEach(function(y){ var t=tierYear[y]||{}; var s=PM_TIERS.reduce(function(a,k){return a+((t[k]&&t[k].billed)||0);},0); if(s>maxTot) maxTot=s; });
  var svg1="<svg viewBox=\"0 0 "+W+" "+(CH+PAD_T+PAD_B)+"\" style=\"width:100%;height:auto\" role=\"img\" aria-label=\"Annual billed revenue by job tier\">";
  YEARS.forEach(function(y,i){
    var t=tierYear[y]||{}; var x=gapX+i*(bw+gapX); var yTot=PM_TIERS.reduce(function(a,k){return a+((t[k]&&t[k].billed)||0);},0);
    if(!(yTot>0)) return;
    var yCur=CH+PAD_T; var segs=[];
    PM_TIERS.forEach(function(k){ var v=(t[k]&&t[k].billed)||0; if(v>0) segs.push({k:k,v:v,jobs:t[k].jobs}); });
    segs.forEach(function(s2,si){
      var h=Math.max(2,s2.v/maxTot*CH); var isTop=(si===segs.length-1);
      yCur-=h;
      var tip="<b>"+PM_TIER_LABEL[s2.k]+" · "+y+"</b><br>"+fmtCompact(s2.v)+" billed · "+s2.jobs+" jobs · "+Math.round(s2.v/yTot*100)+"% of year";
      if(isTop){
        var r=4,x2=x+bw,yv=yCur,hb=h;
        svg1+="<path d=\"M"+x+" "+(yv+hb)+" L"+x+" "+(yv+r)+" Q"+x+" "+yv+" "+(x+r)+" "+yv+" L"+(x2-r)+" "+yv+" Q"+x2+" "+yv+" "+x2+" "+(yv+r)+" L"+x2+" "+(yv+hb)+" Z\" fill=\""+PM_TIER_COLOR[s2.k]+"\" data-tip=\""+attrEsc(tip)+"\"/>";
      } else {
        svg1+="<rect x=\""+x+"\" y=\""+yCur+"\" width=\""+bw+"\" height=\""+Math.max(0.5,h-2)+"\" fill=\""+PM_TIER_COLOR[s2.k]+"\" data-tip=\""+attrEsc(tip)+"\"/>";
      }
    });
    svg1+="<text x=\""+(x+bw/2)+"\" y=\""+(yCur-8)+"\" text-anchor=\"middle\" style=\"font-size:12px;font-weight:700;fill:#1c2433\">"+fmtCompact(yTot)+"</text>";
    svg1+="<text x=\""+(x+bw/2)+"\" y=\""+(CH+PAD_T+16)+"\" text-anchor=\"middle\" style=\"font-size:11.5px;fill:#67718a\">"+y+(y===curYr?" &middot; thru "+new Date(curYr,curMo-1,1).toLocaleDateString("en-US",{month:"short"}):"")+"</text>";
  });
  svg1+="</svg>";
  var legend="<div class=\"pm-leg\">"+PM_TIERS.map(function(k){ return "<span><i style=\"background:"+PM_TIER_COLOR[k]+"\"></i>"+PM_TIER_LABEL[k]+"</span>"; }).join("")+"</div>";

  /* ---- chart pair: full-load bench + $/full-load-PM (small multiples, one measure each) ---- */
  function miniBars(vals,fmtV){
    var w=340,h=170,pt=26,pb=20,bw2=34,g=(w-YEARS.length*bw2)/(YEARS.length+1);
    var mx=0; vals.forEach(function(v){ if((v||0)>mx) mx=v; });
    var s="<svg viewBox=\"0 0 "+w+" "+h+"\" style=\"width:100%;height:auto\">";
    YEARS.forEach(function(y,i){
      var v=vals[i]||0; var bh=mx?Math.max(2,v/mx*(h-pt-pb)):2; var x=g+i*(bw2+g), yv=h-pb-bh;
      s+="<path d=\"M"+x+" "+(h-pb)+" L"+x+" "+(yv+4)+" Q"+x+" "+yv+" "+(x+4)+" "+yv+" L"+(x+bw2-4)+" "+yv+" Q"+(x+bw2)+" "+yv+" "+(x+bw2)+" "+(yv+4)+" L"+(x+bw2)+" "+(h-pb)+" Z\" fill=\"#9a3412\"/>";
      s+="<text x=\""+(x+bw2/2)+"\" y=\""+(yv-6)+"\" text-anchor=\"middle\" style=\"font-size:11px;font-weight:700;fill:#1c2433\">"+fmtV(v)+"</text>";
      s+="<text x=\""+(x+bw2/2)+"\" y=\""+(h-6)+"\" text-anchor=\"middle\" style=\"font-size:10px;fill:#67718a\">&#39;"+String(y).slice(2)+(y===curYr?"*":"")+"</text>";
    });
    return s+"</svg>";
  }
  var benchCounts=YEARS.map(function(y){ return (fullYear[y]||[]).length; });
  var perPM=YEARS.map(function(y){ return avgPerPM(y); });
  var pair="<div class=\"pm-pair\">"
    +"<div><div class=\"pm-ct\">Full-load PM bench by year <span class=\"pm-cs\">(PMs billing &ge;$2M; * annualized)</span></div>"+miniBars(benchCounts,function(v){return v||"—";})+"</div>"
    +"<div><div class=\"pm-ct\">Avg billed per full-load PM <span class=\"pm-cs\">(* annualized)</span></div>"+miniBars(perPM,function(v){return v?fmtCompact(v):"—";})+"</div>"
    +"</div>";

  /* ---- annual table (the numbers behind the charts) ---- */
  var atRows=YEARS.map(function(y){
    var t=tierYear[y]||{}; function g(k,f){ return t[k]?(f==="j"?t[k].jobs:fmtCompact(t[k].billed)):"—"; }
    var tot=PM_TIERS.reduce(function(a,k){return a+((t[k]&&t[k].billed)||0);},0);
    var fl=(fullYear[y]||[]).length, ap=avgPerPM(y);
    return "<tr class=\"static\"><td>"+y+(y===curYr?" (thru "+new Date(curYr,curMo-1,1).toLocaleDateString("en-US",{month:"short"})+")":"")+"</td>"
      +"<td class=\"r\"><b>"+fmtCompact(tot)+"</b></td>"
      +"<td class=\"r\">"+g("core","j")+" &middot; "+g("core")+"</td>"
      +"<td class=\"r\">"+g("greencroft","j")+" &middot; "+g("greencroft")+"</td>"
      +"<td class=\"r\">"+((t.small?t.small.jobs:0)+(t.service?t.service.jobs:0))+" &middot; "+fmtCompact(((t.small&&t.small.billed)||0)+((t.service&&t.service.billed)||0))+"</td>"
      +"<td class=\"r\">"+(fl||"—")+"</td>"
      +"<td class=\"r\">"+(ap?fmtCompact(ap)+(y===curYr?"*":""):"—")+"</td></tr>";
  }).join("");
  var annualTable="<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Year</th><th class=\"r\">Billed</th><th class=\"r\">Core (jobs &middot; $)</th><th class=\"r\">Greencroft (units &middot; $)</th><th class=\"r\">Small + service (jobs &middot; $)</th><th class=\"r\">Full-load PMs</th><th class=\"r\">$ / full-load PM</th></tr></thead><tbody>"+atRows+"</tbody></table></div>";

  /* ---- per-PM table with sparklines ---- */
  function spark(vals){
    var w=110,h=26,mx=1;
    vals.forEach(function(v){ if(v>mx) mx=v; });
    var pts=vals.map(function(v,i){ return (i*(w-8)/(vals.length-1)+4)+","+(h-3-(v/mx)*(h-8)); });
    var last=pts[pts.length-1].split(",");
    return "<svg viewBox=\"0 0 "+w+" "+h+"\" style=\"width:110px;height:26px;vertical-align:middle\"><polyline points=\""+pts.join(" ")+"\" fill=\"none\" stroke=\"#f26a1b\" stroke-width=\"2\" stroke-linejoin=\"round\"/><circle cx=\""+last[0]+"\" cy=\""+last[1]+"\" r=\"2.6\" fill=\"#9a3412\"/></svg>";
  }
  var pmRows=Object.keys(pmYear).map(function(pm){
    var b=bench[pm]||{core:0,gc:0,smallSvc:0,mgmt:0};
    return { pm:pm, ttm:pmTTM[pm]||0, b:b,
      years:YEARS.map(function(y){ return pmYear[pm][y]||0; }),
      total:YEARS.reduce(function(s,y,i){ return s+(pmYear[pm][y]||0); },0) };
  }).filter(function(r){ return r.total>100000||r.b.core>0||r.b.gc>0; })
    .sort(function(a,b){ return b.ttm-a.ttm; });
  var pmTable="<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>PM</th><th>Billed 2021&rarr;now</th>"
    +"<th class=\"r\">TTM billed</th><th class=\"r\">2025</th><th class=\"r\">2026 YTD</th>"
    +"<th class=\"r\">Core jobs now</th><th class=\"r\">GC units</th><th class=\"r\">Small/svc</th><th class=\"r\">$ under mgmt</th></tr></thead><tbody>"
    +pmRows.map(function(r){
      var full=(r.ttm>=PM_FULL_LOAD);
      return "<tr class=\"static\"><td><div class=\"jname\">"+esc(nm(r.pm))+(full?" <span class=\"pill g\">full load</span>":"")+"</div></td>"
        +"<td>"+spark(r.years)+"</td>"
        +"<td class=\"r\"><b>"+fmtCompact(r.ttm)+"</b></td>"
        +"<td class=\"r\">"+fmtCompact(r.years[4])+"</td>"
        +"<td class=\"r\">"+fmtCompact(r.years[5])+"</td>"
        +"<td class=\"r\">"+(r.b.core||"—")+"</td><td class=\"r\">"+(r.b.gc||"—")+"</td><td class=\"r\">"+(r.b.smallSvc||"—")+"</td>"
        +"<td class=\"r\">"+(r.b.mgmt?fmtCompact(r.b.mgmt):"—")+"</td></tr>";
    }).join("")+"</tbody></table></div>";

  /* ---- hiring signal ---- */
  var hire="";
  if(capacity&&fwd12b!=null){
    var needB=fwd12b/capacity, needBP=(fwd12b+fwd12p)/capacity;
    var gapB=needB-benchPMs.length, gapBP=needBP-benchPMs.length;
    var verdict, vcls;
    if(gapBP<=0){ verdict="Headroom — current bench covers booked + pipeline"; vcls="g"; }
    else if(gapB<=0){ verdict="Tight — booked is covered, pipeline conversion outruns the bench"; vcls="a"; }
    else { verdict="Short — booked work alone exceeds bench capacity"; vcls="r"; }
    hire="<div class=\"kpi-strip k4\">"
      +kpi("Booked next 12 mo (Buildr)",fmtCompact(fwd12b),"needs ~"+needB.toFixed(1)+" full-load PMs","")
      +kpi("Booked + pipeline next 12 mo",fmtCompact(fwd12b+fwd12p),"needs ~"+needBP.toFixed(1)+" full-load PMs","")
      +kpi("Bench today",benchPMs.length+" PMs","capacity ~"+fmtCompact(capacity*benchPMs.length)+"/yr","accent")
      +kpi("Verdict","<span class=\"pill "+vcls+"\">"+(gapBP>0?("+"+Math.ceil(Math.max(gapB,0))+"&ndash;"+Math.ceil(gapBP)+" PMs"):"OK")+"</span>",verdict,"")
      +"</div>"
      +"<div class=\"pm-note\">Method: sustainable capacity = median full-load PM-year (billed &ge;$2M/yr, 2024&rarr;now, partial year annualized) = "+fmtCompact(capacity)+". Forward demand = Buildr forecast spread over the next 12 months (undated projects excluded — see Forecast view). Superintendents are not tracked in Foundation; this is a PM lens only.</div>";
  } else {
    hire="<div class=\"pm-note\">Hiring signal unavailable — "+(capacity?"Buildr forecast feed did not load.":"not enough full-load PM-years to derive capacity.")+"</div>";
  }

  var caveats="<div class=\"pm-note\">"+((H.caveats||[]).map(esc).join(" &middot; "))+" Tiers: core = "+esc(H.tiers?H.tiers.core:"")+"; small = "+esc(H.tiers?H.tiers.small:"")+".</div>";

  /* 5.3 — WHAT THIS MEASURES, before it measures it. PM Load's since-2021 revenue runs several
     times the Completed page's total, which reads as a contradiction until the scopes are
     stated: they count different things on purpose. Every dimension the brief asks for is
     named here rather than left to be reverse-engineered from a discrepancy. */
  var roll=companyRollup();
  var scope="<div class=\"panel\"><h3>What this page counts</h3>"
    +"<table class=\"tbl\"><tbody>"
    +"<tr><td><b>Measure</b></td><td>Billed revenue — cash actually invoiced, not contract value and not completed value.</td></tr>"
    +"<tr><td><b>Inclusion</b></td><td>Every job Foundation has billed against since 2021: active, completed and closed alike.</td></tr>"
    +"<tr><td><b>Source coverage</b></td><td>Foundation only. Procore plays no part here, so jobs the board never carried are included on equal terms.</td></tr>"
    +"<tr><td><b>Construction Services</b></td><td><b>Included.</b> Jobs under "+fmtCompact(CS_THRESHOLD)+" are real billed revenue and are counted — they are most of the job COUNT and about 1% of the dollars, which is why the tiering below exists.</td></tr>"
    +"<tr><td><b>Date basis</b></td><td>The month the billing was transacted.</td></tr>"
    +"<tr><td><b>Why it exceeds Completed</b></td><td>Completed counts finished jobs at their final contract value; this counts billings on <i>all</i> work, most of which is still running. The two are not comparable and no reconciliation between them is meaningful.</td></tr>"
    +"</tbody></table>"
    +"<div class=\"sub\" style=\"margin-top:8px\">Company position today, for reference: "+cohortNote(roll)+"</div></div>";

  view.innerHTML=strip+scope
    +"<div class=\"panel\"><h3>Annual billed revenue by job tier</h3><div class=\"sub\">Where the dollars actually are — the service tail is ~1% of revenue but most of the job count</div>"+legend+svg1+annualTable+"</div>"
    +"<div class=\"panel\"><h3>The load question</h3><div class=\"sub\">Same bench, roughly double the dollars — full-load = billed &ge;$2M in the year</div>"+pair+"</div>"
    +"<div class=\"panel\"><h3>When to hire</h3><div class=\"sub\">Forward revenue vs what the current bench sustainably carries</div>"+hire+"</div>"
    +"<div class=\"panel\"><h3>Per-PM detail</h3><div class=\"sub\">Sparkline = annual billed 2021&rarr;2026 &middot; active job counts and $ under management are core-tier, Foundation job status A</div>"+pmTable+caveats+"</div>";
  pmBindTips(view);
}
