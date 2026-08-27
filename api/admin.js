// api/admin.js — CivicScope admin read/write proxy
// Gates service_role access behind CIVICSCOPE_ADMIN_SECRET so no key
// ships to the browser. Reads moved here 2026-07-13 when RLS was enabled
// (tables were publicly readable via the anon key in the public repo).
//
// 2026-08-26 — Ask and Well Testing joined it, and the GC white-label registry left it the same
// day. Until that morning the only tenant registry this endpoint knew was `tenants`, the GC one,
// so the admin page's "ACTIVE TENANTS 2" tile was counting acme and ryc while the two LIVE
// municipal products (`muni_tenants`) and the water supply (`water_supplies`) had no admin
// surface at all — they were rows edited by script. The GC product had been PARKED since the
// 2026-07-08 Fable review (one demo tenant in four months); Keith called it dead, so the tile that
// prompted all of this is gone rather than corrected.
//
// ⛔ A TABLE REGISTRY, NOT THREE MORE `if` BRANCHES. Every table here now declares its primary key,
// which columns a browser may write, and which columns may be READ BACK. That last one is not
// decoration: `water_operators.pin` is a 4-digit code that unlocks a crew tablet, and the previous
// read path forwarded the caller's own `select` verbatim — so adding that table to the readable set
// without a column guard would have published every operator PIN to anyone holding the admin
// passphrase, through `select=*`. A write allowlist matters for the same reason in reverse:
// `muni_tenants.anthropic_key_env` names the environment variable a village's Anthropic key is read
// from, and a column whose value indexes process.env must not be settable from a browser form.

import { summarize, dailyCounts } from '../civicscope-admin/usage.js';

/*
 * key         — the primary key column PATCH targets. `muni_tenants` is keyed on `slug`, not `id`,
 *               and the old hardcoded `?id=eq.` would have silently matched nothing and reported
 *               success, because PostgREST is happy to update zero rows.
 * read        — columns the browser may read back. Absent = the whole row.
 * write       — columns the browser may write. Absent = any column (legacy `tenants` behaviour,
 *               left exactly as it was).
 * insert      — may this table take new rows at all.
 */
const TABLES = {
  /* ⛔ NO `tenants` ENTRY. The GC white-label tenant registry was removed from this proxy on
     2026-08-26 — Keith: "you can blow away the GC as tenant thing. That is dead." The admin page
     no longer reads or writes it, so leaving a service-role write path open to a table nothing
     manages is surface for no benefit. `api/gc-config.js` still reads that table with its own
     credential to serve the surviving /gc/:slug routes; this endpoint simply has no business
     there any more. Restoring it is one entry plus one name in WRITABLE. */

  // ── Ask <Municipality> ────────────────────────────────────────────────────────────────────
  muni_tenants: {
    key: 'slug',
    insert: true,
    /* NOT writable, deliberately, and each for its own reason:
       - anthropic_key_env  selects an environment variable. See the header.
       - auth_client_id / auth_provider  per-village security config; the audience every ID token
         is verified against. Changing it from a form is changing who can sign in.
       - sample_questions   `scripts/verify-sample-questions.mjs` is the ONLY supported writer.
         Nothing lands there that has not been asked against that tenant's live corpus and come
         back `answered` — a chip typed into a text box is exactly the unverified suggestion that
         migration 048 exists to prevent.
       - doc_count / last_ingest_at  written by the ingesters; they are a measurement, not a setting.
       - shares_corpus_with  a foreign key that changes what law a town is answered from. */
    write: ['label', 'short_label', 'unit_noun', 'site_url', 'blurb', 'logo_url', 'active', 'water_wssn'],
  },

  // ── Well Testing ──────────────────────────────────────────────────────────────────────────
  water_supplies: {
    key: 'id',
    insert: false,
    /* `wssn` is the state supply number and the key the tablet unlocks on — renaming it from a
       browser would orphan every reading. `mor_template` selects the workbook generator. */
    write: ['name', 'county', 'state', 'classification', 'oic_name', 'oic_cert',
      'report_to_email', 'lab_name', 'timezone', 'min_free_cl', 'active'],
  },
  water_entry_points: {
    key: 'id',
    insert: true,
    write: ['code', 'label', 'well_no', 'mor_sheet', 'has_meter', 'meter_gallons_per_unit',
      'records_pressure', 'records_temp', 'tap_free', 'tap_total', 'tap_ortho', 'tap_fluoride',
      'sort_order', 'active', 'supply_id'],
  },
  water_sites: { key: 'id', insert: true, write: ['name', 'kind', 'sort_order', 'active', 'supply_id'] },
  water_operators: {
    key: 'id',
    insert: true,
    /* ⛔ `pin` is writable and NOT readable. An operator who forgets theirs needs somebody able to
       set a new one, and that is desk work; nobody ever needs to read the existing one back, and
       an endpoint that can is a credential dump waiting for a `select=*`. */
    read: ['id', 'supply_id', 'name', 'initials', 'is_oic', 'active', 'created_at'],
    write: ['name', 'initials', 'is_oic', 'active', 'pin', 'supply_id'],
  },
  /* Read-only on purpose. avail_fraction, ortho_factor and nsf_max_dose are the constants
     `civicscope-water/derive.js` multiplies to produce numbers that are FILED WITH THE STATE OF
     MICHIGAN under 1976 PA 399. Changing 0.125 to 0.25 in a text box silently rewrites every dose
     the plant reports. If a drum strength genuinely changes, that is a deliberate act with a
     migration and a re-run of the derivation gate, not an afternoon edit. */
  water_feeds: { key: 'id', insert: false },
  water_mor_filings: { key: 'id', insert: false },
  water_mor_reminders: { key: 'id', insert: false },
  // Read-only analytics tables the Overview tab has always used.
  leads: { key: 'id', insert: false },
  sessions: { key: 'id', insert: false },
  tool_runs: { key: 'id', insert: false },
  qa_runs: { key: 'id', insert: false },
  /* ⛔ COLUMN-RESTRICTED FOR SIZE, NOT SECRECY. `raw_text` holds the OCR transcript of a whole
     ordinance book — Centreville's zoning book alone is a 645,000-character text layer, and
     `segments` carries the table map beside it. A careless `select=*` here does not leak anything,
     it just ships several megabytes to a browser and looks like the page hanging. */
  muni_docs: {
    key: 'id',
    insert: false,
    read: ['id', 'tenant', 'title', 'collection', 'folder_path', 'source_url', 'text_source',
      'page_count', 'chunk_count', 'needs_ocr', 'byte_size', 'modified_at', 'updated_at'],
  },
};

