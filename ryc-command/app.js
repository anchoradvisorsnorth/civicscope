"use strict";
/* ryc-command/app.js — gate, nav, data boot
   Split from index.html (Phase 7). Classic scripts, load order: core → views → app. */
/* ---- gate / nav / boot ---- */
function showApp(){ document.getElementById("gate").style.display="none"; document.getElementById("app").hidden=false; init(); }
// The gate constant lives in RYCAuth (contract D8: ONE interim-credential seam), so phase D
// replaces that module rather than hunting literals across two bundles.
function tryGate(){ var v=document.getElementById("gate-input").value.trim(); if(v===RYCAuth.gate()){ sessionStorage.setItem("ryc_cmd_auth","1"); showApp(); } else { document.getElementById("gate-err").textContent="Incorrect access code"; } }
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
    version:"v2.37.0",
    active:currentView,
    groups:groups,
    onSelect:function(k){ setView(k); },
    onLock:function(){ sessionStorage.removeItem("ryc_cmd_auth"); location.reload(); }
  });
}
/* ===== PHASE C ROUTING — paths, not hashes (contract v1.2 §3) =========================
   Canonical: /command/<view> · /command/jobs/<job_uuid>
   A JOB IS ADDRESSED BY ITS IMMUTABLE UUID, never by its Foundation job number (contract D5):
   job numbers get corrected, reformatted and reused, so a URL built on one silently changes
   meaning. The number remains the display and search key and resolves through ryc_job_aliases.

   Remediated against Codex REVIEW_phase-c-shell-routing_2026-08-01:
     #2  every navigation carries a TOKEN; a slow job lookup that lands after the user has
         moved on is discarded instead of painting a stale drawer under a newer URL.
     #5  "we could not ask" is no longer collapsed into "there is no such job".
     #6  route resolution returns TYPED states (active/closed/renumbered/not-found) from the
         server; not-found discloses nothing, and closed is its own state.
     #9  route shapes are matched EXACTLY — surplus segments are not valid destinations.
     #10 the gated request goes through RYCAuth, the one interim-credential seam. */
var CMD_BASE="/command";
var CMD_HOME="command";                 // the canonical default view
var CMD_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var _cmdRouting=false, _jobIdCache=null, _cmdNavToken=0, _jobFetch=null;
function cmdUrl(k){ return CMD_BASE+"/"+k; }
function isCmdView(k){ return NAV.some(function(n){ return n.key===k && !n.href; }); }
/* ONE parser (finding #9). Returns a typed route or null when the address is not a valid
   Command destination — including when it merely has extra segments glued on the end. */
function parseCmdPath(pathname){
  var parts=String(pathname||"").replace(/\/+$/,"").split("/").filter(Boolean);
  if(parts[0]!=="command") return null;
  if(parts.length===1) return {kind:"view",view:CMD_HOME,canonical:cmdUrl(CMD_HOME)};
  if(parts[1]==="jobs"){
    if(parts.length!==3||!parts[2]) return null;          // /command/jobs, /command/jobs/x/y
    // A job route is UUID-ONLY (contract §3 routes / D5). Accepting any third segment meant
    // /command/jobs/2513C004 resolved and opened a job at a NON-CANONICAL, number-based
    // address — the exact thing routing by immutable id exists to prevent (r2 review #3).
    if(!CMD_UUID.test(parts[2])) return null;
    return {kind:"job",id:parts[2],canonical:CMD_BASE+"/jobs/"+parts[2]};
  }
  if(parts.length!==2) return null;                       // /command/billing/garbage
  if(!isCmdView(parts[1])) return null;
  return {kind:"view",view:parts[1],canonical:cmdUrl(parts[1])};
}
function setView(k){
  if(!_cmdRouting){ _cmdState=null; _jobPage=null; _cmdNavToken++; }   // a deliberate move clears the bad-address AND job-page states
  closeDrawer(true); currentView=k;
  if(typeof RYCShell!=="undefined") RYCShell.setActive(k);
  renderView();
  if(!_cmdRouting && location.pathname!==cmdUrl(k)) history.pushState({v:k},"",cmdUrl(k));
}
/* job_no -> uuid map, used to BUILD links. It must never be the thing that decides
   not-found: a failed load is `ok:false`, is NOT cached, and never becomes an empty map
   that reads as "no jobs exist" (finding #5). */
function loadJobIds(){
  if(_jobIdCache) return Promise.resolve({ok:true,map:_jobIdCache});
  return RYCAuth.post("job_ids").then(function(r){
    if(!r.ok) return {ok:false,error:r.error};
    var m={byId:{},byNo:{}};
    ((r.data&&r.data.jobs)||[]).forEach(function(j){ m.byId[j.id]=j.job_no; m.byNo[j.job_no]=j.id; });
    _jobIdCache=m;
    return {ok:true,map:m};
  });
}
/* Deep link to a job. The server gives the typed verdict; this function only decides how to
   render it — and only if the user is still on this address (finding #2). */
