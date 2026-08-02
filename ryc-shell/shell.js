/* ryc-shell/shell.js — THE shared R. Yoder shell (contract v1.2 §3, phase C).
 *
 * ONE component, mounted by BOTH workspaces. The point is not code reuse — it is that the
 * navigation grammar, the workspace switcher and the (pre-)identity area cannot drift apart
 * once two teams' worth of screens hang off them. Command and the Desk keep their own moods
 * below this; they do not get their own shells.
 *
 * Usage:
 *   RYCShell.mount({
 *     workspace: 'desk' | 'command',
 *     groups:    [{ label, items: [{ key, label, icon, href? }] }],
 *     active:    'pursuits',
 *     onSelect:  (key) => {...},
 *     version:   'v1.20.0',
 *     onLock:    () => {...},          // optional: gate lock/sign-out
 *   });
 *   RYCShell.setActive(key) · RYCShell.setBadge(key, n) · RYCShell.setItemVisible(key, bool)
 *
 * Also exports RYCAuth — the SINGLE interim-credential seam (see the bottom of this file).
 */
(function (global) {
  'use strict';

  /* Workspaces are DESTINATIONS, not toggle states, so the switcher is a menu rather than a
     segmented control (Keith, 2026-08-01). `label` is what the workspace is called in the
     contract's fixed vocabulary (§1); `mode` is the half of the business it owns and is what
     the brand block displays, because that is the distinction someone is actually making when
     they switch. `href` is the CANONICAL path — the switcher must not enter a legacy address
     that then has to rewrite itself (Codex phase-C finding #8). */
  var WORKSPACES = {
    desk:    { label: 'Estimating Desk', mode: 'Preconstruction', href: '/desk/pursuits' },
    command: { label: 'Command',         mode: 'Operations',      href: '/command/command' },
  };
  var ORDER = ['desk', 'command'];

  var state = { workspace: null, groups: [], active: null, onSelect: null, onLock: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Brand block + workspace menu — ONE control, both directions, no duplicate entries
     anywhere else in the shell (contract §3). The current workspace is named in the trigger
     so you can always see which side of the award line you are on without opening anything. */
  function brandHTML(current) {
    var w = WORKSPACES[current] || WORKSPACES.desk;
    var items = ORDER.map(function (k) {
      var x = WORKSPACES[k], on = k === current;
      return '<a role="menuitem" class="ryc-ws-item' + (on ? ' on' : '') + '"'
        + ' href="' + esc(x.href) + '"' + (on ? ' aria-current="page"' : '') + ' tabindex="-1">'
        + '<span class="ryc-ws-mode">' + esc(x.mode) + (on ? '<span class="ryc-ws-here">Current</span>' : '') + '</span>'
        + '<span class="ryc-ws-label">' + esc(x.label) + '</span>'
        + '<span class="ryc-ws-path">' + esc(x.href) + '</span></a>';
    }).join('');

    return '<div class="ryc-brand">'
      + '<img src="/ryc-estimate/RYC_Shield_Orange.png" alt="">'
      + '<button type="button" class="ryc-ws-btn" id="ryc-ws-btn" aria-haspopup="menu"'
      +   ' aria-expanded="false" aria-controls="ryc-ws-menu">'
      +   '<span class="ryc-brand-txt">R. Yoder</span>'
      +   '<span class="ryc-brand-sub">' + esc(w.mode)
      +     '<svg class="ryc-ws-caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">'
      +     '<path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"'
      +     ' stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
      + '</button>'
      + '<div class="ryc-ws-menu" id="ryc-ws-menu" role="menu" aria-label="Switch workspace" hidden>'
      +   '<div class="ryc-ws-menu-h">Workspace</div>' + items
      + '</div></div>';
  }

  /* Keyboard operation and focus behaviour are shell REQUIREMENTS, not enhancements
     (contract §8), so the menu is driven properly rather than by a click handler alone. */
  function wireWorkspaceMenu(root) {
    var btn = root.querySelector('#ryc-ws-btn');
    var menu = root.querySelector('#ryc-ws-menu');
    if (!btn || !menu) return;
    var items = Array.prototype.slice.call(menu.querySelectorAll('.ryc-ws-item'));

    function open(focusIdx) {
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      if (focusIdx != null && items[focusIdx]) items[focusIdx].focus();
      document.addEventListener('click', onDocClick, true);
    }
    function close(refocus) {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClick, true);
      if (refocus) btn.focus();
    }
    function onDocClick(e) { if (!menu.contains(e.target) && !btn.contains(e.target)) close(false); }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (menu.hidden) open(null); else close(false);
    });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(0); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); open(items.length - 1); }
    });
    menu.addEventListener('keydown', function (e) {
      var i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
      else if (e.key === 'Tab') close(false);
    });
  }

  function navHTML(groups, active) {
    return groups.map(function (g) {
      var items = g.items.map(function (it) {
        var hidden = it.hidden ? ' style="display:none"' : '';
        if (it.href) {
          return '<a class="ryc-ext" href="' + esc(it.href) + '" data-key="' + esc(it.key) + '"' + hidden + '>'
            + '<span class="ryc-ico">' + (it.icon || '') + '</span>' + esc(it.label) + '</a>';
        }
        return '<button type="button" data-key="' + esc(it.key) + '" class="' + (it.key === active ? 'on' : '') + '"' + hidden + '>'
          + '<span class="ryc-ico">' + (it.icon || '') + '</span>' + esc(it.label)
          + '<span class="ryc-badge" data-badge="' + esc(it.key) + '" style="display:none"></span></button>';
      }).join('');
      return (g.label ? '<div class="ryc-nav-h">' + esc(g.label) + '</div>' : '') + items;
    }).join('');
  }

  function mount(opts) {
    state.workspace = opts.workspace;
    state.groups = opts.groups || [];
    state.active = opts.active || null;
    state.onSelect = opts.onSelect || function () {};
    state.onLock = opts.onLock || null;

    var side = document.getElementById('ryc-side');
    if (!side) return;

    side.innerHTML =
      brandHTML(opts.workspace)
      + '<div class="ryc-nav" id="ryc-nav">' + navHTML(state.groups, state.active) + '</div>'
      // Pre-identity: state what is true rather than inventing a person (contract §3).
      // VENDOR-NEUTRAL BY INSTRUCTION (Keith, 2026-08-01): identity is deferred and the
      // provider is undecided, so this copy must not name or imply one.
      + '<div class="ryc-user"><strong>Shared access</strong>'
      + 'Signed in with the team password. Individual sign-in is not enabled yet.'
      + (state.onLock ? '<button type="button" id="ryc-lock">Lock</button>' : '')
      + '<div class="ryc-ver">' + esc(opts.version || '') + '</div></div>';

    wireWorkspaceMenu(side);
    side.querySelector('#ryc-nav').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-key]');
      if (!b) return;
      state.onSelect(b.getAttribute('data-key'));
    });
    var lock = side.querySelector('#ryc-lock');
    if (lock) lock.addEventListener('click', function () { state.onLock(); });
  }

  function setActive(key) {
    state.active = key;
    var nav = document.getElementById('ryc-nav');
    if (!nav) return;
    Array.prototype.forEach.call(nav.querySelectorAll('button[data-key]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-key') === key);
    });
  }

  function setBadge(key, n) {
    var el = document.querySelector('[data-badge="' + key + '"]');
    if (!el) return;
    if (n > 0) { el.textContent = n; el.style.display = ''; } else { el.style.display = 'none'; }
  }

  function setItemVisible(key, visible) {
    var nav = document.getElementById('ryc-nav');
    if (!nav) return;
    var el = nav.querySelector('[data-key="' + key + '"]');
    if (el) el.style.display = visible ? '' : 'none';
  }

  global.RYCShell = {
    mount: mount, setActive: setActive, setBadge: setBadge, setItemVisible: setItemVisible,
    workspaces: WORKSPACES,
  };

  /* ===================================================================================
     RYCAuth — THE interim-credential seam (contract §2/D8, Codex phase-C finding #10).
     Identity is deferred and no provider is committed, but D8 forbids proliferating direct
     password-bearing call sites in the meantime. Every gated request in BOTH workspaces goes
     through this one function, so the phase-D migration replaces THIS — not every fetch in
     two bundles. It deliberately lives in the shared shell bundle rather than in either
     workspace, for the same reason the rail does.

     Return contract (why it is not just `fetch`): callers must be able to tell "the server
     said no such thing" from "we could not ask" — conflating them is finding #5.
       { ok:true,  status, data }                        — authoritative answer
       { ok:false, status, unavailable:true, error }     — transport/gate/parse failure
     ================================================================================== */
  var GATE = 'ryc2026';                 // replaced by a bearer token at phase D; one place.

  function post(action, body, opts) {
    opts = opts || {};
    var url = opts.url || '/api/ryc-estimate-log';
    var payload = Object.assign({}, body || {}, { pw: GATE, action: action });
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: opts.signal,
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = JSON.parse(t); } catch (e) {}
        if (!r.ok || d === null) {
          return { ok: false, status: r.status, unavailable: true,
                   error: (d && d.error) || ('HTTP ' + r.status) };
        }
        return { ok: true, status: r.status, data: d };
      });
    }).catch(function (e) {
      // An aborted request is a deliberate supersede, not an outage — say so, so a nav-token
      // cancellation is never rendered to the user as "data unavailable".
      if (e && e.name === 'AbortError') return { ok: false, aborted: true, error: 'aborted' };
      return { ok: false, status: 0, unavailable: true, error: e && e.message ? e.message : 'network error' };
    });
  }

  global.RYCAuth = { post: post, gate: function () { return GATE; } };

  /* ===================================================================================
     RYCFormat — THE money / date / percent rules (contract §3, usability program 0.3).

     Contract §3 says: "Money: compact in scanning tables, full in financial detail,
     decisions, reconciliation, printed artifacts. One formatter per app, same rule."
     Phase C shipped ONE shell but left TWO of everything below it — Command carried
     fmt/fmtCompact/pct/fmtDate/ageTxt in core.js while the Desk carried its own money()/
     pct()/fmtCompact()/fmtDate(), and the two compact rules had already drifted apart
     ($2.0M vs $2M, $1.1M vs $1.05M). A shared shell that renders the same dollar two ways
     is not one product. This lives beside RYCAuth for the same reason the rail does.

     THREE money forms, because they answer three different questions — naming them
     separately is what stops a caller from picking the wrong one by accident:

       compact(n)     $2.6M · $250K · $412        scanning tables, dense lists
       exact(n)       $2,600,000                  decisions, edit fields, detail, artifacts
       accounting(n)  $2,600,000 · $(15,000)      audit tables that must foot, negatives in
                                                  parentheses (Work on Hand, CSV export)

     CANONICAL COMPACT = one decimal for millions. Deliberately Command's rule, not the
     Desk's variable-precision variant: fixed decimals keep a tabular-nums column aligned,
     which is the entire point of compact money, and it is the form the approved brief
     itself writes ($2.6M). Consequence recorded in the program plan: the Desk's compact
     values below $10M lose a decimal, so the 1.3 sweep must check Cost Intelligence for
     benchmark figures that should be calling exact() rather than compact().
     ================================================================================== */
  var DASH = '—';                      // em dash — the one "no value" glyph

  function num(n) { return (n === null || n === undefined || n !== n) ? null : Number(n); }

  function compact(n) {
    var v = num(n); if (v === null) return DASH;
    var a = Math.abs(v), s = v < 0 ? '-' : '';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return s + '$' + Math.round(a / 1e3).toLocaleString('en-US') + 'K';
    return s + '$' + Math.round(a).toLocaleString('en-US');
  }
  /* The sign goes OUTSIDE the currency symbol, matching compact(). Both workspaces'
     previous exact formatters did '$' + n.toLocaleString(), which renders a negative as
     "$-15,000" — inconsistent with the "-$15K" the same page shows in a compact column.
     No current caller passes a negative (these are contract and bid values), so this
     corrects a latent inconsistency rather than changing anything on screen today. */
  function exact(n) {
    var v = num(n); if (v === null) return DASH;
    return (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US');
  }
  /* Negatives in parentheses, no currency sign inversion — the convention accounting reads,
     and the one Work on Hand and its CSV already use. Kept byte-identical to the previous
     briefDol(): scripts/guard-woh-parity.js fails the build if this moves. */
  function accounting(n) {
    var v = num(n); if (v === null) return DASH;
    return v < 0
      ? '$(' + Math.abs(Math.round(v)).toLocaleString('en-US') + ')'
      : '$' + Math.round(v).toLocaleString('en-US');
  }
  function pct(n) {
    var v = num(n); if (v === null) return DASH;
    return v.toFixed(1) + '%';
  }
  /* Dates: ABSOLUTE on facts and audit ("Aug 2, 2026"), RELATIVE on freshness ("6h ago")
     — contract §3. An unparseable date returns the dash rather than the string
     "Invalid Date", which is what the Desk's own fmtDate used to render. */
  /* A DATE-ONLY string is parsed at LOCAL NOON, not UTC midnight.
     `new Date("2026-08-02")` is specified to parse as UTC, so in Eastern time it is
     2026-08-01 20:00 and toLocaleDateString renders "Aug 1, 2026" — every date-only value
     displayed one day early. Both workspaces' fmtDate had this; Foundation AR invoice and
     due dates, Procore start/finish dates and Buildr schedule dates all arrive date-only,
     so it was live. (Work on Hand already worked around it locally with a "T12:00:00"
     suffix — that fix is now the shared rule.) Noon avoids the DST edges in both
     directions. Timestamps that carry a time are left exactly as given. */
  function toDate(s) {
    if (s instanceof Date) return s;
    if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T12:00:00');
    return new Date(s);
  }
  function date(s) {
    if (!s) return DASH;
    var d = toDate(s);
    return isNaN(d.getTime()) ? DASH : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  /* Returns null (not a dash) when there is nothing to age: callers compose it into a
     sentence and supply their own fallback. */
  function age(ts) {
    if (!ts) return null;
    var h = (Date.now() - new Date(ts)) / 3600000;
    if (!(h >= 0)) return null;
    if (h < 1.5) return Math.max(1, Math.round(h * 60)) + 'm ago';
    if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  global.RYCFormat = {
    compact: compact, exact: exact, accounting: accounting,
    pct: pct, date: date, age: age, DASH: DASH,
  };

  /* ===================================================================================
     RYCTable — ONE way a table row opens something (usability program 1.1).

     Contract §8 makes keyboard operation and visible focus shell requirements. The Desk
     was not meeting them: `<tr class="hrow" style="cursor:pointer" onclick="openRun(...)">`
     with no CSS behind `.hrow` at all — not reachable by Tab, not activatable by Enter, and
     invisible to anyone navigating without a mouse. Command had three near-identical copies
     of the correct wiring (hookDrawerRows / hookSubRows / hookCplRows).

     wire(root, attr, onOpen) delegates ONE click and ONE keydown listener on `root` for
     every `tr[attr]` beneath it, and stamps the rows with the semantics a button needs.

     It deliberately does NOT add the visual affordance class. That is the row builder's
     decision, expressed in markup as `class="ryc-row"` — which is precisely what lets Work
     on Hand stay wired and clickable while none of the 1.1 styling reaches it.
     ================================================================================== */
  function labelFor(tr) {
    var explicit = tr.getAttribute('data-open-label');
    if (explicit) return explicit;
    var first = tr.querySelector('td');
    var t = (first && (first.innerText || first.textContent) || '').trim().split('\n')[0];
    return t ? ('Open ' + t.slice(0, 80)) : 'Open row';
  }

  var wiredBy = {};                       // attr -> WeakSet<Element> of already-wired roots

  function wire(root, attr, onOpen) {
    if (!root || typeof onOpen !== 'function') return;
    var sel = 'tr[' + attr + ']';

    /* Idempotent: re-rendering a view re-runs this, and a second listener on the same
       container would open the drawer twice per click.
       The bookkeeping lives in a WeakSet, NOT a data-* attribute on the element. The first
       version set `root.dataset[...]`, which is a real attribute inside the rendered DOM —
       the Work on Hand parity guard failed on it. Test-visible state must not be written
       into the page. A WeakSet also lets the entry be collected with the element. */
    var seen = wiredBy[attr] || (wiredBy[attr] = new WeakSet());
    if (!seen.has(root)) {
      seen.add(root);
      root.addEventListener('click', function (e) {
        var tr = e.target.closest(sel);
        if (tr && root.contains(tr)) onOpen(tr.getAttribute(attr), tr);
      });
      root.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var tr = e.target.closest(sel);
        if (!tr || !root.contains(tr)) return;
        e.preventDefault();                 // Space must not scroll the page
        onOpen(tr.getAttribute(attr), tr);
      });
    }

    /* Only rows that OPTED IN are decorated. `ryc-row` is the row builder saying "this row
       is an openable row in the 1.1 sense"; a row that is merely wired keeps exactly the
       attributes its builder emitted.

       This is not a nicety — it is what keeps Work on Hand frozen. WOH's rows are wired and
       already carry tabindex and role, but no aria-label, and stamping one on them changed
       what a screen reader announces on a protected surface. The parity guard caught it and
       failed the build, which is the system working: the fix is to scope the change, not to
       re-bless the baseline. WOH's rows still read their full cell text as their accessible
       name, which is the behaviour they have always had. */
    Array.prototype.forEach.call(root.querySelectorAll(sel), function (tr) {
      if (!tr.classList.contains('ryc-row')) return;
      if (!tr.hasAttribute('tabindex')) tr.setAttribute('tabindex', '0');
      if (!tr.hasAttribute('role')) tr.setAttribute('role', 'button');
      if (!tr.hasAttribute('aria-label')) tr.setAttribute('aria-label', labelFor(tr));
    });
  }

  global.RYCTable = { wire: wire };
})(window);
