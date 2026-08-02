"use strict";
/* ryc-command/app.js — gate, nav, data boot
   Split from index.html (Phase 7). Classic scripts, load order: core → views → app. */
/* ---- gate / nav / boot ---- */
function showApp(){ document.getElementById("gate").style.display="none"; document.getElementById("app").hidden=false; init(); }
function tryGate(){ var v=document.getElementById("gate-input").value.trim(); if(v==="ryc2026"){ sessionStorage.setItem("ryc_cmd_auth","1"); showApp(); } else { document.getElementById("gate-err").textContent="Incorrect access code"; } }
document.getElementById("gate-btn").addEventListener("click",tryGate);
document.getElementById("gate-input").addEventListener("keydown",function(e){ if(e.key==="Enter") tryGate(); });

function bust(u){ return u+(u.indexOf("?")>-1?"&":"?")+"t="+Date.now(); }
function getJSON(u){ return fetch(bust(u)).then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); }).catch(function(){ return null; }); }
function loadData(){
  return Promise.all([
    getJSON("/ryc-data/procore-cache.json"),
    getJSON(CRM+"/api/ryc-foundation"),
    getJSON(CRM+"/api/ryc-ar"),
    getJSON(CRM+"/api/ryc-buildr"),
    getJSON("/ryc-data/ryc-portfolio.json"),
    getJSON("/ryc-data/ryc-subcontractors.json"),
    getJSON(CRM+"/api/ryc-buildr-forecast"),
    getJSON("/ryc-data/bc-bidboard.json"),
    getJSON("/ryc-data/pm-history.json")
  ]).then(function(r){
    activeData=r[0]; foundationData=r[1]; arData=r[2]; buildrData=r[3]; portfolioData=r[4]; subsData=r[5]; forecastData=r[6]; bcData=r[7]; pmHistData=r[8]; loadedAt=new Date();
    mergeFoundation();
  });
}

/* On-demand Foundation refresh — POSTs to /api/ryc-foundation-refresh (Vercel proxy →
   VM foundation-refresh.sh → ODBC → CRM Supabase, ~5s), then reloads all feeds.
   VM enforces a single-flight lock + 5-min success cooldown; statuses surface on the button. */
function refreshFoundation(btn){
  if(!btn||btn.disabled) return;
  var orig=btn.textContent;
  btn.disabled=true; btn.textContent="⟳ Refreshing…";
  function restore(msg){
    btn.textContent=msg;
    setTimeout(function(){ btn.disabled=false; btn.textContent=orig; },4000);
  }
  fetch("/api/ryc-foundation-refresh",{method:"POST"})
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(d.status==="completed"){
        btn.textContent="⟳ Reloading data…";
        return loadData().then(function(){ renderView(); });
      }
      if(d.status==="cooldown"){ restore("Fresh — retry in "+Math.ceil((d.retry_in_s||300)/60)+" min"); return; }
      if(d.status==="running"){ restore("Already running…"); return; }
      restore("Failed — see Data Trust");
    })
    .catch(function(){ restore("Unreachable"); });
}

/* On-demand Procore refresh — ported from the legacy dashboard at cutover (plan §7
   "preserve: Refresh Procore behavior"; the retired legacy page was its only nav path).
   POST /api/ryc-active → VM procore-refresh.js → git push of procore-cache.json →
   Vercel redeploy (~75s) — hence the poll + deploy wait before reloading feeds. */
function refreshProcore(btn){
  if(!btn||btn.disabled) return;
  var orig=btn.textContent;
  btn.disabled=true; btn.textContent="⟳ Starting…";
  function done(msg){ btn.textContent=msg; setTimeout(function(){ btn.disabled=false; btn.textContent=orig; },6000); }
  fetch("/api/ryc-active",{method:"POST"})
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(d.status==="started"||d.status==="already_running"){
        btn.textContent="⟳ Running (~2-3 min)…";
        var poll=setInterval(function(){
          fetch("/api/ryc-active?check=status").then(function(r){ return r.json(); }).then(function(sd){
            if(sd.last_result==="completed"){
              clearInterval(poll);
              btn.textContent="⟳ Waiting for deploy…";
              setTimeout(function(){ loadData().then(function(){ renderView(); btn.disabled=false; btn.textContent=orig; }); },75000);
            } else if(sd.last_result&&!sd.running){
              clearInterval(poll); done("Finished: "+sd.last_result);
            }
          }).catch(function(){});
        },10000);
      } else { done("Refresh "+(d.status||"failed")); }
    })
    .catch(function(){ done("Unreachable"); });
}