function openJobById(uuid,tok){
  if(_jobFetch){ try{ _jobFetch.abort(); }catch(e){} }   // supersede any in-flight lookup
  var ctl=(typeof AbortController!=="undefined")?new AbortController():null;
  _jobFetch=ctl;
  var want=CMD_BASE+"/jobs/"+uuid;
  var stale=function(){ return tok!==_cmdNavToken || location.pathname!==want; };
  return RYCAuth.post("resolve_job",{ref:uuid},{signal:ctl&&ctl.signal}).then(function(r){
    if(ctl===_jobFetch) _jobFetch=null;
    if(r.aborted||stale()) return;                       // the user moved on — drop this route
    if(!r.ok){
      // An outage, a gate rejection or a malformed reply is NOT an authoritative absence.
      return renderCmdState({title:"Job directory unavailable",
        msg:"This address could not be checked right now — the job directory did not answer. The link may be perfectly good.",
        retry:true});
    }
    var d=r.data||{};
    if(d.state==="not_found") return renderCmdState({title:"Page not found",msg:"No job matches that address."});
    if(d.state==="closed") return renderCmdState({title:"Job closed",
      msg:"That job is closed. Closed work is reported under Completed rather than on the active board.",
      go:{label:"Go to Completed",view:"completed"}});
    /* AMBIGUOUS is an identity conflict, not an absence. Falling through to the no-job_no
       branch reported "not on this board", which is a false reading of a real data problem
       (r2 review #3). Fail closed and say what is actually wrong. */
    if(d.state==="ambiguous") return renderCmdState({title:"Ambiguous job reference",
      msg:"That reference matches more than one job identity ("+((d.candidates&&d.candidates.length)||0)
         +"), so Command will not guess which one you meant. Open the job by its unique address, or resolve the duplication in the job identity record."});
    /* NOTE: there is deliberately no `renumbered` branch. Job routes are UUID-only, and the
       resolver only returns `renumbered` for a NUMBER reference — so that branch was
       unreachable from routing and only complicated the typed-state contract (r3 review,
       answer 4). If number/alias lookup is ever wanted it belongs in a separate search action,
       which can canonicalise to the UUID itself. Until then, an unrecognised state fails
       closed rather than being interpreted optimistically. */
    if(d.state!=="active") return renderCmdState({title:"Job unavailable",
      msg:"That job could not be opened ("+esc(String(d.state||"unknown state"))+")."});
    var no=d.job_no;
    // The identity table covers every Foundation job; Command's board is fed by Procore. A
    // real, open job the board does not carry is a coverage gap, not a bad address — say so
    // WITHOUT echoing the record's metadata back (contract §3: no existence oracle).
    if(!no||(typeof jobByNo==="function" && !jobByNo(no))){
      return renderCmdState({title:"Not on this board",
        msg:"That job exists but Command's active board does not carry it — it may sit outside the current portfolio.",
        go:{label:"Go to Portfolio",view:"portfolio"}});
    }
    if(stale()) return;
    // 3.2: a job address now renders the JOB PAGE, not a drawer floating over Portfolio.
    // The route was already canonical and typed; it was just landing on a preview.
    paintJobPage(no);
  });
}
/* ===== 3.2 job page state ==============================================================
   Like _cmdState, this is a STATE rather than a one-shot paint: Command reloads its feeds on
   a timer and re-renders, and without this the async re-render would quietly replace the job
   page with Portfolio while the address still said /command/jobs/<uuid>. */
var _jobPage=null;
function paintJobPage(jno){
  if(jno!=null) _jobPage=jno;
  if(!_jobPage) return;
  var j=(typeof jobByNo==="function")?jobByNo(_jobPage):null;
  if(!j){ _jobPage=null; return renderCmdState({title:"Not on this board",
    msg:"That job exists but Command's active board does not carry it — it may sit outside the current portfolio.",
    go:{label:"Go to Portfolio",view:"portfolio"}}); }
  /* Set the rail directly rather than through setView(): setView calls renderView(), which
     honours _jobPage and calls straight back here — an infinite recursion that rendered
     nothing at all. The job page is its own destination, so it paints itself. */
  closeDrawer(true);
  currentView="portfolio";                  // the rail highlights where the job lives
  if(typeof RYCShell!=="undefined") RYCShell.setActive("portfolio");
  document.getElementById("view-title").textContent=j.name||"Job";
  document.getElementById("view-ctx").innerHTML=viewCtx();
  document.querySelector(".content").classList.toggle("light",true);
  document.getElementById("view").innerHTML=jobPageHtml(j);
  hookDrawerRows();
  if(typeof loadBidRecord==="function") loadBidRecord(_jobPage);
}
/* Opening the page from the drawer: the drawer closes, the address changes to the job's own,
   and the page renders — so Back returns to the list rather than to a re-opened drawer. */