const WRITABLE = new Set(['muni_tenants', 'water_supplies', 'water_entry_points',
  'water_sites', 'water_operators']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ADMIN_SECRET = process.env.CIVICSCOPE_ADMIN_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!ADMIN_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const supplied = req.headers['x-admin-secret'];
  if (!supplied || supplied !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = async (path, init = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        ...(init.headers || {}),
      },
    });
    if (!r.ok) {
      const err = new Error(await r.text());
      err.status = r.status;
      throw err;
    }
    return r.status === 204 ? null : r.json();
  };

  try {
    const { action, table, body, id } = req.body || {};

    if (action === 'auth_check') {
      return res.status(200).json({ ok: true });
    }

    // ── generic table read ──────────────────────────────────────────────────────────────────
    if (action === 'read') {
      const { path } = req.body || {};
      if (typeof path !== 'string' || path.includes('..') || path.startsWith('/')) {
        return res.status(400).json({ error: 'Bad path' });
      }
      const [tableName, qs = ''] = path.split('?');
      const spec = TABLES[tableName];
      if (!spec) return res.status(400).json({ error: `Table not readable: ${tableName}` });

      let finalPath = path;
      if (spec.read) {
        /* The caller's own `select` is REPLACED, not merged and not validated. A guard that tries
           to reason about what the caller asked for has to be right about every PostgREST
           projection syntax — embedded resources, renames, casts. Overwriting it has to be right
           about one thing. */
        const params = new URLSearchParams(qs);
        params.set('select', spec.read.join(','));
        finalPath = `${tableName}?${params.toString()}`;
      }
      return res.status(200).json(await sb(finalPath));
    }

    // ── generic table write ─────────────────────────────────────────────────────────────────
    if (action === 'write') {
      const spec = TABLES[table];
      if (!spec || !WRITABLE.has(table)) {
        return res.status(400).json({ error: `Table not allowed: ${table}` });
      }
      if (!id && !spec.insert) {
        return res.status(400).json({ error: `${table} does not take new rows here` });
      }

      let payload = body || {};
      if (spec.write) {
        /* The key column is settable on INSERT and never on UPDATE. A new muni_tenants row has to
           carry its own `slug` — it is the primary key, there is nothing to generate it — but
           renaming a live tenant's slug would orphan every muni_docs and muni_chunks row that
           references it and break the vercel.json rewrite pointing at it. */
        const allowed = id ? spec.write : [...spec.write, spec.key || 'id'];
        const rejected = Object.keys(payload).filter((k) => !allowed.includes(k));
        /* Refuse rather than silently drop. A form that posts a column it may not set and gets a
           200 back has been told its edit landed, and the operator has no way to know it did not —
           the same "success that changed nothing" the `?id=eq.` key bug would have produced. */
        if (rejected.length) {
          return res.status(400).json({ error: `Not writable on ${table}: ${rejected.join(', ')}` });
        }
      }
      if (table === 'water_operators' && 'pin' in payload) {
        const p = payload.pin;
        // null clears it (schema: "null until the operator sets one"); otherwise exactly 4 digits,
        // the same rule api/water-ops.js applies on add_operator.
        if (p !== null && !/^\d{4}$/.test(String(p))) {
          return res.status(400).json({ error: 'pin must be 4 digits, or null to clear it' });
        }
        payload = { ...payload, pin: p === null ? null : String(p) };
      }

      const key = spec.key || 'id';
      const url = id
        ? `${table}?${key}=eq.${encodeURIComponent(id)}`
        : table;
      const rows = await sb(url, {
        method: id ? 'PATCH' : 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(payload),
      });
      /* PostgREST reports a PATCH that matched nothing as 200 with []. Before the key registry
         above, every muni_tenants edit would have done exactly that. Say so. */
      if (id && Array.isArray(rows) && rows.length === 0) {
        return res.status(404).json({ error: `No ${table} row with ${key} = ${id} — nothing was changed` });
      }
      if (spec.read && Array.isArray(rows)) {
        return res.status(200).json(rows.map((r) => {
          const out = {};
          for (const c of spec.read) if (c in r) out[c] = r[c];
          return out;
        }));
      }
      return res.status(200).json(rows);
    }

    // ── Ask: usage ──────────────────────────────────────────────────────────────────────────
    /* Aggregated HERE rather than in the page, so the admin tab and `scripts/muni-usage.mjs`
       cannot drift: both call summarize() out of civicscope-admin/usage.js. */
    if (action === 'muni_usage') {
      const days = Math.min(365, Math.max(1, Number(req.body.days) || 30));
      const tenant = String(req.body.tenant || '');
      /* Verifier traffic is excluded unless asked for. verify-sample-questions.mjs probes a broad
         candidate pool and is refused most of the time BY DESIGN; counting it as a municipality
         failing to answer made Bristol read 23% declined on a day its corpus had just been fixed. */
      const allSources = Boolean(req.body.allSources);
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const q = [
        `created_at=gte.${since}`,
        tenant ? `tenant=eq.${encodeURIComponent(tenant)}` : '',
        allSources ? '' : 'source=eq.web',
        'select=id,tenant,question,outcome,source,hit_count,used_table,cited_collections,duration_ms,retrieval,created_at',
        'order=created_at.desc',
        'limit=4000',
      ].filter(Boolean).join('&');
      const rows = await sb(`muni_questions?${q}`);
      return res.status(200).json({
        days,
        tenant: tenant || null,
        allSources,
        rowCount: rows.length,
        summary: summarize(rows),
        daily: dailyCounts(rows, days),
        recent: rows.slice(0, 200),
      });
    }

    // ── Ask: what the corpus is actually made of ────────────────────────────────────────────
    if (action === 'muni_corpus') {
      const tenant = String(req.body.tenant || '');
      if (!tenant) return res.status(400).json({ error: 'tenant required' });
      // NEVER select raw_text or segments — one is an entire transcribed ordinance book.
      const docs = await sb(`muni_docs?tenant=eq.${encodeURIComponent(tenant)}`
        + '&select=collection,text_source,page_count,chunk_count,needs_ocr,updated_at&limit=5000');
      const by = {};
      let docCount = 0; let chunkCount = 0; let scanned = 0; let pages = 0; let newest = null;
      for (const d of docs) {
        const c = (by[d.collection || '(none)'] ||= { collection: d.collection || '(none)', docs: 0, chunks: 0, scans: 0, pages: 0, newest: null });
        c.docs++; docCount++;
        c.chunks += d.chunk_count || 0; chunkCount += d.chunk_count || 0;
        c.pages += d.page_count || 0; pages += d.page_count || 0;
        if (d.text_source === 'ocr') { c.scans++; scanned++; }
        if (!c.newest || d.updated_at > c.newest) c.newest = d.updated_at;
        if (!newest || d.updated_at > newest) newest = d.updated_at;
      }
      return res.status(200).json({
        tenant,
        docCount,
        chunkCount,
        scanned,
        pages,
        newest,
        collections: Object.values(by).sort((a, b) => b.docs - a.docs),
      });
    }

    // ── Well Testing: the plant's operating state ───────────────────────────────────────────
    if (action === 'water_state') {
      const wssn = String(req.body.wssn || '');
      const supplies = await sb('water_supplies?select=*&order=name');
      const supply = wssn ? supplies.find((s) => s.wssn === wssn) : supplies[0];
      if (!supply) return res.status(404).json({ error: 'no water supply configured' });

      const sid = supply.id;
      const opCols = TABLES.water_operators.read.join(',');
      /* Three months of reading METADATA — no observations, no chemistry. Enough to draw a
         coverage grid and to answer the only question that matters operationally: is the plant
         being logged in the product, or still on paper? */
      const since = new Date(Date.now() - 95 * 86400_000).toISOString().slice(0, 10);
      const entryPoints = await sb(`water_entry_points?supply_id=eq.${sid}&select=*&order=sort_order`);
      // water_feeds hangs off the entry point, not the supply — scope it to THIS plant's wells
      // rather than reading every feed row and filtering after.
      const epFilter = entryPoints.length
        ? `entry_point_id=in.(${entryPoints.map((e) => e.id).join(',')})&` : 'id=is.null&';
      const [feeds, sites, operators, readings, filings, reminders, opsWithPin] = await Promise.all([
        sb(`water_feeds?${epFilter}select=*&order=sort_order`),
        sb(`water_sites?supply_id=eq.${sid}&select=*&order=sort_order`),
        sb(`water_operators?supply_id=eq.${sid}&select=${opCols}&order=name`),
        sb(`water_readings?supply_id=eq.${sid}&reading_date=gte.${since}`
          + '&select=reading_date,entry_point_id,operator_initials,source,superseded_at&order=reading_date.desc&limit=2000'),
        sb(`water_mor_filings?supply_id=eq.${sid}&select=id,report_year,report_month,submitted_date,signed_by,source,workbook_name,superseded_at,created_at&order=report_year.desc,report_month.desc`),
        sb(`water_mor_reminders?supply_id=eq.${sid}&select=report_year,report_month,kind,sent_at,outcome,recipients,detail&order=sent_at.desc&limit=20`),
        /* Whether a PIN EXISTS, never what it is. `pin=not.is.null` is answered by PostgREST
           without the value ever leaving the database. */
        sb(`water_operators?supply_id=eq.${sid}&pin=not.is.null&select=id`),
      ]);

      const withPin = new Set((opsWithPin || []).map((o) => o.id));
      const live = readings.filter((r) => !r.superseded_at);
      const bySource = {};
      for (const r of live) bySource[r.source] = (bySource[r.source] || 0) + 1;

      /* Coverage: for each of the last three months, how many (well, day) slots were logged out
         of how many were possible up to today. This is where "August is still being written on
         paper" stops being a note in a file and becomes a number on a screen. */
      const epIds = entryPoints.filter((e) => e.active).map((e) => e.id);
      /* ⚠ "Today" is today AT THE PLANT, not in UTC. `reading_date` is a local calendar date, so
         between ET midnight and 04:00Z a UTC clock is a day ahead and the current month's
         denominator would silently gain a day nobody could have logged yet. This is the same
         mistake the daily digest made for five months — headlining yesterday's numbers with
         today's date — fixed here ahead of it rather than after. */
      const tz = supply.timezone || 'America/Detroit';
      const [ty, tm, td] = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date()).split('-').map(Number);
      const months = [];
      for (let back = 0; back < 3; back++) {
        const d = new Date(Date.UTC(ty, tm - 1 - back, 1));
        const y = d.getUTCFullYear(); const m = d.getUTCMonth() + 1;
        const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const isCurrent = back === 0;
        const daysElapsed = isCurrent ? td : daysInMonth;
        const prefix = `${y}-${String(m).padStart(2, '0')}`;
        const rows = live.filter((r) => String(r.reading_date).startsWith(prefix));
        const slots = new Set(rows.map((r) => `${r.reading_date}|${r.entry_point_id}`));
        const daysSeen = new Set(rows.map((r) => r.reading_date));
        const src = {};
        for (const r of rows) src[r.source] = (src[r.source] || 0) + 1;
        const filing = filings.find((f) => !f.superseded_at && f.report_year === y && f.report_month === m);
        months.push({
          year: y, month: m, label: prefix, daysInMonth, daysElapsed,
          possible: epIds.length * daysElapsed,
          logged: slots.size,
          daysWithAnyReading: daysSeen.size,
          bySource: src,
          filed: Boolean(filing),
          filedOn: filing ? filing.submitted_date : null,
        });
      }

      return res.status(200).json({
        supplies: supplies.map((s) => ({ wssn: s.wssn, name: s.name, active: s.active })),
        supply,
        entryPoints,
        feeds,
        sites,
        operators: operators.map((o) => ({ ...o, has_pin: withPin.has(o.id) })),
        readings: {
          window: `${since} →`,
          live: live.length,
          superseded: readings.length - live.length,
          latest: live.length ? live[0].reading_date : null,
          bySource,
        },
        months,
        filings,
        reminders,
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Admin proxy error:', err);
    return res.status(err.status || 500).json({ error: err.message });
  }
}