/* Phase C: the rail is the SHARED shell component, mounted once. NAV's flat list (with its
   `grp` labels) is folded into the shell's group shape here — Command's destinations are
   unchanged, but the grammar rendering them is now the same one the Estimating Desk uses, so
   the two workspaces cannot drift into two different navigations.
   The Estimating Desk cross-link is gone from the rail: the workspace switcher IS that link,
   and having both was the duplicate entry Codex flagged. */
function renderNav(){
  if(typeof RYCShell==="undefined") return;
  var groups=[], byGrp={};
  NAV.forEach(function(n){
    if(n.key==="deskLink") return;               // the switcher covers this
    var g=n.grp||"";
    if(!byGrp[g]){ byGrp[g]={label:g,items:[]}; groups.push(byGrp[g]); }
    byGrp[g].items.push({key:n.key,label:n.label,icon:n.ic});
  });
  RYCShell.mount({
    workspace:"command",
    version:"v2.35.0-command · phase C shell + path routes",
    active:currentView,
    groups:groups,
    onSelect:function(k){ setView(k); },
    onLock:function(){ sessionStorage.removeItem("ryc_cmd_auth"); location.reload(); }
  });
}
/* ===== PHASE C ROUTING — paths, not hashes (contract v1.1 §3) =========================
   Canonical: /command/<view> · /command/jobs/<job_uuid>
   A JOB IS ADDRESSED BY ITS IMMUTABLE UUID, never by its Foundation job number (contract D5):
   job numbers get corrected, reformatted and reused, so a URL built on one silently changes
   meaning. The number remains the display and search key and resolves through ryc_job_aliases. */
