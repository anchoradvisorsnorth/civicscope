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
    getJSON("/ryc-dashboard/procore-cache.json"),
    getJSON(CRM+"/api/ryc-foundation"),
    getJSON(CRM+"/api/ryc-ar"),
    getJSON(CRM+"/api/ryc-buildr"),
    getJSON("/ryc-dashboard/ryc-portfolio.json"),
    getJSON("/ryc-dashboard/ryc-subcontractors.json"),
    getJSON(CRM+"/api/ryc-buildr-forecast"),
    getJSON("/ryc-dashboard/bc-bidboard.json"),
    getJSON("/ryc-dashboard/pm-history.json")
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

function renderNav(){
  var el=document.getElementById("nav");
  el.innerHTML=NAV.map(function(n){ var on=n.key===currentView; return "<button type=\"button\" data-key=\""+n.key+"\" class=\""+(on?"active":"")+"\""+(on?" aria-current=\"page\"":"")+"><span class=\"ic\">"+n.ic+"</span>"+n.label+"</button>"; }).join("");
  Array.prototype.forEach.call(el.querySelectorAll("button"),function(a){ a.addEventListener("click",function(){ setView(a.getAttribute("data-key")); }); });
}
function setView(k){ closeDrawer(true); currentView=k; renderNav(); renderView();
  if(location.hash.replace(/^#\/?/,"")!==k) location.hash=k; // deep-linkable views; no-op when driven by hashchange
  var btn=document.querySelector("#nav button.active"); if(btn) btn.focus(); // restore focus after re-render (a11y)
}
function hashKey(){ return location.hash.replace(/^#\/?/,""); }
window.addEventListener("hashchange",function(){ var k=hashKey(); if(k!==currentView && NAV.some(function(n){ return n.key===k; })) setView(k); });
/* per-view provenance — the topbar must not claim Foundation on views that never read it */
var FDN_FED={command:1,portfolio:1,billing:1,woh:1,margin:1,brief:1,trust:1};
function viewCtx(){
  var loaded=loadedAt?loadedAt.toLocaleString():"…";
  if(currentView==="forecast") return "Buildr (BD's system of record) · pulled live · loaded "+loaded;
  if(currentView==="estimating") return "BuildingConnected (read-only, daily pull) · this pull "+((bcData&&ageTxt(bcData.generatedAt))||"…");
  if(currentView==="ai") return "Foundation via live ODBC · queries run at ask time (not the nightly snapshot)";
  if(currentView==="pmload") return "Foundation billing/cost history (full job record, 2021&rarr;) · pull "+((pmHistData&&ageTxt(pmHistData.generatedAt))||"&hellip;");
  if(currentView==="trust") return "All sources · loaded "+loaded;
  return "Procore (revised contract) + Foundation · loaded "+loaded;
}
function renderView(){
  var titles={command:"Command Center",portfolio:"Portfolio",billing:"Billing & Cash",woh:"Work on Hand",margin:"Margin & Risk",pmload:"PM Load",forecast:"Revenue Forecast",estimating:"Estimating — Bid Board",brief:"Executive Brief",trust:"Data Trust",ai:"AI Assistant"};
  document.getElementById("view-title").textContent=titles[currentView]||"Command Center";
  document.getElementById("view-ctx").innerHTML=viewCtx();
  document.getElementById("fdn-refresh-top").style.display=FDN_FED[currentView]?"":"none";
  var view=document.getElementById("view");
  // dark showcase for the Command Center; light operator theme for work views (FundView tiering)
  document.querySelector(".content").classList.toggle("light",currentView!=="command");
  // the brief carries its own editorial header (title + date + freshness) — drop the redundant topbar
  document.querySelector(".topbar").style.display=(currentView==="brief")?"none":"";
  if(currentView==="command"){ view.innerHTML=renderCommand(); return; }
  if(currentView==="portfolio"){ renderPortfolio(); return; }
  if(currentView==="billing"){ renderBilling(); return; }
  if(currentView==="woh"){ renderWOH(); return; }
  if(currentView==="margin"){ renderMargin(); return; }
  if(currentView==="pmload"){ renderPMLoad(); return; }
  if(currentView==="forecast"){ renderForecast(); return; }
  if(currentView==="estimating"){ renderEstimating(); return; }
  if(currentView==="brief"){ renderBrief(); return; }
  if(currentView==="trust"){ renderTrust(); return; }
  if(currentView==="ai"){ renderAI(); return; }
}
function init(){
  var k=hashKey(); if(NAV.some(function(n){ return n.key===k; })) currentView=k; // honor deep link on boot
  renderNav();
  document.getElementById("view").innerHTML="<div class=\"panel\"><div class=\"sub\">Loading data…</div></div>";
  loadData().then(function(){ renderView(); });
}
if(sessionStorage.getItem("ryc_cmd_auth")==="1"){ showApp(); }
else { setTimeout(function(){ document.getElementById("gate-input").focus(); },100); }
