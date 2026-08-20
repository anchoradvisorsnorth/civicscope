"use strict";
/* ryc-invoices/app.js — gate, rail and routing for the Invoices workspace.
   Deliberately tiny. This tool has ONE destination, so it has no view registry, no data
   preload and no cross-view state — the things that make Command's app.js large are exactly
   the things a single-purpose operator tool should not carry. */

/* A PM arriving from their invoice email carries a signed token in ?k=. Letting it past the
   access-code screen is not a weakening: this gate has never been a security boundary
   (RYCAuth.gate() is a constant in a PUBLIC repo) and the real check is the HMAC verified
   server-side, which resolves to exactly one PM. A link session is strictly NARROWER than a
   code session — and now it lands in a tool rather than inside the whole operations cockpit,
   which is the other half of why this moved out of Command. */
function invLinkEntry(){
  var q = new URLSearchParams(location.search);
  return !!(q.get("k") || q.get("c"));
}

function showApp(){
  document.getElementById("gate").style.display = "none";
  document.getElementById("app").hidden = false;
  init();
}
function tryGate(){
  var v = document.getElementById("gate-input").value.trim();
  if(v === RYCAuth.gate()){ sessionStorage.setItem("ryc_inv_auth","1"); showApp(); }
  else { document.getElementById("gate-err").textContent = "Incorrect access code"; }
}
document.getElementById("gate-btn").addEventListener("click", tryGate);
document.getElementById("gate-input").addEventListener("keydown", function(e){
  if(e.key === "Enter") tryGate();
});

/* ===================== ONE ADDRESS PER VIEW =====================================
   Keith, 2026-08-19: *"we need unique domains for the different functions in the left sidebar so
   that people can bookmark to the page that is useful to them."*

   All three views lived at /ryc/invoices, so the front office could not bookmark the arrivals queue
   and a PM could not bookmark their desk — the rail state existed only in memory and a reload threw
   it away. The shell already routes this way for /desk/... and /command/...; this is the same
   pattern for the third workspace.

   THE QUERY STRING IS CARRIED THROUGH EVERY NAVIGATION, and that is not cosmetic: ?c= and ?k= ARE
   the credential. Dropping the search on a pushState would silently sign the user out on the first
   rail click, and an emailed ?k= link would stop working the moment its holder looked at anything
   else. */
var INV_VIEWS = { inbound:"inbound", invoices:"desks", batch:"batch" };
var INV_BY_PATH = { inbound:"inbound", desks:"invoices", batch:"batch",
                    "pm-desks":"invoices", invoices:"invoices" };

function invBasePath(){
  // Works under /ryc/invoices and the bare /invoices alias without hard-coding either.
  var m = location.pathname.match(/^(.*\/invoices)(?:\/|$)/);
  return m ? m[1] : "/ryc/invoices";
}
function invViewFromPath(){
  var base = invBasePath();
  var rest = location.pathname.slice(base.length).replace(/^\/+|\/+$/g, "").toLowerCase();
  return rest ? (INV_BY_PATH[rest] || null) : null;
}
function invPushView(key, replace){
  var slug = INV_VIEWS[key];
  if(!slug) return;
  var url = invBasePath() + "/" + slug + location.search + location.hash;
  if(location.pathname + location.search === invBasePath() + "/" + slug + location.search) return;
  try { history[replace ? "replaceState" : "pushState"]({ view:key }, "", url); } catch(e){ /* file:// */ }
}
function invRender(key){
  if(key === "inbound") renderInbound();
  else if(key === "batch") renderBatch();
  else renderInvoices();
}
function invGoTo(key, push){
  if(typeof RYCShell !== "undefined") RYCShell.setActive(key);
  if(push !== false) invPushView(key);
  invRender(key);
}