function goJobPage(jno){
  var open=function(u){
    window._dwRouting=true;
    try{ closeDrawer(true); } finally { window._dwRouting=false; }
    /* REPLACE, don't push, when the drawer already put us at this address. Opening the drawer
       pushes the job's URL; pushing it a second time to go from preview to page stacked two
       identical entries, so Back appeared to do nothing — it was stepping between two copies
       of the same address. Preview and page are two depths of ONE rendered state, so they
       share one history entry. */
    if(u && location.pathname!==u) history.pushState({job:jno},"",u);
    else if(u) history.replaceState({job:jno},"",u);
    paintJobPage(jno);
  };
  var u=(typeof jobUrl==="function")?jobUrl(jno):null;
  if(u) return open(u);
  // The cache may not have landed yet (or the request failed). Fetch it, then open — rather
  // than silently doing nothing, which is what a null URL used to cause.
  loadJobIds().then(function(){ open((typeof jobUrl==="function")?jobUrl(jno):null); })
              .catch(function(){ open(null); });
}
function jobUrl(jno){ var m=_jobIdCache; var id=m&&m.byNo[jno]; return id?CMD_BASE+"/jobs/"+id:null; }
function setViewSilent(k){ _cmdRouting=true; try{ setView(k); } finally { _cmdRouting=false; } }
/* A failed route resolution is a STATE, not a one-shot paint: it borrows the Overview
   container, whose async delta load would otherwise land afterwards and replace it with a
   working screen at a bad address. renderView() honours the flag; a deliberate navigation
   clears it. The states are distinct per contract §3 — not-found, closed and unavailable
   are three different things and each says which it is. */
var _cmdState=null;
function paintCmdState(){
  var v=document.getElementById("view");
  if(!v||!_cmdState) return;
  var s=_cmdState, act="";
  if(s.retry) act+="<button class=\"pfill\" onclick=\"retryCmdRoute()\">Try again</button> ";
  if(s.go) act+="<button class=\"pfill\" onclick=\"goCommandView('"+esc(s.go.view)+"')\">"+esc(s.go.label)+"</button> ";
  act+="<button class=\"pfill\" onclick=\"goCommand()\">Go to Overview</button>";
  v.innerHTML="<div class=\"panel\"><div class=\"h\">"+esc(s.title)+"</div><div class=\"sub\">"+esc(s.msg)
    +"</div><div style=\"margin-top:10px\">"+act+"</div></div>";
}
function renderCmdState(s){ _cmdState=s; setViewSilent(CMD_HOME); paintCmdState(); }
function goCommand(){ _cmdState=null; history.pushState({},"",cmdUrl(CMD_HOME)); routeCmd(); }
function goCommandView(k){ _cmdState=null; history.pushState({},"",cmdUrl(k)); routeCmd(); }
function retryCmdRoute(){ _cmdState=null; _jobIdCache=null; routeCmd(); }
var LEGACY_CMD_HASH={dashboard:"command"};
function routeCmd(){
  _cmdState=null; _jobPage=null;                // a new address gets a fresh verdict
  var tok=++_cmdNavToken;                       // ...and owns any async work it starts
  var h=(location.hash||"").replace(/^#\/?/,"");
  if(h){ // legacy hash bookmark → canonical path, replaced (a fragment never reaches the server)
    var k=LEGACY_CMD_HASH[h]||h;
    var jm=h.match(/^job\/(.+)$/);
    history.replaceState({},"",jm?CMD_BASE+"/jobs/"+jm[1]:cmdUrl(isCmdView(k)?k:CMD_HOME));
  }
  var route=parseCmdPath(location.pathname);
  if(!route){
    var parts=location.pathname.replace(/\/+$/,"").split("/").filter(Boolean);
    if(parts[0]!=="command"){ history.replaceState({},"",cmdUrl(CMD_HOME)); return routeCmd(); }
    return renderCmdState({title:"Page not found",msg:"That is not an address in Command."});
  }
  // one rendered state, one URL: /command and /command/ resolve to /command/command
  if(location.pathname!==route.canonical) history.replaceState({},"",route.canonical);
  if(route.kind==="job") return openJobById(route.id,tok);
  setViewSilent(route.view);
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
  if(_cmdState) return paintCmdState();         // bad address — don't paint a working screen over it
  if(_jobPage) return paintJobPage();           // a job address is a destination, not a transient paint
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
  // loadJobIds() had NO CALLER — so _jobIdCache was always null, jobUrl() always returned
  // null, and clicking a job never put its UUID in the address. The canonical job route
  // resolved perfectly but was reachable only by typing or bookmarking it. Loaded here,
  // alongside the feeds, and deliberately NOT awaited: routing must not wait on it.
  loadData().then(function(){ loadJobIds(); routeCmd(); });
}
if(sessionStorage.getItem("ryc_cmd_auth")==="1"){ showApp(); }
else { setTimeout(function(){ document.getElementById("gate-input").focus(); },100); }
