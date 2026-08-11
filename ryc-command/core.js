
"use strict";
/* ===== RYC Command Center — Phase 1 (compute reimplemented from the legacy dashboard,
   verified against the frozen §8a baseline). Reads the SAME data sources; live untouched. ===== */
var CRM = "https://crm.jbkdevelopment.com";
var activeData=null, foundationData=null, arData=null, buildrData=null, portfolioData=null, subsData=null, forecastData=null, bcData=null, pmHistData=null, loadedAt=null, foundationOnly=[];

/* Grouped rail (Codex R5 #8): thirteen flat equal-weight destinations → a hierarchy.
   `grp` renders as a section header; `href` entries are cross-workspace links (the ONE
   unambiguous Estimating Desk entry — the duplicate footer link is gone). */
var NAV = [
  { key:"command",  label:"Overview",       ic:"&#129517;", grp:"" },
  { key:"portfolio",label:"Portfolio",      ic:"&#128203;", grp:"Jobs" },
  { key:"billing",  label:"Billing & Cash", ic:"&#128181;", grp:"Jobs" },
  { key:"woh",      label:"Work on Hand",   ic:"&#128202;", grp:"Jobs" },
  { key:"margin",   label:"Margin & Risk",  ic:"&#128201;", grp:"Jobs" },
  { key:"subs",     label:"Subcontractors", ic:"&#128296;", grp:"Jobs" },
  { key:"completed",label:"Completed",      ic:"&#127942;", grp:"Jobs" },
  { key:"forecast", label:"Forecast",       ic:"&#128200;", grp:"Plan & People" },
  { key:"pmload",   label:"PM Load",        ic:"&#128119;", grp:"Plan & People" },
  { key:"estimating",label:"Bid Board (BC)",ic:"&#128203;", grp:"Preconstruction" },
  { key:"deskLink", label:"Estimating Desk",ic:"&#128208;", grp:"Preconstruction", href:"/ryc/estimate" },
  { key:"brief",    label:"Executive Brief",ic:"&#128196;", grp:"Leadership" },
  /* Admin owns the MACHINERY (Integrations & Sync) and the DATA's provenance (Data Trust).
     AI Assistant moved OUT of Admin (Codex, sync-lane review): the capability matrix never
     defined asking questions of the data as administration — it sat here because the group
     had room. It is a utility until its audience is defined. */
  { key:"integrations", label:"Integrations & Sync", ic:"&#128260;", grp:"Admin" },
  { key:"trust",    label:"Definitions & Sources", ic:"&#128270;", grp:"Admin" },
  { key:"ai",       label:"Ask R. Yoder",   ic:"&#128172;", grp:"" }
];
var currentView = "command";

var CLOSEOUT_STAGES = { "Warranty":1, "Post-Construction":1 };
var GF_MOVE_PTS = 1.0, GF_BURN_PTS = 12, GF_BURN_MINPCT = 20;

/* ---- format helpers ----
   The RULES now live in ONE place, RYCFormat in /ryc-shell/shell.js, loaded by both
   workspaces (usability program 0.3). These stay as thin aliases rather than being renamed
   across ~700 call sites: the point of the slice is that there is one implementation, not
   that every caller changes its spelling. Command's compact rule became the canonical one,
   so nothing on this side moves. */
function fmt(n){ return RYCFormat.exact(n); }
function fmtCompact(n){ return RYCFormat.compact(n); }
function pct(n){ return RYCFormat.pct(n); }
function fmtDate(s){ return RYCFormat.date(s); }
function ageTxt(ts){ return RYCFormat.age(ts); }
function esc(s){ if(!s) return ""; var d=document.createElement("div"); d.textContent=s; return d.innerHTML; }
function pmName(job){ return (job.foundation && job.foundation.pmName) || (job.pm && job.pm.name) || null; }
/* AS-BID margin — the margin the job was originally bid at: ORIGINAL contract vs ORIGINAL
   estimated cost, Foundation originals first, Procore originals as fallback. The old
   contractedMargin() compared CURRENT contract (incl. approved COs) against original budget —
   a CO raising both revenue and cost read as margin gained and manufactured false fades
   (Codex #4: $100 orig / $80 cost / $110 current → 27.3% "bid" vs the true 20%) — and it
   clamped negatives to 0. Returns the real signed value. */
