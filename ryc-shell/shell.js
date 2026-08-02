/* ryc-shell/shell.js — THE shared R. Yoder shell (contract v1.1 §3, phase C).
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
 */
(function (global) {
  'use strict';

  var WORKSPACES = {
    desk:    { label: 'Estimating Desk', sub: 'Preconstruction', href: '/ryc/estimate' },
    command: { label: 'Command',         sub: 'Operations',      href: '/ryc/command' },
  };

  var state = { workspace: null, groups: [], active: null, onSelect: null, onLock: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function switcherHTML(current) {
    var order = ['desk', 'command'];
    return '<div class="ryc-switch"><div class="ryc-switch-lbl">Workspace</div><div class="ryc-switch-row">'
      + order.map(function (k) {
        var w = WORKSPACES[k];
        return k === current
          ? '<span class="on" title="You are here">' + esc(w.label) + '</span>'
          : '<a href="' + w.href + '" title="Switch to ' + esc(w.label) + ' — ' + esc(w.sub) + '">' + esc(w.label) + '</a>';
      }).join('') + '</div></div>';
  }

  function navHTML(groups, active) {
    return groups.map(function (g) {
      var items = g.items.map(function (it) {
        var hidden = it.hidden ? ' style="display:none"' : '';
        if (it.href) {
          return '<a class="ryc-ext" href="' + esc(it.href) + '" data-key="' + esc(it.key) + '"' + hidden + '>'
            + '<span class="ryc-ico">' + (it.icon || '') + '</span>' + esc(it.label) + '</a>';
        }
        return '<button data-key="' + esc(it.key) + '" class="' + (it.key === active ? 'on' : '') + '"' + hidden + '>'
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
    var w = WORKSPACES[opts.workspace] || WORKSPACES.desk;

    side.innerHTML =
      '<div class="ryc-brand">'
      + '<img src="/ryc-estimate/RYC_Shield_Orange.png" alt="R. Yoder">'
      + '<div><div class="ryc-brand-txt">R. Yoder</div><div class="ryc-brand-sub">' + esc(w.sub) + '</div></div>'
      + '</div>'
      + switcherHTML(opts.workspace)
      + '<div class="ryc-nav" id="ryc-nav">' + navHTML(state.groups, state.active) + '</div>'
      // Pre-identity: state what is true rather than inventing a person (contract §3).
      + '<div class="ryc-user"><strong>Shared access</strong>'
      + 'Signed in with the team password — individual sign-in arrives with Entra.'
      + (state.onLock ? '<button id="ryc-lock">Lock</button>' : '')
      + '<div class="ryc-ver">' + esc(opts.version || '') + '</div></div>';

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

  global.RYCShell = { mount: mount, setActive: setActive, setBadge: setBadge, setItemVisible: setItemVisible };
})(window);
