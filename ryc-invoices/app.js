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

function init(){
  if(typeof RYCShell !== "undefined"){
    RYCShell.mount({
      workspace: "invoices",
      version: "v1.0.0",
      active: "invoices",
      groups: [{ label:"", items:[{ key:"invoices", label:"Daily batch", icon:"&#129534;" }] }],
      onSelect: function(){ renderInvoices(); },
      onLock: function(){ sessionStorage.removeItem("ryc_inv_auth"); location.reload(); }
    });
  }
  // Never store a URL-borne credential in the session: the address IS the credential, so a
  // shared machine does not silently inherit the last PM who used it.
  document.getElementById("view-ctx").innerHTML =
    "AP invoice register (written here) &middot; every decision is an audited fact "
    + "&middot; identity unverified until per-user sign-in";
  renderInvoices();
}

if(sessionStorage.getItem("ryc_inv_auth") === "1"){ showApp(); }
else if(invLinkEntry()){ showApp(); }      // the token IS the credential; deliberately not stored
else { setTimeout(function(){ document.getElementById("gate-input").focus(); }, 100); }