function asBidMargin(job){
  var f=job.foundation||null, b=job.budget||{};
  var c=(f&&f.originalContract>0)?f.originalContract
       :((job.procoreContractValue!=null&&job.procoreContractValue>0)?job.procoreContractValue:job.contractValue);
  var cost=(f&&f.originalCost!=null&&f.originalCost>0)?f.originalCost:(b.original>0?b.original:null);
  if(!(c>0)||cost==null) return null;
  return (c-cost)/c*100;
}
/* NOT a margin. (contract - cost to date)/contract is the share of contract value not yet
   consumed by recorded cost: it starts near 100% on a new job and decays toward the true
   margin only as the job finishes. Kept solely as a spend/burn measure and for the
   "cost has exceeded the contract" check — never label or colour it as margin. */
function contractLessCostToDatePct(job){ var cv=job.contractValue, dc=(job.costToDate!=null?job.costToDate:(job.budget&&job.budget.direct)); return (cv>0 && dc>0)?((cv-dc)/cv*100):null; }

/* The real margin measure during a live job: contract vs PROJECTED cost at completion.
   Same formula the job drawer already used for "margin at compl.", so a Portfolio row and the
   drawer opened from it can no longer disagree. Populated on 49 of 53 active jobs. */
function projectedMargin(job){ var cv=job.contractValue, pc=job.budget&&job.budget.projectedCost; return (cv>0 && pc>0)?((cv-pc)/cv*100):null; }
/* ERP Projected Cost is not uniformly trustworthy — the Procore "Projected Costs" double-count
   inflates it on some jobs (live: St. Joe Garages projects $7.3M against a $4.1M revised budget
   and $3.9M spent). Those rows already carry projCostSuspect. Where it is set the projected
   margin is shown but NOT graded and NOT allowed to raise a margin alarm: an unreliable input
   must not become an alarming number, the same discipline that stops an unavailable feed
   becoming a reassuring zero. The job still surfaces — as a data-verification item. */
function projMarginSuspect(job){
  var b=job.budget||{};
  if(b.projCostSuspect) return true;
  if(!(b.projectedCost>0)) return false;
  // Structural checks (Codex #5, tightened R4) — trust only projections in the [90%, 130%]
  // band of revised budget AND at/above cost-to-date. Live data probe 2026-08-01: early jobs
  // carried projections at 16–75% of revised budget (commitments not yet let → fake 50–94%
  // margins); a projection below cost already recorded is invalid on its face. BOTH bounds
  // are enforced here in the consumer (R4 judgment-call fix: the upper bound previously rode
  // only on the producer's projCostSuspect flag, so older payloads without it bypassed).
  var ctd=(job.costToDate!=null)?job.costToDate:b.direct;
  // Named tolerance: cost-to-date is Foundation's posted job cost while the projection is
  // Procore's ERP view, pulled on different nightly schedules — a ≤2% dip is cross-system
  // timing skew on a finishing job, not a structural violation.
  if(ctd>0 && b.projectedCost<ctd*0.98) return true;
  if(b.revised>0 && (b.projectedCost<b.revised*0.9 || b.projectedCost>b.revised*1.3)) return true;
  return false;
}

