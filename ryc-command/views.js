"use strict";
/* ryc-command/views.js — all view renderers + job-detail drawer
   Split from index.html (Phase 7). Classic scripts, load order: core → views → app. */
/* ===== Command Center ======================================================== */
function projectedGrossMargin(){
  var jobs=getActiveJobs(), tC=0, tPC=0;
  jobs.forEach(function(j){ var b=j.budget||{}; var pc=b.revised>0?b.revised:(b.original>0?b.original:0);
    // Greencroft board jobs carry no Procore budget — their projected cost is Foundation as-bid + CO cost adj
    if(!(pc>0) && j.program==="greencroft" && j.foundation) pc=gcProjCost(j.foundation)||0;
    if(j.contractValue>0&&pc>0){ tC+=j.contractValue; tPC+=pc; } });
  // Greencroft leftovers (active in Foundation, not on the Procore board)
  greencroftJobs().forEach(function(f){ var c=(f.currentContract>0)?f.currentContract:(f.originalContract||0); var pc=gcProjCost(f); if(c>0&&pc>0){ tC+=c; tPC+=pc; } });
  return tC>0?((tC-tPC)/tC*100):null;
}

function renderCommand(){
  var haveFnd=!!(foundationData&&foundationData.jobs);
  var haveAr=!!(arData&&arData.invoices);
  var jobs=getActiveJobs();
  var gc=greencroftJobs();
  var gcContract=gc.reduce(function(s,f){return s+((f.currentContract>0)?f.currentContract:(f.originalContract||0));},0);
  var totalContract=jobs.reduce(function(s,j){return s+(j.contractValue||0);},0)+gcContract;
  var lights=jobs.map(function(j){return {j:j,sl:getStoplight(j,j)};});
  var closeouts=lights.filter(function(x){ return isCloseoutOnly(x.j); });
  var closeoutSet=new Set(closeouts.map(function(x){return x.j;}));
  var reds=lights.filter(function(x){return x.sl.color==="red" && !closeoutSet.has(x.j);});
  var ambers=lights.filter(function(x){return x.sl.color==="amber";});
  var gm=projectedGrossMargin();
  var accts=haveFnd?activeAccountRows():[];
  var needsInv=accts.reduce(function(s,r){return s+r.under;},0);
  var overdue=accts.reduce(function(s,r){return s+r.overdue;},0);
  var flagged=reds.length+ambers.length;
  var missing=[];
  if(!activeData||!activeData.jobs) missing.push("Procore");
  if(!haveFnd) missing.push("Foundation");
  if(!haveAr) missing.push("AR");
  var warn=missing.length?("<div class=\"warn-banner\">⚠️ "+missing.join(" + ")+" feed unavailable — affected figures show <b>Unavailable</b>, not $0.</div>"):"";

  /* KPI strip */
  function kpi(l,v,s,cls){ return "<div class=\"kpi\"><div class=\"kl\">"+l+"</div><div class=\"kv "+(cls||"")+"\">"+v+"</div><div class=\"ks\">"+(s||"")+"</div></div>"; }
  var strip="<div class=\"kpi-strip\">"
    +kpi("Active contract value",fmt(totalContract),(jobs.length+gc.length)+" active jobs — incl. "+(greencroftBoardJobs().length+gc.length)+" Greencroft"+(gc.length?" ("+gc.length+" off-board)":""),"accent")
    +kpi("Projected gross margin",gm!=null?gm.toFixed(1)+"%":"—","forecast · Procore budget",(gm!=null&&gm<8)?"warn":"")
    +kpi("Overdue AR (active)",haveAr?fmtCompact(overdue):"Unavailable",haveAr?"needs collection":"AR feed down",haveAr?(overdue>0?"bad":""):"warn")
    +kpi("Needs invoicing",haveFnd?fmtCompact(needsInv):"Unavailable",haveFnd?"earned, not billed":"Foundation feed down",haveFnd?(needsInv>0?"warn":""):"warn")
    +kpi("Jobs flagged",String(flagged),reds.length+" red · "+ambers.length+" amber · "+closeouts.length+" closeout",flagged>0?"warn":"")
    +"</div>";

  /* Priority queue */
  function row(cls,name,jno,detail,val,vcls){
    return "<div class=\"q-row "+cls+"\"><div class=\"q-job\">"+esc(name)+"<span class=\"q-jno\">"+esc(jno||"")+"</span></div>"
      +"<div class=\"q-detail\">"+detail+"</div>"+(val!=null?"<div class=\"q-val "+(vcls||"")+"\">"+val+"</div>":"")+"</div>";
  }
  function section(title,n,rowsHtml,empty,badge){
    return "<div class=\"qsec\"><div class=\"qh\">"+title+" <span class=\"qn\">"+(badge!=null?badge:n)+"</span></div>"+(n?rowsHtml:"<div class=\"q-empty\">"+empty+"</div>")+"</div>";
  }
  // red
  var redRows=reds.map(function(x){ var r=x.sl.reasons.filter(function(z){return z.level==="red";}).map(function(z){return z.text;}).join(" · "); return row("red",x.j.name||"",x.j.projectNumber,"<b>"+esc(r)+"</b>",fmtCompact(x.j.contractValue),""); }).join("");
  // amber
  var amberRows=ambers.map(function(x){ var r=x.sl.reasons.filter(function(z){return z.level==="amber";}).map(function(z){return z.text;}).join(" · "); return row("amber",x.j.name||"",x.j.projectNumber,esc(r),fmtCompact(x.j.contractValue),""); }).join("");
  // closeout aging — Foundation-side closeout test: retainage still held, billing gap, job still open
  var closeoutRows=closeouts.map(function(x){
    var j=x.j, f=j.foundation||{};
    var leftToBill=(j.contractValue||0)-(f.totalInvoiced||0);
    var bits=[daysPastFinish(j)+"d past projected finish","<b>"+fmtCompact(f.retainage||0)+"</b> retainage held"];
    if(leftToBill>1000) bits.push("<b>"+fmtCompact(leftToBill)+"</b> left to bill");
    bits.push(esc(pmName(j)||"(no PM)"));
    return row("closeout",j.name||"",j.projectNumber,bits.join(" · ")+srcLink(procoreUrl(j),"Procore"),fmtCompact(j.contractValue),"");
  }).join("");
  // data conflicts — Procore revised vs Foundation contract divergence (⚑ flags), surfaced for reconciliation
  var conflicts=jobs.filter(function(j){return j.revisedContract>0 && j.foundation && j.foundation.currentContract>0 &&
    Math.abs(j.foundation.currentContract-j.revisedContract)>50000 && Math.abs(j.foundation.currentContract-j.revisedContract)>j.revisedContract*0.02;});
  var conflictRows=conflicts.map(function(j){
    var d=j.revisedContract-j.foundation.currentContract;
    var detail="Procore revised <b>"+fmtCompact(j.revisedContract)+"</b> vs Foundation <b>"+fmtCompact(j.foundation.currentContract)+"</b> · "
      +(d>0?"Procore ahead — check CO posting in Foundation":"Foundation ahead — check Procore prime contract")+srcLink(procoreUrl(j),"Procore");
    return row("conflict",j.name||"",j.projectNumber,detail,"Δ "+fmtCompact(Math.abs(d)),"warn");
  }).join("");
  // billing follow-up: needs-invoiced + overdue
  var billAll=accts.filter(function(r){return r.under>1000||r.overdue>0;}).sort(function(a,b){return (b.under+b.overdue)-(a.under+a.overdue);});
  var billCount=billAll.length;
  var billRows=billAll.slice(0,10).map(function(r){ var bits=[]; if(r.under>0) bits.push("needs invoicing <b>"+fmtCompact(r.under)+"</b>"+(r.exact?"":" <span style=\"color:var(--faint)\">(bid-est)</span>")); if(r.overdue>0) bits.push("overdue AR <b>"+fmtCompact(r.overdue)+"</b>"); return row("info",r.name||"",r.job,bits.join(" · ")+" · "+esc(r.pm),null,""); }).join("");
  var billBadge=!haveFnd?"n/a":(billCount>10?"top 10 of "+billCount:String(billCount));
  // margin fades
  var fades=gainFadeRows().filter(function(r){return r.gfPts<=-GF_MOVE_PTS;}).sort(function(a,b){return a.gfPts-b.gfPts;}).slice(0,8);
  var fadeRows=fades.map(function(r){ return row("fade",r.name,r.job,"fading <b>"+r.gfPts.toFixed(1)+" pts</b>"+(r.burnRisk?" · cost-burn risk":"")+" · "+esc(r.pm),fmtCompact(r.gfDollars),r.gfDollars<0?"bad":""); }).join("");
  // client follow-ups (Buildr)
  var bf=buildrFollowUps();
  var cfuRows=bf.items.slice(0,10).map(function(r){ return row("info",r.name,r.job,esc(r.detail)+(r.open?" · <b>"+r.open+" open</b>":"")+" · "+esc(r.pm)+srcLink(buildrUrl(r.buildrId),"Buildr"),null,""); }).join("");
  var cfuEmpty=bf.loaded===0?"Buildr feed unavailable.":(bf.matched===0?bf.loaded+" Buildr projects loaded, but none matched active job numbers — check the join.":"0 flagged · "+bf.loaded+" loaded, "+bf.matched+" matched active jobs.");

  var queue="<div class=\"panel\"><h3>Priority queue</h3><div class=\"sub\">What leadership should talk about this week — jobs to act on, most urgent first. Contract = Procore Revised; billing/AR/cost = Foundation.</div>"
    +section("🔴 Needs attention now",reds.length,redRows,"No red jobs — no financial or genuine schedule risk flagged.")
    +section("🟠 Watch",ambers.length,amberRows,"No amber jobs.")
    +section("🏁 Closeout aging",closeouts.length,closeoutRows,"No jobs stuck in closeout.")
    +section("💵 Billing & cash follow-up",(haveFnd?billCount:1),(haveFnd?billRows:"<div class=\"q-empty\">Foundation data unavailable — billing/AR not computed.</div>"),"Nothing needs invoicing or overdue.",billBadge)
    +section("📉 Margin fades",fades.length,fadeRows,"No jobs fading.")
    +section("⚖️ Data conflicts",conflicts.length,conflictRows,"Procore and Foundation contracts agree on every job.")
    +section("🤝 Client follow-up (Buildr)",bf.items.length,cfuRows,cfuEmpty)
    +"</div>";

  /* source-health strip — freshness from each feed's own `refreshed` timestamp; >30h = stale
     (Procore cron daily 04:00 UTC, Foundation/AR nightly 09:00 UTC — 30h means a run was missed) */
  function chip(ok,label,detail,ts){
    var a=ageTxt(ts); var stale=ts?((Date.now()-new Date(ts))/3600000>30):false;
    var icon=!ok?"⚠️":(stale?"⚠️":"✅");
    return "<div class=\"src-chip\">"+icon+" <b>"+label+"</b> "+detail+(a?(" · "+a+(stale?" <b style=\"color:var(--amber)\">STALE</b>":"")):"")+"</div>";
  }
  var fCount=foundationData&&foundationData.jobs?Object.keys(foundationData.jobs).length:0;
  var health="<div class=\"panel\"><h3>Source health</h3><div class=\"sub\">Every feed the cockpit reads, loaded live from the same endpoints as the legacy dashboard — with the age of each feed's data.</div><div class=\"src-strip\">"
    +chip(!!activeData,"Procore",((activeData&&activeData.jobs)||[]).length+" active · revised contracts",activeData&&activeData.refreshed)
    +chip(!!foundationData,"Foundation",fCount+" jobs · cost/billing/AR",foundationData&&foundationData.refreshed)
    +chip(!!arData,"AR",(((arData&&arData.invoices)||[]).length)+" invoices",arData&&arData.refreshed)
    +chip(!!buildrData,"Buildr",(buildrData&&buildrData.jobs?Object.keys(buildrData.jobs).length:0)+" projects",buildrData&&buildrData.refreshed)
    +chip(!!bcData,"BC bid board",(bcData&&bcData.published?bcData.published.length:0)+" out to bid",bcData&&bcData.generatedAt)
    +chip(foundationOnly.length>=0,"Coverage",foundationOnlyNonGC().length+" Foundation-only active jobs not on board · Greencroft: "+greencroftBoardJobs().length+" on board + "+gc.length+" Foundation-only",null)
    +"</div></div>";

  return warn+strip+queue+health;
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
      closeoutStage:!!CLOSEOUT_STAGES[j.stage],
      contract:j.contractValue||0, conflict:(j.flags||[]).some(function(f){return f.type==="contract";}),
      ctd:(j.costToDate!=null?j.costToDate:null), pct:j.pctComplete,
      mtd:marginToDate(j), cm:contractedMargin(j),
      needsInv:b?b.under:0, overdue:b?b.overdue:0,
      status:isCloseoutOnly(j)?"closeout":sl.color,
      reasons:sl.reasons.map(function(r){return r.text;}).join(" · "),
      conf:conf, confRank:conf.rank };
  });
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
function updatePTable(){
  var rows=_pfRows.slice();
  if(pfFilter==="active") rows=rows.filter(function(r){return !r.closeoutStage;});
  else if(pfFilter!=="all") rows=rows.filter(function(r){return r.status===pfFilter;});
  if(pfSearch) rows=rows.filter(function(r){ return (r.name+" "+r.jno+" "+r.pm+" "+r.client+" "+r.stage).toLowerCase().indexOf(pfSearch)>-1; });
  var c=pfSort.col, d=pfSort.dir;
  rows.sort(function(a,b){ var va=a[c], vb=b[c];
    if(typeof va==="string"||typeof vb==="string"){ va=(va==null?"":String(va)).toLowerCase(); vb=(vb==null?"":String(vb)).toLowerCase(); return va<vb?-d:va>vb?d:0; }
    va=(va==null?-Infinity:va); vb=(vb==null?-Infinity:vb); return (va-vb)*d; });
  var tb="";
  rows.forEach(function(r){
    var mcls=r.mtd==null?"m-m":r.mtd>=10?"m-g":r.mtd>=5?"m-a":"m-r";
    var bill="";
    if(r.needsInv>1000) bill="<span class=\"m-a\">inv "+fmtCompact(r.needsInv)+"</span>";
    if(r.overdue>0) bill+=(bill?" · ":"")+"<span class=\"m-r\">od "+fmtCompact(r.overdue)+"</span>";
    if(!bill) bill="<span class=\"m-m\">—</span>";
    tb+="<tr tabindex=\"0\" role=\"button\" data-jno=\""+attrEsc(r.jno)+"\" aria-label=\"Open job detail: "+attrEsc(r.name)+"\">"
      +"<td><div class=\"jname\">"+esc(r.name)+"</div><div class=\"jno\">"+esc(r.jno)+(r.client?" · "+esc(r.client):"")+srcLink(r.procoreUrl,"Procore")+"</div></td>"
      +"<td>"+esc(r.pm||"—")+"</td><td>"+esc(r.stage||"—")+(r.stageConflict?" <span title=\"Procore stage says Pre-Construction but the job shows real cost activity — stage is stale; update it in Procore (see Data exceptions)\" style=\"color:#c07f1a;cursor:help\">⚑</span>":"")+"</td>"
      +"<td class=\"r\">"+fmtCompact(r.contract)+(r.conflict?" <span title=\"Procore and Foundation contracts diverge — see Data conflicts on the Command Center\" style=\"color:#c07f1a\">⚑</span>":"")+"</td>"
      +"<td class=\"r\">"+(r.ctd!=null?fmtCompact(r.ctd):"—")+"</td>"
      +"<td class=\"r\">"+(r.pct!=null?Math.round(r.pct)+"%":"—")+"</td>"
      +"<td class=\"r\"><span class=\""+mcls+"\">"+(r.mtd!=null?r.mtd.toFixed(1)+"%":"—")+"</span>"+(r.cm!=null?"<div class=\"cell-sub\">bid "+r.cm.toFixed(1)+"%</div>":"")+"</td>"
      +"<td>"+bill+"</td>"
      +"<td>"+statusPill(r.status,r.reasons)+"</td>"
      +"<td><span class=\"conf "+r.conf.cls+"\">"+r.conf.txt+"</span></td>"
      +"</tr>";
  });
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
  var cols=[["name","Job"],["pm","PM"],["stage","Stage"],["contract","Contract"],["ctd","Cost to date"],["pct","%"],["mtd","Margin"],["needsInv","Billing"],["status","Status"],["confRank","Conf"]];
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
  document.getElementById("view").innerHTML=bar
    +"<div class=\"ptable-wrap\"><table class=\"ptable\"><thead>"+head+"</thead><tbody id=\"ptbody\"></tbody><tfoot id=\"ptfoot\"></tfoot></table></div>"
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
function rowAttr(jno){ return jobByNo(jno)?(" data-jno=\""+attrEsc(jno)+"\" tabindex=\"0\" role=\"button\""):" class=\"static\""; }
function hookDrawerRows(){
  Array.prototype.forEach.call(document.querySelectorAll(".view tbody"),function(tb){
    tb.addEventListener("click",function(e){ var tr=e.target.closest("tr[data-jno]"); if(tr) openDrawer(tr.getAttribute("data-jno"),tr); });
    tb.addEventListener("keydown",function(e){ if(e.key==="Enter"||e.key===" "){ var tr=e.target.closest("tr[data-jno]"); if(tr){ e.preventDefault(); openDrawer(tr.getAttribute("data-jno"),tr); } } });
  });
}
function renderBilling(){
  var view=document.getElementById("view");
  var haveFnd=!!(foundationData&&foundationData.jobs), haveAr=!!(arData&&arData.invoices);
  if(!haveFnd&&!haveAr){ view.innerHTML="<div class=\"warn-banner\">⚠️ Foundation + AR feeds unavailable — billing cannot be computed. Figures show Unavailable, not $0.</div>"; return; }
  var warn=(!haveFnd||!haveAr)?("<div class=\"warn-banner\">⚠️ "+(!haveFnd?"Foundation":"AR")+" feed unavailable — affected figures show <b>Unavailable</b>, not $0.</div>"):"";
  var accts=haveFnd?activeAccountRows():[];
  var needsInv=accts.reduce(function(s,r){return s+r.under;},0);
  var needsInvN=accts.filter(function(r){return r.under>1000;}).length;
  var retainage=accts.reduce(function(s,r){return s+(r.retainage||0);},0);

  /* aging — Jason split: current (<=90d, the list leadership chases) vs aged tail (>90d + retainage-era items) */
  var over=haveAr?arRows("overdue","active"):[];
  var buckets=[0,0,0,0];
  over.forEach(function(v){ buckets[agingBucket(v.daysOverdue||0)]+=(v.openBalance||0); });
  var current=buckets[0]+buckets[1], aged=buckets[2]+buckets[3];

  function kpi(l,v,s,cls){ return "<div class=\"kpi\"><div class=\"kl\">"+l+"</div><div class=\"kv "+(cls||"")+"\">"+v+"</div><div class=\"ks\">"+(s||"")+"</div></div>"; }
  var strip="<div class=\"kpi-strip k4\">"
    +kpi("Needs invoicing",haveFnd?fmtCompact(needsInv):"Unavailable",haveFnd?(needsInvN+" active jobs"):"Foundation feed down",needsInv>0?"warn":"")
    +kpi("Current overdue (≤90d)",haveAr?fmtCompact(current):"Unavailable",haveAr?"the actionable list":"AR feed down",current>0?"bad":"")
    +kpi("Aged overdue (>90d)",haveAr?fmtCompact(aged):"Unavailable",haveAr?(fmtCompact(buckets[3])+" of it 180d+"):"AR feed down",aged>0?"warn":"")
    +kpi("Retainage held",haveFnd?fmtCompact(retainage):"Unavailable","active jobs","")
    +"</div>";

  /* overdue AR by job, bucketed */
  var byJob={};
  over.forEach(function(v){
    var k=String(v.jobNo||"");
    if(!byJob[k]) byJob[k]={jno:k,name:v.jobName||"",b:[0,0,0,0],total:0,oldest:0};
    var r=byJob[k]; r.b[agingBucket(v.daysOverdue||0)]+=(v.openBalance||0); r.total+=(v.openBalance||0);
    if((v.daysOverdue||0)>r.oldest) r.oldest=v.daysOverdue||0;
  });
  var arJobs=Object.values(byJob).sort(function(a,b){return b.total-a.total;});
  var fj=(foundationData&&foundationData.jobs)||{};
  var arRowsHtml=arJobs.map(function(r){
    var pm=fj[r.jno]?fj[r.jno].pmName:null;
    function cell(v){ return "<td class=\"r\">"+(v>0?fmtCompact(v):"<span class=\"m-m\">—</span>")+"</td>"; }
    return "<tr"+rowAttr(r.jno)+"><td><div class=\"jname\">"+esc(r.name)+"</div><div class=\"jno\">"+esc(r.jno)+(pm?" · "+esc(pm):"")+"</div></td>"
      +cell(r.b[0])+cell(r.b[1])+cell(r.b[2])+cell(r.b[3])
      +"<td class=\"r\"><b>"+fmtCompact(r.total)+"</b></td><td class=\"r\">"+r.oldest+"d</td></tr>";
  }).join("");
  var arTotalRow="<tr><td>"+arJobs.length+" jobs</td>"+buckets.map(function(v){return "<td class=\"r\">"+fmtCompact(v)+"</td>";}).join("")+"<td class=\"r\">"+fmtCompact(current+aged)+"</td><td></td></tr>";
  var arTable=arJobs.length
    ?("<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Job</th><th class=\"r\">1–30d</th><th class=\"r\">31–90d</th><th class=\"r\">91–180d</th><th class=\"r\">180d+</th><th class=\"r\">Total</th><th class=\"r\">Oldest</th></tr></thead><tbody>"+arRowsHtml+"</tbody><tfoot>"+arTotalRow+"</tfoot></table></div>")
    :"<div class=\"vsub\">No overdue AR on active jobs.</div>";

  /* billing position worklist */
  var flagged=accts.filter(function(r){return r.under>1000||r.overdue>0;});
  var posRows=(blShowAll?accts:flagged).slice().sort(function(a,b){return (b.under+b.overdue)-(a.under+a.overdue);});
  var posHtml=posRows.map(function(r){
    var ni=r.under>0?("<span class=\"m-a\">"+fmtCompact(r.under)+"</span>"+(r.exact?"":" <span class=\"cell-sub\">bid-est</span>")):(r.over>0?("<span class=\"m-g\">+"+fmtCompact(r.over)+"</span>"):"<span class=\"m-m\">—</span>");
    return "<tr"+rowAttr(r.job)+"><td><div class=\"jname\">"+esc(r.name)+"</div><div class=\"jno\">"+esc(String(r.job))+" · "+esc(r.pm)+"</div></td>"
      +"<td class=\"r\">"+fmtCompact(r.contract)+"</td><td class=\"r\">"+fmtCompact(r.cost)+"</td><td class=\"r\">"+fmtCompact(r.invoiced)+"</td>"
      +"<td class=\"r\">"+ni+"</td><td class=\"r\">"+(r.retainage>0?fmtCompact(r.retainage):"<span class=\"m-m\">—</span>")+"</td>"
      +"<td class=\"r\">"+(r.overdue>0?("<span class=\"m-r\">"+fmtCompact(r.overdue)+"</span>"):"<span class=\"m-m\">—</span>")+"</td></tr>";
  }).join("");
  var posTable=haveFnd
    ?("<div class=\"pbar\"><button class=\"pfill"+(blShowAll?"":" on")+"\" onclick=\"blShowAll=false;renderBilling()\">Flagged ("+flagged.length+")</button>"
      +"<button class=\"pfill"+(blShowAll?" on":"")+"\" onclick=\"blShowAll=true;renderBilling()\">All active ("+accts.length+")</button></div>"
      +"<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Job</th><th class=\"r\">Contract</th><th class=\"r\">Cost to date</th><th class=\"r\">Billed</th><th class=\"r\">Needs invoiced</th><th class=\"r\">Retainage</th><th class=\"r\">Overdue AR</th></tr></thead><tbody>"+posHtml+"</tbody></table></div>"
      +"<div class=\"vsub\" style=\"margin-top:8px\">Needs invoiced = cost × OH × Profit markups − billed (Holly's exact markups; \"bid-est\" = bid-ratio fallback). Positive green = billed ahead of cost (cash-positive, not behind).</div>")
    :"<div class=\"vsub\">Foundation feed unavailable.</div>";

  /* legacy / closed-job overdue */
  var legacy=haveAr?arRows("overdue","legacy"):[];
  var legacyTotal=legacy.reduce(function(s,v){return s+(v.openBalance||0);},0);
  var lgByJob={};
  legacy.forEach(function(v){ var k=String(v.jobNo||""); if(!lgByJob[k]) lgByJob[k]={jno:k,name:v.jobName||"",total:0,oldest:0}; lgByJob[k].total+=(v.openBalance||0); if((v.daysOverdue||0)>lgByJob[k].oldest) lgByJob[k].oldest=v.daysOverdue||0; });
  var lgRows=Object.values(lgByJob).sort(function(a,b){return b.total-a.total;}).slice(0,15).map(function(r){
    return "<tr class=\"static\"><td><div class=\"jname\">"+esc(r.name)+"</div><div class=\"jno\">"+esc(r.jno)+"</div></td><td class=\"r\">"+fmtCompact(r.total)+"</td><td class=\"r\">"+r.oldest+"d</td></tr>";
  }).join("");
  var legacySec=legacy.length
    ?("<details class=\"lgcy\"><summary>Legacy / closed-job overdue AR — "+fmtCompact(legacyTotal)+" across "+legacy.length+" invoices (kept off the active view)</summary>"
      +"<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Job</th><th class=\"r\">Overdue</th><th class=\"r\">Oldest</th></tr></thead><tbody>"+lgRows+"</tbody></table></div></details>")
    :"";

  view.innerHTML=warn+strip
    +"<div class=\"vhead\">Overdue AR by job — active work</div><div class=\"vsub\">Aged 90d+ is the tail leadership is not actively chasing (old finals, retainage-era items) — split out so the current number is the actionable one.</div>"+arTable
    +"<div class=\"vhead\">Billing position — active jobs</div><div class=\"vsub\">Earned vs billed per job from Foundation. Click a row for the job drawer (jobs on the Procore board).</div>"+posTable
    +legacySec;
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
    if(j.budget&&j.budget.projCostSuspect) exc.push({jno:j.projectNumber,name:j.name,issue:"Projected cost ⚑ verify",detail:"ERP projected cost "+fmtCompact(j.budget.projectedCost)+" exceeds revised budget "+fmtCompact(j.budget.revised)+" by >30% — sub costs may be double-booked in Direct"+pl});
    if(j.budget&&j.budget.projectedCost==null&&j.stage!=="Pre-Construction") exc.push({jno:j.projectNumber,name:j.name,issue:"Missing projected cost",detail:"No ERP-view Projected Costs on an in-flight job"+pl});
    if(!j.foundation&&j.stage!=="Pre-Construction") exc.push({jno:j.projectNumber,name:j.name,issue:"No Foundation match",detail:"Financials are Procore-only — unverified by accounting"});
  });
  return exc;
}

