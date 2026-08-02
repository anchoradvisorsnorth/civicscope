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
})(window);