/* ---- Foundation merge (Procore-revised contract priority; ported from legacy v1.29.0) ---- */
function mergeFoundation(){
  foundationOnly=[];
  if(!activeData || !activeData.jobs) return;
  var fjobs=(foundationData && foundationData.jobs)||{};
  var procoreNums=new Set();
  for(var i=0;i<activeData.jobs.length;i++){
    var j=activeData.jobs[i];
    var num=(j.projectNumber||"").trim(); procoreNums.add(num);
    var f=fjobs[num]; j.flags=[];
    var rev=(j.revisedContract>0)?j.revisedContract:0;
    if(!f){ j.foundation=null; j.costToDate=(j.budget&&j.budget.direct)!=null?j.budget.direct:null; if(rev){ j.procoreContractValue=j.contractValue; j.contractValue=rev; } continue; }
    j.foundation=f;
    if(rev){
      j.procoreContractValue=j.contractValue; j.contractValue=rev;
      var fd=(f.currentContract||0)-rev;
      if(f.currentContract>0 && Math.abs(fd)>50000 && Math.abs(fd)>rev*0.02) j.flags.push({type:"contract",text:"Foundation "+fmtCompact(f.currentContract)});
    } else if(f.currentContract>0){
      j.procoreContractValue=j.contractValue; j.contractValue=f.currentContract;
      var d=j.contractValue-(j.procoreContractValue||0);
      if(j.procoreContractValue && Math.abs(d)>50000 && Math.abs(d)>j.contractValue*0.02) j.flags.push({type:"contract",text:"Procore "+fmtCompact(j.procoreContractValue)});
    }
    j.costToDate=(f.totalCosts!=null)?f.totalCosts:((j.budget&&j.budget.direct)!=null?j.budget.direct:null);
    if(j.costToDate!=null && j.contractValue>0) j.costOverrun=j.costToDate>j.contractValue;
    if(f.jobStatus==="C") j.flags.push({type:"closed",text:"Foundation: closed"});
  }
  foundationOnly=Object.values(fjobs).filter(function(f){ return f.jobStatus==="A" && !procoreNums.has((f.jobNo||"").trim()) && (((f.currentContract||0)>0)||((f.originalContract||0)>0)); });
}

function getActiveJobs(){ return ((activeData&&activeData.jobs)||[]).filter(function(j){ return !CLOSEOUT_STAGES[j.stage]; }); }

/* Greencroft program (2026-07-20 surfaced Foundation-only; 2026-07-21 PROMOTED to full
   board membership, Keith: "they're in all three platforms — no different than the other
   projects"). procore-refresh.js auto-includes active Procore projects matching /greencroft/i
   as normal board jobs carrying program:'greencroft'. greencroftJobs() is built on
   foundationOnly, so it self-shrinks to the LEFTOVERS: units active in Foundation but not
   active in Procore — still shown as WOH F-lines + the Portfolio band. Their Projected
   Budget stays Foundation-sourced everywhere (no ERP budget view exists on these units). */
function isGreencroft(f){ return !!f && /greencroft/i.test((f.customerName||"")+" "+(f.description||"")); }
function greencroftBoardJobs(){ return getActiveJobs().filter(function(j){ return j.program==="greencroft"; }); }
function greencroftJobs(){ return (foundationOnly||[]).filter(isGreencroft)
  .concat(((foundationData&&foundationData.jobs)?Object.values(foundationData.jobs):[]).filter(function(f){
    // $0-contract Greencroft misc jobs fail foundationOnly's contract>0 test but are real work
    return f.jobStatus==="A" && isGreencroft(f) && !((f.currentContract||0)>0||((f.originalContract||0)>0) ) && !jobByNo(f.jobNo);
  })); }
/* Foundation-only coverage EXCLUDING Greencroft — the "no field tracking" worklist */
function foundationOnlyNonGC(){ return (foundationOnly||[]).filter(function(f){ return !isGreencroft(f); }); }
/* Greencroft projected cost = Foundation as-bid cost + CO cost adj (no Procore ERP budget
   exists for these — provenance-marked wherever shown) */
function gcProjCost(f){ if(!f||!(f.originalCost>0)) return null; return f.originalCost+((f.changeOrders&&f.changeOrders.costAdj)||0); }

/* Stage-trust guard (2026-07-08): Procore `stage` is PM-maintained and often stale
   (May 28 audit: wrong/null on 7 of 13 — jobs at 65% cost still marked Pre-Construction).
   Cost activity is the ground truth: >=5% of cost budget spent means the job is in
   construction whatever the stage field says. Consulted by the stoplight, the Portfolio
   stage ⚑, and the data-exceptions worklist. */
function hasCostActivity(j){ return !!j && j.pctComplete!=null && j.pctComplete>=5; }
function stageConflict(j){ return !!j && j.stage==="Pre-Construction" && hasCostActivity(j); }

/* Source deep-links (2026-07-08): every project reference is one click from its record
   in the source system, so a data problem lands next to its fix. */