/* ===== Margin & Risk (Phase 4 — light operator view) ========================= */
function renderMargin(){
  var view=document.getElementById("view");
  var jobs=getActiveJobs();
  var haveFnd=!!(foundationData&&foundationData.jobs);
  var warn=(!activeData||!activeData.jobs)?"<div class=\"warn-banner\">⚠️ Procore feed unavailable.</div>":(!haveFnd?"<div class=\"warn-banner\">⚠️ Foundation feed unavailable — gain/fade falls back to Procore-only figures.</div>":"");

  /* gain/fade */
  var gf=gainFadeRows().sort(function(a,b){return a.gfPts-b.gfPts;});
  var fading=gf.filter(function(r){return r.gfPts<=-GF_MOVE_PTS;});
  var fadeDollars=fading.reduce(function(s,r){return s+r.gfDollars;},0);
  var gaining=gf.filter(function(r){return r.gfPts>=GF_MOVE_PTS;});

  /* buyout rollup (Phase 3b data) */
  var bo=jobs.filter(function(j){return j.commitments&&j.budget&&((j.budget.revised>0)||(j.budget.original>0));})
    .map(function(j){ var cb=j.budget.revised>0?j.budget.revised:j.budget.original;
      return {j:j,jno:j.projectNumber||"",name:j.name||"",pm:pmName(j)||"(no PM)",pct:j.pctComplete,budget:cb,
        committed:j.commitments.committedTotal,pending:j.commitments.pendingTotal||0,
        uncommitted:cb-j.commitments.committedTotal,cov:cb>0?(j.commitments.committedTotal/cb*100):null}; });
  var boBudget=bo.reduce(function(s,r){return s+r.budget;},0);
  var boCommitted=bo.reduce(function(s,r){return s+r.committed;},0);
  var boCov=boBudget>0?(boCommitted/boBudget*100):null;

  /* exceptions (shared with Data Trust) */
  var exc=buildExceptions(jobs);

  var gm=projectedGrossMargin();
  function kpi(l,v,s,cls){ return "<div class=\"kpi\"><div class=\"kl\">"+l+"</div><div class=\"kv "+(cls||"")+"\">"+v+"</div><div class=\"ks\">"+(s||"")+"</div></div>"; }
  var strip="<div class=\"kpi-strip k4\">"
    +kpi("Projected gross margin",gm!=null?gm.toFixed(1)+"%":"—","forecast · Procore budget",(gm!=null&&gm<8)?"warn":"")
    +kpi("Margin fades",String(fading.length),fading.length?("net "+fmtCompact(fadeDollars)+" vs as-bid"):"no jobs fading",fading.length?"bad":"")
    +kpi("Buyout coverage",boCov!=null?boCov.toFixed(0)+"%":"—",fmtCompact(boCommitted)+" committed of "+fmtCompact(boBudget),"")
    +kpi("Data exceptions",String(exc.length),exc.length?"need reconciliation":"all clean",exc.length?"warn":"")
    +"</div>";

  /* gain/fade table */
  function pcls(v){ return v==null?"m-m":v<=-GF_MOVE_PTS?"m-r":v>=GF_MOVE_PTS?"m-g":"m-m"; }
  var gfHtml=gf.map(function(r){
    return "<tr"+rowAttr(r.job)+"><td><div class=\"jname\">"+esc(r.name)+"</div><div class=\"jno\">"+esc(r.job)+" · "+esc(r.pm)+"</div></td>"
      +"<td class=\"r\">"+(r.pct!=null?Math.round(r.pct)+"%":"—")+"</td>"
      +"<td class=\"r\">"+r.asbidMargin.toFixed(1)+"%</td><td class=\"r\">"+r.curMargin.toFixed(1)+"%</td>"
      +"<td class=\"r\"><span class=\""+pcls(r.gfPts)+"\">"+(r.gfPts>=0?"+":"")+r.gfPts.toFixed(1)+"</span></td>"
      +"<td class=\"r\"><span class=\""+pcls(r.gfDollars>=0?1.1:-1.1)+"\">"+fmtCompact(r.gfDollars)+"</span></td>"
      +"<td>"+(r.burnRisk?"<span class=\"m-r\">⚠ burn</span>":"<span class=\"m-m\">—</span>")+"</td></tr>";
  }).join("");
  var gfTable=gf.length
    ?("<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Job</th><th class=\"r\">%</th><th class=\"r\">As-bid</th><th class=\"r\">Current</th><th class=\"r\">Δ pts</th><th class=\"r\">Δ $</th><th>Cost burn</th></tr></thead><tbody>"+gfHtml+"</tbody></table></div>")
    :"<div class=\"vsub\">No jobs with enough data for gain/fade.</div>";

  /* buyout table */
  var boHtml=bo.slice().sort(function(a,b){return b.uncommitted-a.uncommitted;}).map(function(r){
    return "<tr"+rowAttr(r.jno)+"><td><div class=\"jname\">"+esc(r.name)+"</div><div class=\"jno\">"+esc(r.jno)+" · "+esc(r.pm)+"</div></td>"
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

  /* exceptions table */
  var excHtml=exc.map(function(r){
    return "<tr"+rowAttr(r.jno||"")+"><td><div class=\"jname\">"+esc(r.name||"")+"</div><div class=\"jno\">"+esc(r.jno||"")+"</div></td><td>"+esc(r.issue)+"</td><td style=\"white-space:normal\">"+r.detail+"</td></tr>";
  }).join("");
  var excTable=exc.length
    ?("<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Job</th><th>Issue</th><th>Detail</th></tr></thead><tbody>"+excHtml+"</tbody></table></div>")
    :"<div class=\"vsub\">No data exceptions — Procore and Foundation agree everywhere.</div>";

  var fOnly=foundationOnlyNonGC().slice().sort(function(a,b){return (b.currentContract||0)-(a.currentContract||0);});
  var fOnlySec=fOnly.length
    ?("<details class=\"lgcy\"><summary>"+fOnly.length+" active Foundation jobs not on the Procore board (excl. Greencroft — surfaced on Work on Hand) — "+fmtCompact(fOnly.reduce(function(s,f){return s+(f.currentContract||0);},0))+" of contract value with no field/PM tracking</summary>"
      +"<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Job</th><th>PM</th><th class=\"r\">Contract</th><th class=\"r\">Cost to date</th><th class=\"r\">Billed</th></tr></thead><tbody>"
      +fOnly.slice(0,15).map(function(f){ return "<tr class=\"static\"><td><div class=\"jname\">"+esc(f.description||"")+"</div><div class=\"jno\">"+esc(f.jobNo||"")+"</div></td><td>"+esc(f.pmName||"—")+"</td><td class=\"r\">"+fmtCompact(f.currentContract||0)+"</td><td class=\"r\">"+fmtCompact(f.totalCosts||0)+"</td><td class=\"r\">"+fmtCompact(f.totalInvoiced||0)+"</td></tr>"; }).join("")
      +"</tbody></table></div>"+(fOnly.length>15?"<div class=\"vsub\" style=\"margin-top:6px\">Top 15 by contract shown.</div>":"")+"</details>")
    :"";

  view.innerHTML=warn+strip
    +"<div class=\"vhead\">Gain / fade — margin movement vs as-bid</div><div class=\"vsub\">Current projected margin vs the margin the job was bid at (Foundation as-bid + Procore cost growth). Worst first. ⚠ burn = cost burn running ≥12 pts ahead of % complete.</div>"+gfTable
    +"<div class=\"vhead\">Buyout exposure — committed vs cost budget</div><div class=\"vsub\">Procore sub + PO contracts vs revised cost budget. Uncommitted = still to buy (includes RYC-carried general conditions). Sorted by open exposure.</div>"+boTable
    +"<div class=\"vhead\">Data exceptions</div><div class=\"vsub\">Cross-source disagreements to reconcile before quoting numbers — the audit-layer worklist.</div>"+excTable
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
    +srow("Buildr","Client-relations visits + follow-up tasks","Live API on page load",buildrData&&buildrData.refreshed,(buildrData&&buildrData.jobs?Object.keys(buildrData.jobs).length:0)+" projects",!!buildrData)
    +srow("BC bid board","Projects out to bid, trade-package invite coverage, bids received (Estimating view)","Daily 09:30 UTC (VM, bc-bidboard)",bcData&&bcData.generatedAt,(bcData&&bcData.published?bcData.published.length+" out to bid":"—"),!!bcData)
    +srow("Portfolio archive","Completed jobs (pegged at archive time)","On job completion",null,((portfolioData&&portfolioData.jobs)||portfolioData||[]).length?(((portfolioData&&portfolioData.jobs)||portfolioData||[]).length+" jobs"):"—",!!portfolioData)
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
    +"<div class=\"vhead\">Source health</div><div class=\"vsub\">Every feed this cockpit reads, its cadence, and the age of the data on screen right now.</div>"+srcTable
    +"<div class=\"vhead\">Reconciliation exceptions</div><div class=\"vsub\">Cross-source disagreements currently open — the audit-layer worklist.</div>"+excSummary
    +"<div class=\"vhead\" style=\"display:flex;align-items:center;gap:10px\">Field provenance reference <button class=\"pfill\" onclick=\"printDS()\">🖨 Print</button></div>"
    +"<div class=\"vsub\">The shared Data Sources dictionary — one definition, loaded by this cockpit, the legacy dashboard, and the Foundation query tool. Git-tracked source: RYC_Dashboard_Data_Dictionary.md.</div>"
    +"<div id=\"ds-panel\" style=\"background:#fff;border:1px solid #dfe4ec;border-radius:var(--r);padding:18px 22px\">"
    +(typeof dataSourcesHTML==="function"?dataSourcesHTML():"<div class=\"vsub\">data-sources.js failed to load — provenance reference unavailable.</div>")
    +"</div></div>";
  hookDrawerRows();
}

/* ===== AI Assistant (Phase 6 — the /ryc/foundation NL→SQL, restyled) ========= */
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
    var s=fcMonthIdx(new Date(p.startDate)), e=fcMonthIdx(new Date(p.endDate));
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
function renderForecast(){
  var view=document.getElementById("view");
  if(!forecastData||!forecastData.projects){
    view.innerHTML="<div class=\"warn-banner\">⚠️ Buildr forecast feed unavailable — revenue projections cannot be computed. Figures show Unavailable, not $0.</div>";
    return;
  }
  var projects=forecastData.projects;
  var booked=projects.filter(function(p){return p.status!=="pursuit";});
  var pursuit=projects.filter(function(p){return p.status==="pursuit";});
  var sp=fcSpread(projects);
  var months=Object.keys(sp.buckets).map(Number).sort(function(a,b){return a-b;});
  var CAP=18, capIdx=sp.nowIdx+CAP-1;
  var bookedFwd=0, potentialFwd=0, next12b=0, next12p=0;
  months.forEach(function(m){
    var b=sp.buckets[m];
    bookedFwd+=b.booked; potentialFwd+=b.potential;
    if(m<sp.nowIdx+12){ next12b+=b.booked; next12p+=b.potential; }
  });
  var undatedAmt=sp.undated.reduce(function(s,p){return s+p.amount;},0);

  function kpi(l,v,s,cls){ return "<div class=\"kpi\"><div class=\"kl\">"+l+"</div><div class=\"kv "+(cls||"")+"\">"+v+"</div><div class=\"ks\">"+(s||"")+"</div></div>"; }
  var strip="<div class=\"kpi-strip k4\">"
    +kpi("Booked forward revenue",fmtCompact(bookedFwd),booked.length+" active + awarded jobs","accent")
    +kpi("Pipeline (pursuit)",fmtCompact(pursuit.reduce(function(s,p){return s+p.amount;},0)),pursuit.length+" pursuits · "+fmtCompact(potentialFwd)+" dated/spread","")
    +kpi("Next 12 months",fmtCompact(next12b+next12p),fmtCompact(next12b)+" booked · "+fmtCompact(next12p)+" potential","")
    +kpi("Undated (not in spread)",fmtCompact(undatedAmt),sp.undated.length+" projects missing start/end dates",sp.undated.length?"warn":"")
    +"</div>";

  /* period table — month rows + quarter subtotals + grand total (Steve's Buildr display) */
  var rows="", qB=0,qP=0, tB=0,tP=0, beyondB=0,beyondP=0, lastQ=null;
  function qKey(m){ var y=Math.floor(m/12), q=Math.floor((m%12)/3)+1; return "Q"+q+" "+y; }
  function qRow(label,b,p){ return "<tr style=\"background:#f7f9fc;font-weight:700\"><td>"+label+"</td><td class=\"r\">"+fmtCompact(b)+"</td><td class=\"r\">"+fmtCompact(p)+"</td><td class=\"r\">"+fmtCompact(b+p)+"</td></tr>"; }
  var lastIdx=Math.min(sp.horizon,capIdx);
  for(var m=sp.nowIdx;m<=lastIdx;m++){
    var b=sp.buckets[m]||{booked:0,potential:0};
    var q=qKey(m);
    if(lastQ!==null&&q!==lastQ){ rows+=qRow(lastQ+" subtotal",qB,qP); qB=0;qP=0; }
    lastQ=q;
    qB+=b.booked; qP+=b.potential; tB+=b.booked; tP+=b.potential;
    rows+="<tr class=\"static\"><td>"+fcMonthLabel(m)+"</td><td class=\"r\">"+(b.booked>0?fmtCompact(b.booked):"<span class=\"m-m\">—</span>")+"</td><td class=\"r\">"+(b.potential>0?fmtCompact(b.potential):"<span class=\"m-m\">—</span>")+"</td><td class=\"r\"><b>"+fmtCompact(b.booked+b.potential)+"</b></td></tr>";
  }
  if(lastQ!==null) rows+=qRow(lastQ+" subtotal",qB,qP);
  months.forEach(function(m){ if(m>capIdx){ beyondB+=sp.buckets[m].booked; beyondP+=sp.buckets[m].potential; } });
  if(beyondB+beyondP>0){ tB+=beyondB; tP+=beyondP; rows+="<tr class=\"static\"><td>Beyond "+fcMonthLabel(capIdx)+"</td><td class=\"r\">"+fmtCompact(beyondB)+"</td><td class=\"r\">"+fmtCompact(beyondP)+"</td><td class=\"r\"><b>"+fmtCompact(beyondB+beyondP)+"</b></td></tr>"; }
  var periodTable="<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Period</th><th class=\"r\">Booked</th><th class=\"r\">Potential</th><th class=\"r\">Total</th></tr></thead><tbody>"+rows
    +"</tbody><tfoot><tr><td>Total forward</td><td class=\"r\">"+fmtCompact(tB)+"</td><td class=\"r\">"+fmtCompact(tP)+"</td><td class=\"r\">"+fmtCompact(tB+tP)+"</td></tr></tfoot></table></div>";

  /* project detail tables */
  function projRows(list){
    return list.slice().sort(function(a,b){return (b.amount||0)-(a.amount||0);}).map(function(p){
      var dated=p.startDate&&p.endDate;
      return "<tr"+rowAttr(p.projectNumber||"")+"><td><div class=\"jname\">"+esc(p.name)+"</div><div class=\"jno\">"+esc(p.company||"")+(p.assignedTo?" · "+esc(p.assignedTo):"")+srcLink(buildrUrl(p.id),"Buildr")+"</div></td>"
        +"<td>"+esc(p.status==="pursuit"?(p.stage||"pursuit"):p.status)+"</td>"
        +"<td>"+(dated?(fmtDate(p.startDate)+" → "+fmtDate(p.endDate)):"<span class=\"m-a\">no dates</span>"+srcLink(buildrUrl(p.id),"fix"))+"</td>"
        +"<td class=\"r\">"+fmtCompact(p.amount)+"</td>"
        +"<td class=\"r\">"+(p.profit>0?fmtCompact(p.profit):"<span class=\"m-m\">—</span>")+"</td></tr>";
    }).join("");
  }
  function projTable(title,list){
    var total=list.reduce(function(s,p){return s+(p.amount||0);},0);
    return "<details class=\"lgcy\"><summary>"+title+" — "+list.length+" projects · "+fmtCompact(total)+"</summary>"
      +"<div class=\"ptable-wrap\" style=\"margin-top:8px\"><table class=\"ptable\"><thead><tr><th>Project</th><th>Status / stage</th><th>Schedule</th><th class=\"r\">Amount</th><th class=\"r\">Buildr profit</th></tr></thead><tbody>"+projRows(list)+"</tbody></table></div></details>";
  }

  /* reconciliation vs Procore/Foundation left-to-bill */
  var recon="";
  if(activeData&&activeData.jobs&&foundationData&&foundationData.jobs){
    var woh=wohRows().filter(function(r){return !r.gc;}); /* board scope — the Buildr cross-check predates Greencroft rows */
    var leftToBill=woh.reduce(function(s,r){return s+((r.contract||0)-(r.billed||0));},0);
    var buildrActiveFwd=0;
    var spA=fcSpread(projects.filter(function(p){return p.status==="active";}));
    Object.values(spA.buckets).forEach(function(b){ buildrActiveFwd+=b.booked; });
    var d=buildrActiveFwd-leftToBill;
    recon="<div class=\"vhead\">Cross-check — Buildr vs the board</div>"
      +"<div class=\"vsub\">Buildr <b>active</b> forward revenue (linear spread) = <b>"+fmtCompact(buildrActiveFwd)+"</b> vs Procore/Foundation left-to-bill on the "+woh.length+" board jobs (Contract − Billings) = <b>"+fmtCompact(leftToBill)+"</b> · Δ "+fmtCompact(Math.abs(d))+". "
      +"They measure the same work differently: Buildr covers ALL "+projects.filter(function(p){return p.status==="active";}).length+" active Buildr projects (incl. jobs not on the Procore board) and spreads linearly from original schedules; left-to-bill is actuals-based. A large gap = stale Buildr schedules/amounts or board coverage — worth a look, not an alarm.</div>";
  }

  /* undated worklist — the actionable data-fix queue, visible by default (not buried in the
     collapsed tables): each row deep-links to its Buildr card so entering dates is one click away */
  var undatedSec="";
  if(sp.undated.length){
    var uRows=sp.undated.slice().sort(function(a,b){return (b.amount||0)-(a.amount||0);}).map(function(p){
      return "<tr class=\"static\"><td><div class=\"jname\">"+esc(p.name)+srcLink(buildrUrl(p.id),"Buildr — add dates")+"</div><div class=\"jno\">"+esc(p.company||"")+(p.assignedTo?" · "+esc(p.assignedTo):"")+"</div></td>"
        +"<td>"+esc(p.status==="pursuit"?(p.stage||"pursuit"):p.status)+"</td>"
        +"<td class=\"r\">"+fmtCompact(p.amount)+"</td></tr>";
    }).join("");
    undatedSec="<div class=\"vhead\">Undated projects — not in the spread</div>"
      +"<div class=\"vsub\">"+sp.undated.length+" projects · "+fmtCompact(undatedAmt)+" carry no start/end dates in Buildr, so Buildr&#8217;s own Forecast silently drops them. Click through and enter dates to pull them into the projection.</div>"
      +"<div class=\"ptable-wrap\"><table class=\"ptable\"><thead><tr><th>Project</th><th>Status / stage</th><th class=\"r\">Amount</th></tr></thead><tbody>"+uRows+"</tbody></table></div>";
  }

  view.innerHTML=strip
    +"<div class=\"vhead\">Revenue by period</div><div class=\"vsub\">Each project&#8217;s amount spread evenly across its start → end months, from this month forward — the same math as Buildr&#8217;s Forecast report (Steve&#8217;s revenue projections). Booked = active + awarded/upcoming · Potential = pursuits (unweighted). Undated projects are excluded from the spread and totaled in the KPI above.</div>"
    +periodTable
    +undatedSec
    +"<div class=\"vhead\">Projects behind the numbers</div><div class=\"vsub\">Straight from Buildr — BD&#8217;s system of record (Brad/Jake maintain it). Every row links to its Buildr card. Source freshness: "+(ageTxt(forecastData.refreshed)||"live")+".</div>"
    +projTable("Booked — active + awarded",booked)
    +projTable("Pipeline — pursuits",pursuit)
    +recon;
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
    view.innerHTML="<div class=\"warn-banner\">⚠️ BuildingConnected bid-board feed unavailable (/ryc-dashboard/bc-bidboard.json) — figures show Unavailable, not $0. The daily VM pull (bc-bidboard) may not have run yet.</div>";
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
    +"<div class=\"vsub\">Straight from BuildingConnected (read-only, pulled daily; this pull "+(ageTxt(bcData.generatedAt)||"just now")+"). <b>At risk</b> = a trade package with zero bids received and zero subs committed to bidding — the packages that come in empty on bid day unless someone works the phones. Estimating tools: <a href=\"/ryc/estimate\" style=\"color:var(--accent);font-weight:600\">/ryc/estimate</a>.</div>"
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
function briefDol(n){ return n==null?"<span class=\"m-m\">—</span>":(n<0?"$("+Math.abs(Math.round(n)).toLocaleString("en-US")+")":"$"+Math.round(n).toLocaleString("en-US")); }
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
    +sb("Projected gross margin",gm!=null?gm.toFixed(1)+"%":"—","forecast, Procore budgets")
    +sb("Billed to date",haveFnd?fmtCompact(woh.reduce(function(s,r){return s+(r.billed||0);},0)):"Unavailable","Foundation, active jobs")
    +"</div>";

  /* attention list: reds + closeout + biggest fades */
  var lights=jobs.map(function(j){return {j:j,sl:getStoplight(j,j)};});
  var closeouts=lights.filter(function(x){return isCloseoutOnly(x.j);});
  var closeoutSet=new Set(closeouts.map(function(x){return x.j;}));
  var reds=lights.filter(function(x){return x.sl.color==="red"&&!closeoutSet.has(x.j);});
  var fades=gainFadeRows().filter(function(r){return r.gfPts<=-GF_MOVE_PTS;}).sort(function(a,b){return a.gfPts-b.gfPts;});
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

  view.innerHTML=warn+"<div class=\"brief\">"
    +"<div class=\"bh\"><div><h1>Executive Brief</h1><div class=\"bsub\">R. Yoder Construction — active work · as of "+dateStr+" · Procore data "+(pAge||"—")+", Foundation "+(fAge||"—")+"</div></div>"
    +"<div class=\"brief-actions\"><button class=\"pfill\" onclick=\"briefPresent()\">🖥 Present</button><button class=\"pfill\" onclick=\"window.print()\">🖨 Print</button></div></div>"
    +"<div class=\"brief-sec\">"+band+"</div>"
    +"<div class=\"brief-sec\"><h2>What needs attention</h2><div class=\"ssub\">Real risk, aging closeouts, and the biggest margin fades — the week&#8217;s conversation list.</div>"+riskHtml+"</div>"
    +"<div class=\"brief-sec\"><h2>Billing &amp; cash</h2><div class=\"ssub\">"+cashSub+"</div>"+watchHtml+"</div>"
    +"<div class=\"brief-foot\">"+(conflicts?("<b>"+conflicts+"</b> contract conflict(s) between Procore and Foundation are open — see Margin &amp; Risk → Data exceptions before quoting those jobs. "):"Procore and Foundation contracts agree on every active job. ")
    +"The Work-on-Hand Analysis table lives on the <b>Work on Hand</b> view (sortable, as-of date gate, CSV). "
    +"Decision-layer figures (margins, stoplights, gain/fade) are forecasts; source-of-record figures (cost, billings, AR, Work-on-Hand) mirror Foundation. Full provenance: RYC_Dashboard_Data_Dictionary.md.</div>"
    +"</div>";
  hookDrawerRows();
}

/* ===== Job detail drawer (Phase 3a — existing data only; commitments arrive in 3b) ===== */
var _dwTrigger=null;
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
function drawerHtml(j){
  var f=j.foundation||null, b=j.budget||{}, sl=getStoplight(j,j);
  var status=isCloseoutOnly(j)?"closeout":sl.color;
  var reasons=sl.reasons.map(function(r){return r.text;}).join(" · ");
  var bill=billingByJob()[String(j.projectNumber)]||null;
  var gf=gainFadeFor(j);
  var mtd=marginToDate(j), cm=contractedMargin(j);
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
  var atCompletion=(j.contractValue>0&&b.projectedCost>0)?((j.contractValue-b.projectedCost)/j.contractValue*100):null;
  var snap="<div class=\"dw-sec\"><h4>Financial snapshot</h4><div class=\"dw-stats\">"
    +stat("Contract",fmtCompact(j.contractValue),j.revisedContract>0?"Procore revised":"Foundation")
    +stat("Cost to date",j.costToDate!=null?fmtCompact(j.costToDate):"—",f?"Foundation actuals":"Procore direct")
    +stat("Complete",j.pctComplete!=null?Math.round(j.pctComplete)+"%":"—",dpf>0?dpf+"d past finish":"")
    +stat("Margin to date",mtd!=null?mtd.toFixed(1)+"%":"—",cm!=null?"bid "+cm.toFixed(1)+"%":"")
    +stat("Proj. cost (ERP)",b.projectedCost>0?fmtCompact(b.projectedCost):"—",(b.projCostSuspect?"⚑ verify · ":"")+(atCompletion!=null?"margin at compl. "+atCompletion.toFixed(1)+"%":""))
    +stat("Gain / fade",gf?(gf.gfPts>=0?"+":"")+gf.gfPts.toFixed(1)+" pts":"—",gf?fmtCompact(gf.gfDollars)+(gf.burnRisk?" · cost-burn risk":""):"insufficient data")
    +"</div></div>";

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
    +stat("Work type",esc((j.workType||"—").replace(/_/g," ")),"")
    +stat("Client type",esc(j.clientType||"—"),"")
    +"</div></div>";

  /* source trail */
  var trail="<div class=\"dw-sec\"><h4>Source trail</h4><table class=\"dwt\">"
    +"<tr><th>Fields</th><th>Source</th><th class=\"r\">Data age</th></tr>"
    +"<tr><td>Contract (revised)</td><td>Procore prime contract</td><td class=\"r\">"+(pAge||"—")+"</td></tr>"
    +"<tr><td>Cost, billed, retainage, PM, CO postings</td><td>Foundation nightly ODBC</td><td class=\"r\">"+(fAge||"—")+"</td></tr>"
    +"<tr><td>Open / overdue invoices</td><td>Foundation AR feed</td><td class=\"r\">"+(aAge||"—")+"</td></tr>"
    +"<tr><td>Schedule, %, RFIs, submittals, CO types</td><td>Procore daily cache</td><td class=\"r\">"+(pAge||"—")+"</td></tr>"
    +"<tr><td>Commitments / buyout</td><td>Procore sub + PO contracts (daily cache)</td><td class=\"r\">"+(pAge||"—")+"</td></tr>"
    +"</table><div class=\"dw-note\">Full field-by-field provenance: 📖 Data Sources on the legacy dashboard, or RYC_Dashboard_Data_Dictionary.md.</div></div>";

  return head+"<div class=\"dw-body\">"+snap+recon+billing+buyout+costSec+coSec+field+trail+"</div>";
}
function openDrawer(jno,trigger){
  var j=jobByNo(jno); if(!j) return;
  closeDrawer(true);
  _dwTrigger=trigger||null;
  var wrap=document.createElement("div"); wrap.id="dwrap";
  wrap.innerHTML="<div class=\"dw-overlay\" onclick=\"closeDrawer()\"></div><aside class=\"drawer\" role=\"dialog\" aria-modal=\"true\" aria-label=\"Job detail: "+attrEsc(j.name||jno)+"\">"+drawerHtml(j)+"</aside>";
  document.body.appendChild(wrap);
  document.addEventListener("keydown",dwEsc);
  var cb=wrap.querySelector(".dw-close"); if(cb) cb.focus();
}
function dwEsc(e){ if(e.key==="Escape") closeDrawer(); }
function closeDrawer(silent){
  var w=document.getElementById("dwrap");
  if(!w) return;
  w.remove();
  document.removeEventListener("keydown",dwEsc);
  if(!silent&&_dwTrigger&&document.contains(_dwTrigger)) _dwTrigger.focus();
  _dwTrigger=null;
}


/* ===== PM Load (v2.21.0) — per-PM workload history + forward hiring signal.
   Source: /ryc-dashboard/pm-history.json (Foundation ODBC weekly pull — the only system
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
    view.innerHTML="<div class=\"warn-banner\">&#9888;&#65039; PM history feed unavailable (/ryc-dashboard/pm-history.json) — workload history cannot be computed. Figures show Unavailable, not $0.</div>";
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

  view.innerHTML=strip
    +"<div class=\"panel\"><h3>Annual billed revenue by job tier</h3><div class=\"sub\">Where the dollars actually are — the service tail is ~1% of revenue but most of the job count</div>"+legend+svg1+annualTable+"</div>"
    +"<div class=\"panel\"><h3>The load question</h3><div class=\"sub\">Same bench, roughly double the dollars — full-load = billed &ge;$2M in the year</div>"+pair+"</div>"
    +"<div class=\"panel\"><h3>When to hire</h3><div class=\"sub\">Forward revenue vs what the current bench sustainably carries</div>"+hire+"</div>"
    +"<div class=\"panel\"><h3>Per-PM detail</h3><div class=\"sub\">Sparkline = annual billed 2021&rarr;2026 &middot; active job counts and $ under management are core-tier, Foundation job status A</div>"+pmTable+caveats+"</div>";
  pmBindTips(view);
}