var CMD_BASE="/command";
var _cmdRouting=false, _jobIdCache=null;
function cmdUrl(k){ return CMD_BASE+"/"+k; }
function setView(k){
  closeDrawer(true); currentView=k;
  if(typeof RYCShell!=="undefined") RYCShell.setActive(k);
  renderView();
  if(!_cmdRouting && location.pathname!==cmdUrl(k)) history.pushState({v:k},"",cmdUrl(k));
}
// job_no <-> uuid, loaded once
function loadJobIds(){
  if(_jobIdCache) return Promise.resolve(_jobIdCache);
  return fetch("/api/ryc-estimate-log",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({pw:"ryc2026",action:"job_ids"})})
    .then(function(r){ return r.ok?r.json():{jobs:[]}; })
    .catch(function(){ return {jobs:[]}; })
    .then(function(d){ _jobIdCache={byId:{},byNo:{}};
      (d.jobs||[]).forEach(function(j){ _jobIdCache.byId[j.id]=j.job_no; _jobIdCache.byNo[j.job_no]=j.id; });
      return _jobIdCache; });
}
function openJobById(uuid){
  return loadJobIds().then(function(m){
    var no=m.byId[uuid];
    if(!no){ renderCmdNotFound("No job matches that address."); return; }
    window._dwRouting=true;                 // the URL is already correct — don't rewrite it
    try{ setViewSilent("portfolio"); openDrawer(no,null); }
    finally{ window._dwRouting=false; }
  });
}
function jobUrl(jno){ var m=_jobIdCache; var id=m&&m.byNo[jno]; return id?CMD_BASE+"/jobs/"+id:null; }
function setViewSilent(k){ _cmdRouting=true; try{ setView(k); } finally { _cmdRouting=false; } }
function renderCmdNotFound(msg){
  setViewSilent("command");
  var v=document.getElementById("view");
  if(v) v.innerHTML="<div class=\"panel\"><div class=\"h\">Page not found</div><div class=\"sub\">"+esc(msg)
    +"</div><div style=\"margin-top:10px\"><button class=\"pfill\" onclick=\"goCommand()\">Go to Overview</button></div></div>";
}
function goCommand(){ history.pushState({},"",cmdUrl("command")); routeCmd(); }
var LEGACY_CMD_HASH={dashboard:"command"};
function routeCmd(){
  var h=(location.hash||"").replace(/^#\/?/,"");
  if(h){ // legacy hash bookmark → canonical path, replaced (a fragment never reaches the server)
    var k=LEGACY_CMD_HASH[h]||h;
    var jm=h.match(/^job\/(.+)$/);
    history.replaceState({},"",jm?CMD_BASE+"/jobs/"+jm[1]:cmdUrl(NAV.some(function(n){return n.key===k;})?k:"command"));
  }
  var parts=location.pathname.replace(/\/+$/,"").split("/").filter(Boolean);
  if(parts[0]!=="command"){ history.replaceState({},"",cmdUrl("command")); return routeCmd(); }
  if(parts[1]==="jobs"&&parts[2]){ return openJobById(parts[2]); }
  var key=parts[1]||"command";
  if(!NAV.some(function(n){ return n.key===key && !n.href; })) return renderCmdNotFound("There is no “"+key+"” page in Command.");
  setViewSilent(key);
}
window.addEventListener("popstate",function(){ routeCmd(); });
/* per-view provenance — the topbar must not claim Foundation on views that never read it */
var FDN_FED={command:1,portfolio:1,billing:1,woh:1,margin:1,brief:1,trust:1};
function viewCtx(){
  var loaded=loadedAt?loadedAt.toLocaleString():"…";
  if(currentView==="forecast") return "Buildr (BD's system of record) · pulled live · loaded "+loaded;
  if(currentView==="estimating") return "BuildingConnected (read-only, daily pull) · this pull "+((bcData&&ageTxt(bcData.generatedAt))||"…");
  if(currentView==="ai") return "Foundation via live ODBC · queries run at ask time (not the nightly snapshot)";
  if(currentView==="pmload") return "Foundation billing/cost history (full job record, 2021&rarr;) · pull "+((pmHistData&&ageTxt(pmHistData.generatedAt))||"&hellip;");
  if(currentView==="subs") return "Foundation actual-by-vendor + PO_Sub subcontracts (2023&rarr; jobs) · nightly VM rollup · this pull "+((subsData&&ageTxt(subsData.generated))||"&hellip;");
  if(currentView==="completed") return "Foundation completed record (2023&rarr;, pegged at completion) + Procore enrichment · rebuilt nightly · this pull "+((portfolioData&&ageTxt(portfolioData.generated))||"&hellip;");
  if(currentView==="trust") return "All sources · loaded "+loaded;
  if(currentView==="integrations") return "Sync-run telemetry (server-recorded) · read-only";
  return "Procore (revised contract) + Foundation · loaded "+loaded;
}
function renderView(){
  var titles={command:"Overview",portfolio:"Portfolio",billing:"Billing & Cash",woh:"Work on Hand",margin:"Margin & Risk",subs:"Subcontractors",completed:"Completed",pmload:"PM Load",forecast:"Revenue Forecast",estimating:"Estimating — Bid Board",brief:"Executive Brief",trust:"Data Trust",integrations:"Integrations & Sync",ai:"AI Assistant"};
  document.getElementById("view-title").textContent=titles[currentView]||"Overview";
  document.getElementById("view-ctx").innerHTML=viewCtx();
  var view=document.getElementById("view");
  // dark showcase for the Command Center; light operator theme for work views (FundView tiering)
  document.querySelector(".content").classList.toggle("light",currentView!=="command");
  // the brief carries its own editorial header (title + date + freshness) — drop the redundant topbar
  document.querySelector(".topbar").style.display=(currentView==="brief")?"none":"";
  if(currentView==="command"){ view.innerHTML=renderCommand(); loadCommandDeltas(); return; }
  if(currentView==="portfolio"){ renderPortfolio(); return; }
  if(currentView==="billing"){ renderBilling(); return; }
  if(currentView==="woh"){ renderWOH(); return; }
  if(currentView==="margin"){ renderMargin(); return; }
  if(currentView==="subs"){ renderSubs(); return; }
  if(currentView==="completed"){ renderCompleted(); return; }
  if(currentView==="pmload"){ renderPMLoad(); return; }
  if(currentView==="forecast"){ renderForecast(); return; }
  if(currentView==="estimating"){ renderEstimating(); return; }
  if(currentView==="brief"){ renderBrief(); return; }
  if(currentView==="trust"){ renderTrust(); return; }
  if(currentView==="integrations"){ renderIntegrations(); return; }
  if(currentView==="ai"){ renderAI(); return; }
}
function init(){
  // Boot from the ADDRESS: a cold load at any route lands there, and the gate in front of the
  // app means the originally requested URL survives sign-in.
  renderNav();
  document.getElementById("view").innerHTML="<div class=\"panel\"><div class=\"sub\">Loading data…</div></div>";
  loadData().then(function(){ routeCmd(); });
}
if(sessionStorage.getItem("ryc_cmd_auth")==="1"){ showApp(); }
else { setTimeout(function(){ document.getElementById("gate-input").focus(); },100); }