var BUILDR_ACCT="1411";
// URL shape confirmed against Keith's live session 2026-07-08: RYC lives on the us02 Procore
// zone — us02.procore.com/{procoreId}/project/home. (app.procore.com 404s these project IDs,
// and the webclients form only looked valid because the SPA shell returns 200 unauthenticated.)
function procoreUrl(j){ return (j&&j.procoreId)?("https://us02.procore.com/"+j.procoreId+"/project/home"):null; }
// Budget tool deep-link — Work-on-Hand's "Total Job Costs" = the ERP budget view's Projected
// Budget, so audit scrutiny lands in the Budget tool. URL shape from Keith's live session
// 2026-07-08 (webclients form, unlike project home). View selection is client-state (no URL
// param), so Procore reopens the user's last-selected view — ERP can't be pinned.
var PROCORE_COMPANY="598134325557276";
function procoreBudgetUrl(j){ return (j&&j.procoreId)?("https://us02.procore.com/webclients/host/companies/"+PROCORE_COMPANY+"/projects/"+j.procoreId+"/tools/budgets"):null; }
function buildrUrl(id){ return id?("https://buildr.app/a/"+BUILDR_ACCT+"/projects/"+id):null; }
function buildrIdFor(jno){ var r=buildrData&&buildrData.jobs&&buildrData.jobs[String(jno||"").trim()]; return (r&&r.projectId)||null; }

function getStoplight(job, live){
  var stage=live?live.stage:null, pctComp=live?live.pctComplete:null, costOverrun=live?live.costOverrun:null;
  var finishDate=live?(live.projectedFinish||live.completionDate):null, verifyStatus=live?live.verifyStatus:null;
  var abMargin=asBidMargin(job), burn=contractLessCostToDatePct(job);
  var pSuspect=projMarginSuspect(job), pMargin=pSuspect?null:projectedMargin(job);
  var co=live?live.changeOrders:null;
  var coExposure=(co&&co.netValue&&job.contractValue)?Math.abs(co.netValue)/job.contractValue:0;
  // effective stage: a stale "Pre-Construction" no longer exempts a job with real cost
  // activity from every risk check (the old check silently grayed a job at 65% complete)
  var isPrecon=(stage==="Pre-Construction"&&!hasCostActivity(live))||(!(live&&live.budget)&&(pctComp==null||pctComp===0));
  if(isPrecon) return {color:"gray",reasons:[]};
  // Raw new Date() on a date-only projected finish parses as UTC, so in Eastern time a job
  // whose finish IS today read as one day overdue after 8pm. Calendar days, both sides
  // normalised (Codex closure finding).
  var daysOverdue=finishDate?(RYCFormat.daysSince(finishDate)||0):0;
  var reasons=[];
  if(costOverrun) reasons.push({level:"red",text:"Cost overrun"});
  // Cost recorded to date has passed the contract value — a real overrun, but it is not a
  // "margin to date"; the old label made a spend measure read as profitability.
  if(burn!=null && burn<0) reasons.push({level:"red",text:"Cost to date exceeds contract by "+Math.abs(burn).toFixed(1)+"%"});
  if(pMargin!=null && pMargin<0) reasons.push({level:"red",text:"Projected margin "+pMargin.toFixed(1)+"% at completion"});
  if(daysOverdue>30 && !verifyStatus) reasons.push({level:"red",text:Math.abs(daysOverdue)+" days past projected finish"});
  var red=reasons.some(function(r){return r.level==="red";});
  if(!red){
    if(abMargin!=null && abMargin<5) reasons.push({level:"amber",text:"As-bid margin "+abMargin.toFixed(1)+"% (below 5%)"});
    // Margin erosion, measured the only way that can catch it early: PROJECTED margin at
    // completion vs the AS-BID margin (original contract vs original cost — the corrected
    // baseline; the old current-contract-vs-original-budget "bid" figure manufactured fades
    // whenever a CO raised revenue and cost together).
    if(pctComp!=null && pctComp>=10 && pMargin!=null && abMargin!=null && (abMargin-pMargin)>=GF_MOVE_PTS)
      reasons.push({level:"amber",text:"Margin fading "+pMargin.toFixed(1)+"% projected vs "+abMargin.toFixed(1)+"% as-bid"});
    // Uncertainty and severity are separate dimensions (Codex #5): an unverified projection
    // with NO risk signal is simply ungraded (⚑ on the row + a Data Trust exception — not an
    // alarm), but a NEGATIVE unverified forecast must not soften into silence — it reads as
    // high potential risk until someone verifies the projection.
    if(pSuspect){
      var rawPM=projectedMargin(job);
      if(rawPM!=null && rawPM<0) reasons.push({level:"amber",text:"High potential margin risk — raw projection "+rawPM.toFixed(1)+"% at completion, projected cost UNVERIFIED"});
    }
    if(daysOverdue>=1 && daysOverdue<=30) reasons.push({level:"amber",text:daysOverdue+" days past projected finish"});
    if(coExposure>0.07) reasons.push({level:"amber",text:"CO exposure "+(coExposure*100).toFixed(1)+"% of contract"});
    if(finishDate && !verifyStatus && daysOverdue<=0 && Math.abs(daysOverdue)<=30) reasons.push({level:"amber",text:"Finishing in "+Math.abs(daysOverdue)+" days"});
  }
  var amber=!red && reasons.some(function(r){return r.level==="amber";});
  return {color:red?"red":amber?"amber":"green",reasons:reasons};
}

