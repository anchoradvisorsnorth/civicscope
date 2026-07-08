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
    getJSON(CRM+"/api/ryc-buildr-forecast")
  ]).then(function(r){
    activeData=r[0]; foundationData=r[1]; arData=r[2]; buildrData=r[3]; portfolioData=r[4]; subsData=r[5]; forecastData=r[6]; loadedAt=new Date();
    mergeFoundation();
  });
}

function renderNav(){
  var el=document.getElementById("nav");
  el.innerHTML=NAV.map(function(n){ var on=n.key===currentView; return "<button type=\"button\" data-key=\""+n.key+"\" class=\""+(on?"active":"")+"\""+(on?" aria-current=\"page\"":"")+"><span class=\"ic\">"+n.ic+"</span>"+n.label+"</button>"; }).join("");
  Array.prototype.forEach.call(el.querySelectorAll("button"),function(a){ a.addEventListener("click",function(){ setView(a.getAttribute("data-key")); }); });
}
function setView(k){ closeDrawer(true); currentView=k; renderNav(); renderView();
  var btn=document.querySelector("#nav button.active"); if(btn) btn.focus(); // restore focus after re-render (a11y)
}
function renderView(){
  var titles={command:"Command Center",portfolio:"Portfolio",billing:"Billing & Cash",margin:"Margin & Risk",forecast:"Revenue Forecast",brief:"Executive Brief",trust:"Data Trust",ai:"AI Assistant"};
  document.getElementById("view-title").textContent=titles[currentView]||"Command Center";
  document.getElementById("view-ctx").innerHTML="Procore (revised contract) + Foundation · loaded "+(loadedAt?loadedAt.toLocaleString():"…");
  var view=document.getElementById("view");
  // dark showcase for the Command Center; light operator theme for work views (FundView tiering)
  document.querySelector(".content").classList.toggle("light",currentView!=="command");
  // the brief carries its own editorial header (title + date + freshness) — drop the redundant topbar
  document.querySelector(".topbar").style.display=(currentView==="brief")?"none":"";
  if(currentView==="command"){ view.innerHTML=renderCommand(); return; }
  if(currentView==="portfolio"){ renderPortfolio(); return; }
  if(currentView==="billing"){ renderBilling(); return; }
  if(currentView==="margin"){ renderMargin(); return; }
  if(currentView==="forecast"){ renderForecast(); return; }
  if(currentView==="brief"){ renderBrief(); return; }
  if(currentView==="trust"){ renderTrust(); return; }
  if(currentView==="ai"){ renderAI(); return; }
}
function init(){
  renderNav();
  document.getElementById("view").innerHTML="<div class=\"panel\"><div class=\"sub\">Loading data…</div></div>";
  loadData().then(function(){ renderView(); });
}
if(sessionStorage.getItem("ryc_cmd_auth")==="1"){ showApp(); }
else { setTimeout(function(){ document.getElementById("gate-input").focus(); },100); }
