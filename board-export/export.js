/* board-export/export.js — v1.0.0-boardexport (2026-09-18)
 *
 * Runs INSIDE a signed-in BoardDocs tab, loaded by the bookmarklet on /board-export. It walks
 * every meeting the site lists — agenda, detailed agenda, minutes, every agenda item, every
 * attachment, the library — using the tab's own session (the same requests the page itself
 * makes), and uploads each document to /api/board-export on the host this script came from.
 *
 * It never reads a cookie, a password or a form. `fetch` with credentials:'same-origin' sends
 * the session automatically, exactly as clicking in the page would. Nothing about who is signed
 * in is sent anywhere; the upload carries only the documents and a per-district export token.
 *
 * Resumable: a manifest.json is uploaded after every meeting, so closing the tab and clicking
 * the bookmark again picks up where it stopped. Runs with a small delay between requests — this
 * is one person's browser doing a few hours of clicking in a few minutes, not a crawler.
 */
(function () {
  'use strict';
  var VER = '1.0.0-boardexport';
  var src = (document.currentScript && document.currentScript.src) || '';
  var u; try { u = new URL(src); } catch (e) { alert('Board export: could not read its own settings.'); return; }
  var ORG = (u.searchParams.get('org') || '').toLowerCase();
  var TOKEN = u.searchParams.get('t') || '';
  var ALLOW_ANON = u.searchParams.get('nologin') === '1';   // testing only: run without a session
  var MAX = Number(u.searchParams.get('max') || 0) || 0;     // testing only: stop after N meetings
  var API = u.origin + '/api/board-export';
  var DELAY = 250;          // ms between BoardDocs requests
  var CHUNK = 3500000;      // bytes; Vercel's body cap is 4.5 MB
  var stop = false;

  if (window.__boardExportRunning) { alert('The export is already running in this tab.'); return; }
  window.__boardExportRunning = true;

  // ---------- panel ----------
  var panel = document.createElement('div');
  panel.id = 'board-export-panel';
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:360px;max-height:70vh;overflow:auto;background:#fff;color:#111;border:1px solid #999;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.35);font:13px/1.4 system-ui,Segoe UI,Arial,sans-serif;padding:14px 16px;';
  panel.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
    '<strong style="font-size:14px">Board records export</strong>' +
    '<button id="bx-stop" style="font:12px system-ui;padding:3px 8px;cursor:pointer">Stop</button></div>' +
    '<div id="bx-status" style="margin-bottom:6px">Starting…</div>' +
    '<div style="background:#eee;border-radius:4px;height:8px;overflow:hidden;margin-bottom:8px"><div id="bx-bar" style="background:#2b6cb0;height:8px;width:0%"></div></div>' +
    '<div id="bx-detail" style="color:#444;font-size:12px;white-space:pre-wrap"></div>' +
    '<div id="bx-errors" style="color:#b00;font-size:12px;white-space:pre-wrap;margin-top:6px"></div>';
  document.body.appendChild(panel);
  var $ = function (id) { return document.getElementById(id); };
  $('bx-stop').onclick = function () { stop = true; status('Stopping after the current document…'); };
  function status(t) { $('bx-status').textContent = t; }
  function detail(t) { $('bx-detail').textContent = t; }
  function bar(pct) { $('bx-bar').style.width = Math.max(0, Math.min(100, pct)) + '%'; }
  var errors = [];
  function err(t) { errors.push(t); $('bx-errors').textContent = errors.slice(-8).join('\n'); }

  // ---------- helpers ----------
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var m = location.pathname.match(/^\/([a-z]{2})\/([^/]+)\/Board\.nsf/i);
  if (!m || m[2].toLowerCase() !== ORG) {
    status('Wrong page.'); detail('Open BoardDocs for "' + ORG + '" (go.boarddocs.com/…/' + ORG + '/Board.nsf), sign in, then click the bookmark.');
    window.__boardExportRunning = false; return;
  }
  var BASE = location.origin + '/' + m[1] + '/' + m[2] + '/Board.nsf';
  var FILE_RE = new RegExp('(?:https?://' + location.host.replace(/\./g, '\\.') + ')?/' + m[1] + '/' + m[2] + '/Board\\.nsf/files/[^"\'\\s<>)]+', 'gi');

  function bdFetch(path, method, body) {
    var opts = { method: method || 'GET', credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } };
    if (body != null) { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'; opts.body = body; }
    var url = BASE + '/' + path + (path.indexOf('?') >= 0 ? '&' : '?') + Math.random();
    return fetch(url, opts);
  }
  async function bdText(path, method, body) {
    for (var a = 1; a <= 3; a++) {
      try {
        await sleep(DELAY);
        var r = await bdFetch(path, method, body);
        if (r.status >= 500) throw new Error('HTTP ' + r.status);
        return { status: r.status, text: await r.text() };
      } catch (e) { if (a === 3) throw e; await sleep(800 * a); }
    }
  }
  async function bdBlob(absUrl) {
    for (var a = 1; a <= 3; a++) {
      try {
        await sleep(DELAY);
        var r = await fetch(absUrl, { credentials: 'same-origin' });
        if (r.status >= 500) throw new Error('HTTP ' + r.status);
        if (!r.ok) return { status: r.status, blob: null };
        return { status: r.status, blob: await r.blob(), type: r.headers.get('content-type') || '' };
      } catch (e) { if (a === 3) throw e; await sleep(800 * a); }
    }
  }
  async function upload(relPath, data, type) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
    type = type || blob.type || 'application/octet-stream';
    var parts = [];
    if (blob.size > CHUNK) {
      var n = Math.ceil(blob.size / CHUNK);
      for (var i = 0; i < n; i++) parts.push({ path: relPath + '.part' + String(i + 1).padStart(3, '0'), blob: blob.slice(i * CHUNK, (i + 1) * CHUNK) });
    } else parts.push({ path: relPath, blob: blob });
    for (var p = 0; p < parts.length; p++) await uploadOne(parts[p].path, parts[p].blob, parts.length > 1 ? 'application/octet-stream' : type);
    if (parts.length > 1) {
      await uploadOne(relPath + '.parts.json', new Blob([JSON.stringify({ parts: parts.length, size: blob.size, type: type })]), 'application/json');
    }
    return blob.size;
  }
  async function uploadOne(relPath, blob, type) {
    var url = API + '?org=' + encodeURIComponent(ORG) + '&path=' + encodeURIComponent(relPath) + '&type=' + encodeURIComponent(type);
    for (var a = 1; a <= 4; a++) {
      try {
        var r = await fetch(url, { method: 'POST', headers: { 'X-Export-Token': TOKEN, 'Content-Type': 'application/octet-stream' }, body: blob });
        if (r.status === 401 || r.status === 404) throw new Error('export link is not valid (' + r.status + ')');
        if (!r.ok) throw new Error('upload HTTP ' + r.status);
        return;
      } catch (e) {
        if (/not valid/.test(String(e.message)) || a === 4) throw e;
        await sleep(1000 * a);
      }
    }
  }
  function decode(s) { var t = document.createElement('textarea'); t.innerHTML = s; return t.value; }
  function strip(html) { return decode(String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
  function isLoginPage(html) { return /<title>\s*Login Page/i.test(html) || /id="loginform"|name="Password"/i.test(html); }
  function filesIn(html) {
    var out = {}; var mm;
    while ((mm = FILE_RE.exec(html)) !== null) {
      var raw = mm[0]; if (raw[0] === '/') raw = location.origin + raw;
      var key = raw.replace(/[?#].*$/, '');
      out[key] = true;
    }
    FILE_RE.lastIndex = 0;
    return Object.keys(out);
  }
  function fileName(absUrl) {
    var mm = absUrl.match(/\/files\/([^/]+)\/\$file\/([^/?#]+)/i);
    var id = mm ? mm[1] : 'file', name = mm ? mm[2] : absUrl.split('/').pop();
    try { name = decodeURIComponent(name); } catch (e) { /* keep as is */ }
    name = name.replace(/[^A-Za-z0-9 _.,()&+\-\[\]'@=#!~]/g, '_').slice(0, 150);
    return id + '__' + name;
  }
  function dateKey(label) {
    var mm = label.match(/([A-Z][a-z]+) (\d{1,2}), (\d{4})/);
    if (!mm) return '0000-00-00';
    var mon = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 }[mm[1]] || 0;
    return mm[3] + '-' + String(mon).padStart(2, '0') + '-' + String(mm[2]).padStart(2, '0');
  }
  function slug(s) { return s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }

  // ---------- main ----------
  (async function main() {
    var started = new Date().toISOString();
    try {
      status('Reading the meeting list…');
      var packet = await bdText('BD-GetPacket?open', 'GET');
      if (packet.status !== 200) throw new Error('could not read the site (' + packet.status + ')');
      await upload('packet.html', packet.text, 'text/html');
      var meetings = [], re = /<a id ="([A-Z0-9]+)" unique="[A-Z0-9]+" committeeid="([A-Z0-9]+)"[^>]*>([\s\S]*?)<\/a>/g, mm;
      while ((mm = re.exec(packet.text)) !== null) meetings.push({ id: mm[1], committee: mm[2], label: strip(mm[3]) });
      if (!meetings.length) throw new Error('no meetings found on this site');
      if (MAX) meetings = meetings.slice(0, MAX);

      // Signed in? Minutes are the one thing this district keeps behind its login.
      var probe = await bdText('BD-GetMinutes?open&login', 'POST', 'id=' + meetings[0].id);
      var signedIn = !isLoginPage(probe.text);
      if (!signedIn && !ALLOW_ANON) {
        status('Please sign in first.');
        detail('You are not signed in to BoardDocs in this tab, so minutes and attachments would be skipped. Sign in (the Login button at the top of the page), then click the bookmark again.');
        window.__boardExportRunning = false; return;
      }

      var manifest = { org: ORG, ver: VER, meetings: {}, library: {} };
      try {
        var mr = await fetch(API + '?org=' + encodeURIComponent(ORG) + '&action=manifest', { headers: { 'X-Export-Token': TOKEN } });
        if (mr.status === 401 || mr.status === 404) throw new Error('export link is not valid (' + mr.status + ')');
        if (mr.ok) { var mj = await mr.json(); if (mj && mj.meetings) manifest = mj; }
      } catch (e) { if (/not valid/.test(String(e.message))) throw e; }
      manifest.ver = VER; manifest.signedIn = signedIn; manifest.lastStarted = started;
      manifest.meetingCount = meetings.length;
      var doneBefore = Object.keys(manifest.meetings).filter(function (k) { return manifest.meetings[k].done; }).length;
      var totalFiles = 0, totalBytes = 0, doneNow = 0;
      async function saveManifest() { manifest.updated = new Date().toISOString(); await upload('manifest.json', JSON.stringify(manifest, null, 1), 'application/json'); }

      for (var i = 0; i < meetings.length; i++) {
        if (stop) break;
        var mt = meetings[i];
        var prev = manifest.meetings[mt.id];
        // Skip only what a run of equal standing already finished: a meeting captured without a
        // session is redone once someone signed in clicks, because that pass can see more.
        if (prev && prev.done && (prev.signedIn || !signedIn)) continue;
        var key = 'meetings/' + dateKey(mt.label) + '_' + slug(mt.label.replace(/^[A-Za-z]+, [A-Z][a-z]+ \d{1,2}, \d{4}\s*/, '')) + '_' + mt.id;
        var pct = Math.round(100 * (doneBefore + doneNow) / meetings.length);
        bar(pct); status('Meeting ' + (doneBefore + doneNow + 1) + ' of ' + meetings.length + ' (' + pct + '%)');
        detail(mt.label);
        var rec = { id: mt.id, label: mt.label, date: dateKey(mt.label), key: key, items: [], files: [], minutes: 'none' };
        try {
          var html = {};
          html.meeting = (await bdText('BD-GetMeeting?open', 'POST', 'id=' + mt.id + '&current_committee_id=' + mt.committee)).text;
          html.agenda = (await bdText('BD-GetAgenda?open', 'POST', 'id=' + mt.id + '&current_committee_id=' + mt.committee)).text;
          html.detailed = (await bdText('Download-AgendaDetailed?open', 'POST', 'id=' + mt.id)).text;
          var mn = await bdText('BD-GetMinutes?open&login', 'POST', 'id=' + mt.id);
          if (isLoginPage(mn.text)) rec.minutes = 'login-required';
          else if (strip(mn.text).length > 20) { html.minutes = mn.text; rec.minutes = 'ok'; }
          await upload(key + '/meeting.html', html.meeting, 'text/html');
          await upload(key + '/agenda.html', html.agenda, 'text/html');
          await upload(key + '/agenda-detailed.html', html.detailed, 'text/html');
          if (html.minutes) await upload(key + '/minutes.html', html.minutes, 'text/html');

          var items = [], ire = /<li\b[^>]*\bclass="[^"]*\bitem\b[^"]*"[^>]*>/g, im;
          while ((im = ire.exec(html.agenda)) !== null) {
            var tag = im[0], idm = tag.match(/\sid="([A-Z0-9]{12})"/), tm = tag.match(/\bXtitle="([^"]*)"/i);
            if (idm) items.push({ id: idm[1], title: decode(tm ? tm[1] : '') });
          }
          var allHtml = html.meeting + html.agenda + html.detailed + (html.minutes || '');
          for (var k = 0; k < items.length; k++) {
            if (stop) break;
            detail(mt.label + '\nItem ' + (k + 1) + ' of ' + items.length + ': ' + items[k].title.slice(0, 80));
            var it = await bdText('BD-GetAgendaItem?open', 'POST', 'id=' + items[k].id + '&current_committee_id=' + mt.committee);
            var fname = 'items/' + String(k + 1).padStart(2, '0') + '_' + items[k].id + '.html';
            await upload(key + '/' + fname, it.text, 'text/html');
            allHtml += it.text;
            rec.items.push({ id: items[k].id, title: items[k].title, file: fname, bytes: it.text.length });
          }
          var files = filesIn(allHtml);
          for (var f = 0; f < files.length; f++) {
            if (stop) break;
            var name = fileName(files[f]);
            detail(mt.label + '\nAttachment ' + (f + 1) + ' of ' + files.length + ': ' + name.slice(0, 80));
            var fb = await bdBlob(files[f]);
            if (!fb.blob) { rec.files.push({ url: files[f], name: name, status: fb.status }); err(mt.date + ' attachment ' + fb.status + ': ' + name); continue; }
            var sz = await upload(key + '/files/' + name, fb.blob, fb.type.split(';')[0] || 'application/octet-stream');
            rec.files.push({ url: files[f], name: name, bytes: sz, type: fb.type });
            totalFiles++; totalBytes += sz;
          }
          rec.done = !stop;
          rec.at = new Date().toISOString();
          await upload(key + '/meeting.json', JSON.stringify(rec, null, 1), 'application/json');
          manifest.meetings[mt.id] = { done: rec.done, signedIn: signedIn, key: key, label: mt.label, date: rec.date, items: rec.items.length, files: rec.files.length, minutes: rec.minutes, at: rec.at };
          if (rec.done) doneNow++;
        } catch (e) {
          err(mt.date + ' ' + mt.label.slice(0, 40) + ': ' + (e && e.message ? e.message : e));
          manifest.meetings[mt.id] = { done: false, signedIn: signedIn, key: key, label: mt.label, date: rec.date, error: String(e && e.message || e), at: new Date().toISOString() };
          if (/not valid/.test(String(e && e.message))) throw e;
        }
        await saveManifest();
      }

      // Library — document areas outside the meetings, if the district uses them.
      if (!stop) {
        status('Reading the library…');
        var types = [''];
        var sel = document.querySelector('#current-library-type');
        if (sel && sel.options) for (var o = 0; o < sel.options.length; o++) if (sel.options[o].value) types.push(sel.options[o].value);
        document.querySelectorAll('[data-library-type],[librarytype]').forEach(function (el) { var v = el.getAttribute('data-library-type') || el.getAttribute('librarytype'); if (v && types.indexOf(v) < 0) types.push(v); });
        for (var t = 0; t < types.length; t++) {
          try {
            var lib = await bdText('BD-GetLibrary?open', 'POST', 'type=' + encodeURIComponent(types[t]));
            if (/There are no documents/i.test(lib.text) || strip(lib.text).length < 5) { manifest.library[types[t] || 'default'] = { items: 0 }; continue; }
            var lkey = 'library/' + (slug(types[t]) || 'default');
            await upload(lkey + '/index.html', lib.text, 'text/html');
            var ids = [], lre = /unique="([A-Z0-9]{12})"/g, lm, seen = {};
            while ((lm = lre.exec(lib.text)) !== null) if (!seen[lm[1]]) { seen[lm[1]] = 1; ids.push(lm[1]); }
            var lhtml = lib.text, count = 0;
            for (var q = 0; q < ids.length; q++) {
              if (stop) break;
              var li = await bdText('BD-GetLibraryItem?open&id=' + ids[q] + '&type=' + encodeURIComponent(types[t]), 'GET');
              await upload(lkey + '/items/' + ids[q] + '.html', li.text, 'text/html'); lhtml += li.text; count++;
            }
            var lfiles = filesIn(lhtml);
            for (var lf = 0; lf < lfiles.length; lf++) {
              if (stop) break;
              var lb = await bdBlob(lfiles[lf]); if (!lb.blob) continue;
              var lsz = await upload(lkey + '/files/' + fileName(lfiles[lf]), lb.blob, lb.type.split(';')[0] || 'application/octet-stream');
              totalFiles++; totalBytes += lsz;
            }
            manifest.library[types[t] || 'default'] = { items: count, files: lfiles.length, at: new Date().toISOString() };
          } catch (e) { err('library ' + (types[t] || 'default') + ': ' + (e && e.message || e)); }
        }
      }

      manifest.finished = stop ? null : new Date().toISOString();
      await saveManifest();
      var totalDone = Object.keys(manifest.meetings).filter(function (k) { return manifest.meetings[k].done; }).length;
      bar(stop ? Math.round(100 * totalDone / meetings.length) : 100);
      if (stop) { status('Stopped. ' + totalDone + ' of ' + meetings.length + ' meetings saved — click the bookmark again to continue.'); }
      else { status('Finished — thank you. You can close this tab.'); detail(totalDone + ' of ' + meetings.length + ' meetings, ' + totalFiles + ' attachments (' + (totalBytes / 1048576).toFixed(1) + ' MB) this run.' + (errors.length ? '\n' + errors.length + ' item(s) could not be read; they are listed below.' : '')); }
    } catch (e) {
      status('Stopped: ' + (e && e.message ? e.message : e));
      detail('If this keeps happening, close the tab and click the bookmark again; it resumes where it stopped.');
    } finally { window.__boardExportRunning = false; }
  })();
})();