/* ---- gain/fade (ported; gainFadeFor extracted for the Phase-3a drawer — same math) ---- */
function gainFadeFor(j){
  var f=j.foundation, b=j.budget||{}, pctc=j.pctComplete;
  var pC=j.procoreContractValue!=null?j.procoreContractValue:j.contractValue;
  // Current contract = the canonical merged contractValue (Procore revised > Foundation
  // current > Procore original) — the same figure every other Command surface uses.
  var curContract=(j.contractValue>0)?j.contractValue:((f&&f.currentContract>0)?f.currentContract:pC);
  var asbidContract=(f&&f.originalContract>0)?f.originalContract:pC;
  var asbidCost=(f&&f.originalCost!=null)?f.originalCost:b.original;
  if(!(curContract>0)||asbidCost==null) return null;
  // Projected cost at completion: the row-level ERP projection when present and trusted — the
  // SAME figure the Portfolio row grades (Codex #4: gain/fade previously reconstructed its own
  // projection from budget growth, so the fade table and the row disagreed). Budget-growth
  // reconstruction remains the fallback where no trusted ERP projection exists.
  var src=(!projMarginSuspect(j)&&b.projectedCost>0)?"erp":"recon";
  var projCost=(src==="erp")?b.projectedCost
    :asbidCost+((b.revised>0&&b.original>0)?(b.revised-b.original):0);
  var asbid=(asbidContract-asbidCost)/asbidContract*100;
  var curMargin=(curContract-projCost)/curContract*100;
  var gfPts=curMargin-asbid;
  // Margin-dollar move: (current margin $) − (as-bid margin $). With the budget-growth fallback
  // this reduces to the old CO-income-minus-cost-growth figure; with ERP it stays consistent.
  var gfDollars=(curContract-projCost)-(asbidContract-asbidCost);
  var costToDate=f?f.totalCosts:null;
  var burnPct=(costToDate!=null&&projCost>0)?costToDate/projCost*100:null;
  var burnRisk=burnPct!=null&&pctc!=null&&pctc>=GF_BURN_MINPCT&&(burnPct-pctc)>=GF_BURN_PTS;
  // src: "erp" = trusted row-level projection (gradable); "recon" = budget-growth fallback —
  // a SCENARIO, not a graded financial signal. Alarm surfaces must include only erp rows
  // (Codex R4 #6: a suspect projection was swapped for a reconstruction and then presented
  // as a real fade in the priority queue / Margin & Risk / Executive Brief).
  return {job:j.projectNumber||"",name:j.name||(f&&f.description)||"",pm:pmName(j)||"(no PM)",pct:pctc,gfPts:gfPts,gfDollars:gfDollars,burnRisk:burnRisk,asbidMargin:asbid,curMargin:curMargin,src:src};
}
function gainFadeRows(){
  var rows=[];
  var jobs=getActiveJobs();
  for(var i=0;i<jobs.length;i++){
    var r=gainFadeFor(jobs[i]);
    if(r) rows.push(r);
  }
  return rows;
}