function init(){
  if(typeof RYCShell !== "undefined"){
    RYCShell.mount({
      workspace: "invoices",
      version: "v1.5.0",
      active: "batch",
      /* TWO destinations, because they are two different people's work (Keith, 2026-08-13).
         Inbound is the front office: everything that has arrived and not yet been sent to a desk.
         Daily batch is a PM's own queue. Grouping the unplaced invoices as a "No job yet" section
         inside the PM view put the front office's job inside somebody else's screen. */
      /* THREE now. Batch process is a THIRD kind of work, not a variant of Inbound: those are
         invoices arriving by email that must reach a PM's desk, this is a stack of paper the
         front office has ALREADY worked, which never enters the register and goes straight to
         the archive. Putting it inside Inbound would imply the register is involved. */
      /* BATCH PROCESS IS FIRST AND IT IS THE DEFAULT (Keith, 2026-08-20). It is the front office's
         first act of the day — the scanned stack goes in before anything reaches a desk — so it is
         the top rail item and where the tool opens. Inbound and PM Desks are what happens after. */
      groups: [{ label:"", items:[
        { key:"batch",    label:"Batch process", icon:"&#128196;" },
        { key:"inbound",  label:"Inbound",       icon:"&#128229;" },
        { key:"invoices", label:"PM Desks",      icon:"&#129534;" },
      ] }],
      /* setActive is not automatic — the rail keeps whatever `active` was mounted with, which is
         why clicking Inbound left "Daily batch" highlighted. */
      onSelect: function(key){ invGoTo(key); },
      onLock: function(){ sessionStorage.removeItem("ryc_inv_auth"); location.reload(); }
    });
  }
  // Never store a URL-borne credential in the session: the address IS the credential, so a
  // shared machine does not silently inherit the last PM who used it.
  document.getElementById("view-ctx").innerHTML =
    "AP invoice register (written here) &middot; every decision is an audited fact "
    + "&middot; identity unverified until per-user sign-in";

  /* WHERE THE URL LANDS YOU IS DECIDED BY WHO IS ASKING (Keith, 2026-08-13).
     /ryc/invoices opened on Inbound-second and PM-Desks-first, which is backwards for the person
     who lives in this tool: the front office's whole job is the arrivals queue, and a PM only ever
     wants their own desk. Asking the server rather than guessing from the URL means an admin code
     in ?c= still lands on Inbound, and an emailed ?k= link still lands on that PM's desk. */
  invPost("whoami", {}).then(function(r){
    var who = (r && r.ok && r.data) ? r.data : null;
    if(who){ _inv.who = who; _inv.pm = who.pm || null; }
    var pm = who && who.scope === "pm";
    /* AN EXPLICIT ADDRESS BEATS THE DEFAULT. A bookmark is a statement about where its owner wants
       to be, so it wins over the who-am-I heuristic; without a path we still ask the server rather
       than guessing, so an admin code lands on Inbound and an emailed ?k= link lands on that PM's
       desk exactly as before. `replaceState` normalises the bare /ryc/invoices to its real view so
       the Back button never has a rung that just redirects. */
    /* ⚠ A PM STILL LANDS ON THEIR OWN DESK. Keith's "default landing spot" is about entering the
       tool — the front office opening /invoices — and it must not reach through an emailed ?k=
       link, whose whole purpose is to put one PM in front of their own queue. Only the
       front-office default moved: inbound -> batch. */
    var want = invViewFromPath() || (pm ? "invoices" : "batch");
    if(typeof RYCShell !== "undefined") RYCShell.setActive(want);
    invPushView(want, true);
    invRender(want);
  });

  // Back/forward move between views instead of leaving the workspace.
  window.addEventListener("popstate", function(){
    var key = invViewFromPath() || "batch";
    if(typeof RYCShell !== "undefined") RYCShell.setActive(key);
    invRender(key);
  });
}

if(sessionStorage.getItem("ryc_inv_auth") === "1"){ showApp(); }
else if(invLinkEntry()){ showApp(); }      // the token IS the credential; deliberately not stored
else { setTimeout(function(){ document.getElementById("gate-input").focus(); }, 100); }