/* ---- billing / AR (ported) ---- */
function activeJobSet(){ var fj=(foundationData&&foundationData.jobs)||{}; var s=new Set(); Object.values(fj).forEach(function(j){ if(j.jobStatus==="A") s.add(String(j.jobNo)); }); return s; }
function arRows(cat,scope){ var active=scope?activeJobSet():null; return ((arData&&arData.invoices)||[]).filter(function(v){ if(v.category!==cat) return false; if(!scope) return true; var isA=active.has(String(v.jobNo||"")); return scope==="active"?isA:!isA; }); }
function overdueByJob(scope){ var m={}; arRows("overdue",scope).forEach(function(v){ var k=String(v.jobNo||""); m[k]=(m[k]||0)+(v.openBalance||0); }); return m; }
function activeAccountRows(){
  var fj=(foundationData&&foundationData.jobs)||{}; var odo=overdueByJob("active"); var rows=[];
  Object.values(fj).forEach(function(f){
    if(f.jobStatus!=="A") return;
    var cost=f.totalCosts||0, estCost=f.originalCost||0, invoiced=f.totalInvoiced||0;
    var contract=f.currentContract||f.originalContract||0, oh=f.ohMarkup, pr=f.profitMarkup;
    var deficit=null, exact=false;
    if(cost>0&&oh>0&&pr>0){ deficit=invoiced-cost*oh*pr; exact=true; }
    else if(cost>0&&estCost>0&&(f.originalContract||0)>0){ deficit=invoiced-cost*(f.originalContract/estCost); }
    rows.push({pm:f.pmName||"(no PM)",job:f.jobNo,name:f.description||"",contract:contract,cost:cost,invoiced:invoiced,retainage:f.retainage||0,deficit:deficit,exact:exact,under:(deficit!=null&&deficit<0)?-deficit:0,over:(deficit!=null&&deficit>0)?deficit:0,overdue:odo[String(f.jobNo)]||0});
  });
  return rows;
}

/* ---- Buildr follow-ups ---- */
function buildrFollowUps(){
  var res={items:[],loaded:0,matched:0,flagged:0};
  if(!buildrData||!buildrData.jobs) return res;
  var byNum={}; getActiveJobs().forEach(function(j){ byNum[String(j.projectNumber||"").trim()]=j; });
  var keys=Object.keys(buildrData.jobs); res.loaded=keys.length;
  keys.forEach(function(k){
    var rec=buildrData.jobs[k];
    var num=String((rec&&rec.projectNumber)||k||"").trim();
    var job=byNum[num]; if(!job) return;
    res.matched++;
    if(rec && rec.needsAttention){
      res.flagged++;
      var last=rec.daysSinceLastMeeting;
      res.items.push({job:num,name:job.name||"",pm:pmName(job)||"(no PM)",buildrId:rec.projectId||null,detail:last==null?"No owner visit logged in Buildr":"Last owner visit "+last+"d ago",open:(rec.openTasks||[]).length});
    }
  });
  return res;
}

// Closeout-aging split (Keith, 2026-07-07): jobs that are cost-complete (>=98%) and >30d past
// projected finish but STILL OPEN in Foundation are in punchlist/closeout — a different leadership
// conversation (retainage tied up, closeout dragging) than financial risk. The REAL closeout test
// is Foundation-side: retainage to zero, all subs paid, job closed. Only jobs whose sole red
// trigger is "past projected finish" move there; a cost-overrun/negative-margin red stays red.
/* RYCFormat.parse, not new Date(): `completionDate` arrives date-only from Procore, and
   `new Date("2026-08-31")` is UTC midnight — four hours early in Eastern time. That pushed
   this count over its day boundary early, and it feeds isCloseoutAging() -> the Overview
   "Closeout aging" list. A job could join that list four hours before it was actually 30
   days past finish (program 1.3). `projectedFinish` carries a time and is unaffected. */
/* Same normalisation as getStoplight — this shared the identical drift: parsing was fixed in
   0.3/1.3 but the SUBTRACTION still mixed a wall-clock instant with a normalised date. */
function daysPastFinish(j){ var fin=j.projectedFinish||j.completionDate; return fin?(RYCFormat.daysSince(fin)||0):0; }
function isCloseoutAging(j){ return daysPastFinish(j)>30 && j.pctComplete!=null && j.pctComplete>=98 && !!j.foundation; }
function isCloseoutOnly(j){ var sl=getStoplight(j,j);
  return sl.color==="red" && isCloseoutAging(j) &&
    sl.reasons.filter(function(r){return r.level==="red";}).every(function(r){return r.text.indexOf("past projected finish")>-1;});
}


/* ===== Company cohorts — every total says what it counts (program 0.2 / 0.2a / 5.1) =======
   THE RULE (Keith, 2026-08-02): a job is CONSTRUCTION SERVICES when its contract value is
   under $150,000. Size, not source.

   That distinction is the whole point. The plan's first draft treated "active in Foundation
   but absent from the Procore board" as the segment, and Codex was right that this is a
   COVERAGE DIFFERENCE, not a business one — that population can just as easily contain a $2M
   project nobody onboarded. Reading it as a segment would have relabelled an integration gap
   as revenue. A size test cuts cleanly across coverage instead of colliding with it:

     under $150k, on the board or not      -> Construction Services
     >= $150k and NOT on the board         -> a coverage exception; a real project the board
                                              does not carry, reported as coverage, never as
                                              segment revenue
     >= $150k and on the board             -> ordinary Procore-managed construction

   The threshold reads CURRENT contract (original + change orders), matching every other
   active-work figure in Command. A job awarded at $120k that grows past $150k therefore
   MIGRATES out of the segment; that is visible rather than silent, and the alternative
   (pinning at award) would show a now-$400k job inside a segment labelled "under $150k".

   A job with no contract value at all is UNCLASSIFIED — never folded into the segment, and
   counted so it cannot disappear. "Unavailable is never zero" applies to cohorts too. */
var CS_THRESHOLD=150000;
function jobContractValue(f){
  if(!f) return null;
  return (f.currentContract>0)?f.currentContract:((f.originalContract>0)?f.originalContract:null);
}
function segmentOf(f){
  var c=jobContractValue(f);
  if(c==null) return "unclassified";
  return c<CS_THRESHOLD?"construction_services":"construction";
}
/* One pass over the active Foundation record, so every surface quoting a company total quotes
   the same partition. Every dollar lands in exactly one bucket or in excluded-with-reason —
   the reconciliation the brief asks for, rather than figures that happen not to add up. */
function companyRollup(){
  var fj=(foundationData&&foundationData.jobs)||{};
  var board=new Set(((activeData&&activeData.jobs)||[]).map(function(j){return String(j.projectNumber||"").trim();}));
  var out={ services:{n:0,contract:0,cost:0,billed:0},
            onBoard:{n:0,contract:0,cost:0,billed:0},
            coverageGap:{n:0,contract:0,cost:0,billed:0},
            unclassified:{n:0,cost:0,billed:0},
            greencroft:{n:0,contract:0} };
  Object.values(fj).forEach(function(f){
    if(f.jobStatus!=="A") return;
    var seg=segmentOf(f), c=jobContractValue(f)||0, on=board.has(String(f.jobNo||"").trim());
    if(isGreencroft(f)){ out.greencroft.n++; out.greencroft.contract+=c; }
    if(seg==="unclassified"){ out.unclassified.n++; out.unclassified.cost+=(f.totalCosts||0); out.unclassified.billed+=(f.totalInvoiced||0); return; }
    var b=(seg==="construction_services")?out.services:(on?out.onBoard:out.coverageGap);
    b.n++; b.contract+=c; b.cost+=(f.totalCosts||0); b.billed+=(f.totalInvoiced||0);
  });
  out.total={ n:out.services.n+out.onBoard.n+out.coverageGap.n,
              contract:out.services.contract+out.onBoard.contract+out.coverageGap.contract };
  return out;
}
/* The one-line inclusion statement. A company-wide figure that does not say what it counts is
   the failure the brief calls out, so this is cheap enough that no surface has an excuse. */
function cohortNote(r){
  var bits=["<b>"+fmt(r.total.contract)+"</b> across "+r.total.n+" active jobs"];
  bits.push(r.onBoard.n+" Procore-managed ("+fmtCompact(r.onBoard.contract)+")");
  bits.push(r.services.n+" Construction Services, under "+fmtCompact(CS_THRESHOLD)+" ("+fmtCompact(r.services.contract)+")");
  if(r.coverageGap.n) bits.push("<span class=\"m-a\">"+r.coverageGap.n+" not on the board ("+fmtCompact(r.coverageGap.contract)+") — a coverage gap, not a segment</span>");
  if(r.unclassified.n) bits.push("<span class=\"m-m\">"+r.unclassified.n+" with no contract value — unclassified, excluded from the totals above</span>");
  return bits.join(" · ");
}
