// api/water-town.js — Well Testing: what a TOWN'S OWN ADMIN may change, and nothing else.
//
// 2026-11-18. Until now a town's settings were changed by CivicScope on its own admin page
// (api/admin.js, behind a passphrase) or by script. Keith, 2026-11-18: a town gets its own admin
// page — for the first town, "Michelle and I are admins". This is the server side of that page
// (civicscope-water/admin.html, served at /water/admin).
//
// WHO. A town admin signs in the way the village office already does (the town's Google sign-in,
// api/auth-google.js). Two kinds of people pass:
//   town admin     an active `app_users` row with `town_admin = true` whose `water_wssn` IS the town
//                  being asked about (migration 106). Another town's admin is nobody here.
//   product admin  an active `app_users` row with `role = 'admin'` — CivicScope. Every town.
// The person is re-read from the database on every request (lib/office-user.js), so turning a
// town admin off takes effect at once. Nothing in this file trusts a claim the browser sends about
// who it is, which town it belongs to, or what it is allowed to do.
//
// WHAT A TOWN ADMIN MAY CHANGE — the whole list, agreed with the owner 2026-11-18:
//   the monthly report's cover details   oic_name, oic_cert, cover_signed_by, report_to_email
//   the two bacti details                bacti_routine_required, bacti_method
//   PIN at the well                      require_pin (same guards as the owner's admin page)
//   operators                            add one, retire or bring back, set or clear a PIN
//   office sign-ins for THEIR town       add a person, turn one off or back on
// WHAT STAYS WITH CIVICSCOPE — not reachable from here by anybody:
//   chemical strengths and maximum doses (they are multiplied into numbers filed with the State),
//   wells, sampling sites, the report template, the town's name / number / timezone, making a town
//   live, and who is a town admin (only a product admin may set that mark, below).
//
// ⛔ A PIN IS NEVER READ BACK, LOGGED OR RETURNED. It arrives, is hashed (lib/pin.js — the one copy
// of the hash), and only "has a PIN: yes / no" ever leaves this file. The change record
// (`water_admin_log`) says that a PIN was set, never what it was.
//
// ⛔ THIS FILE DOES NOT TOUCH READINGS, SAMPLES, FILINGS OR GENERATED REPORTS. Those are
// api/water-ops.js. Nothing here can change a number that is filed with the State.
//
// Every successful change writes one row to `water_admin_log`. If that write fails the change still
// stands and the answer carries `logged:false`, which the page shows — a change that silently left
// no record is the failure this is here to prevent.

import { officeUserOf } from '../lib/office-user.js';
import { hashPin, isPinFormat } from '../lib/pin.js';

const VER = '1.0.0-watertown';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// ---------------------------------------------------------------------------------------------
// Supabase — reads are retried on a gateway failure, writes never are (the same rule and the same
// reason as api/water-ops.js: a timeout can arrive after the row has landed).
// ---------------------------------------------------------------------------------------------
async function sb(pathAndQuery, init = {}) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  const attempts = (method === 'GET' || method === 'HEAD') ? [0, 300, 900] : [0];
  let r = null, body = '', lastErr = null;
  for (const wait of attempts) {
    if (wait) await new Promise((ok) => setTimeout(ok, wait));
    try {
      r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
        ...init,
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
    } catch (e) { lastErr = e; r = null; continue; }
    body = await r.text();
    if (r.ok || r.status < 500) break;
    lastErr = new Error(`supabase ${r.status}: ${body.slice(0, 300)}`);
  }
  if (!r) throw lastErr || new Error('supabase unreachable');
  if (!r.ok) throw new Error(`supabase ${r.status}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

// ---------------------------------------------------------------------------------------------
// small, strict helpers
// ---------------------------------------------------------------------------------------------
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isWssn = (s) => typeof s === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(s);
const enc = encodeURIComponent;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const bad = (res, code, msg, extra = {}) => res.status(code).json({ ok: false, error: msg, ...extra });

/* A refusal carries a sentence for the person. It is thrown and turned into a 4xx in one place. */
class Refuse extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const refuse = (status, message, extra) => { throw new Refuse(status, message, extra); };

/** Text from a form: a string, trimmed; empty or null becomes null; too long is refused. */
function textOrNull(v, label, max) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') refuse(400, `${label} must be text.`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length > max) refuse(400, `${label} is too long (${max} characters at most).`);
  return t;
}
function textRequired(v, label, max) {
  const t = textOrNull(v, label, max);
  if (!t) refuse(400, `${label} is required.`);
  return t;
}

const EMAIL_RE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;
const normEmail = (s) => String(s || '').trim().toLowerCase();
/* `ilike` is a pattern, not an equality (api/auth-google.js, 2026-11-17): the metacharacters are
   escaped for the query and the rows returned are then compared exactly, in code. */
const likeExact = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`).replace(/\*/g, '_');

const ROLE_WORDS = { oic: 'operator in charge', staff: 'office staff' };
/* A typed name inside a change-record sentence. Actions in one sentence are joined with "; ", so a
   name may not carry one: "Bob; Made Eve a town admin" must not read as a second action. */
const nm = (v) => String(v === null || v === undefined ? '' : v).replace(/[;"]/g, ',');
/* A value shown inside a change-record sentence. Its own double quotes become single ones, so a
   typed value can never close the quotation and read as a second, invented action. */
const quote = (v) => (v === null || v === undefined || v === '' ? '(empty)' : `"${String(v).replace(/"/g, "'")}"`);

// ---------------------------------------------------------------------------------------------
// the settings a town admin may change — the allowlist IS this object
// ---------------------------------------------------------------------------------------------
const SETTINGS = {
  oic_name:        { label: 'Operator in charge', clean: (v) => textOrNull(v, 'Operator in charge', 120) },
  oic_cert:        { label: 'Certification', clean: (v) => textOrNull(v, 'Certification', 60) },
  cover_signed_by: { label: 'Signed by', clean: (v) => textOrNull(v, 'Signed by', 160) },
  report_to_email: {
    label: 'Report is sent to',
    clean: (v) => {
      const t = textOrNull(v, 'Report is sent to', 200);
      if (t === null) return null;
      const parts = t.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
      if (!parts.length || !parts.every((p) => EMAIL_RE.test(p))) {
        refuse(400, 'Enter an email address for "Report is sent to". For more than one, separate them with a comma.');
      }
      return parts.join(', ');
    },
  },
  bacti_routine_required: {
    label: 'Routine bacti samples required each month',
    clean: (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 31) {
        refuse(400, 'Routine bacti samples required must be a whole number from 0 to 31, or left empty.');
      }
      return v;
    },
  },
  bacti_method:    { label: 'Lab method', clean: (v) => textOrNull(v, 'Lab method', 120) },
  require_pin: {
    label: 'PIN at the well',
    clean: (v) => {
      if (typeof v !== 'boolean') refuse(400, 'PIN at the well must be on or off.');
      return v;
    },
  },
};
const SETTING_KEYS = Object.keys(SETTINGS);
const SUPPLY_COLS = ['id', 'wssn', 'name', 'county', 'classification', ...SETTING_KEYS].join(',');

async function loadSupply(wssn) {
  const rows = await sb(`water_supplies?wssn=eq.${enc(wssn)}&select=${SUPPLY_COLS}&limit=1`);
  return (rows && rows[0]) || null;
}
/* The town's own page (the village hub), which is also the `muni_tenant` its office people are
   enrolled under. A town with no hub has no sign-in, so null is a real answer. */
async function tenantSlugOf(wssn) {
  const rows = await sb(`muni_tenants?water_wssn=eq.${enc(wssn)}&active=eq.true&select=slug&order=slug&limit=1`);
  return (rows && rows[0] && rows[0].slug) || null;
}

/* WHO MAY ADMINISTER THIS TOWN. The whole rule, in one place. `user` is the active enrolment
   lib/office-user.js returned (or null). */
function authorityOf(user, wssn) {
  if (!user) return null;
  if (user.role === 'admin') return 'product_admin';
  if (user.town_admin === true && typeof user.water_wssn === 'string' && user.water_wssn === wssn) return 'town_admin';
  return null;
}

/* One row in the change record. Returns whether it was written — never throws, because the change
   it describes has already happened. */
async function writeLog(ctx, action, summary, { targetKind = null, targetId = null, detail = {} } = {}) {
  try {
    await sb('water_admin_log', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{
        supply_id: ctx.supply.id, wssn: ctx.supply.wssn,
        actor_user_id: ctx.user.id, actor_email: ctx.user.email || null, actor_name: ctx.user.name || null,
        actor_kind: ctx.kind, action, target_kind: targetKind, target_id: targetId,
        summary: String(summary).slice(0, 500), detail,
      }]),
    });
    return true;
  } catch (e) {
    console.error('water-town: change record not written:', redact(e));
    return false;
  }
}

// a database error can quote a failing row; a PIN hash must never reach a log line or a response
// (everything from "Failing row contains" to the end is dropped: a quoted row could hold a value that
// must not reach a log line, and the text may be cut short before its closing bracket)
const redact = (e) => String((e && e.message) || e)
  .replace(/Failing row contains[\s\S]*$/i, '[row redacted]')
  .replace(/scrypt\$[^\s,)"']*/g, '[redacted]');

const publicOperator = (o) => ({
  id: o.id, name: o.name, initials: o.initials, is_oic: Boolean(o.is_oic), active: o.active !== false,
  has_pin: Boolean(o.pin_hash || o.pin),
  locked_until: o.pin_locked_until && Date.parse(o.pin_locked_until) > Date.now() ? o.pin_locked_until : null,
});
const OPERATOR_COLS = 'id,name,initials,is_oic,active,pin_hash,pin,pin_locked_until';
const PERSON_COLS = 'id,email,name,role,active,town_admin,last_seen_at,water_wssn,muni_tenant';

// ---------------------------------------------------------------------------------------------
// the handler
// ---------------------------------------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    // the version probe: the cheapest answer to "did this route ship"
    return res.status(200).json({ ver: VER });
  }
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  if (!SB_URL || !SB_KEY) return bad(res, 500, 'Server misconfigured.');

  /* ⛔ A REQUEST FROM ANOTHER SITE IS REFUSED. The session cookie is SameSite=Lax, which already
     keeps it off a cross-site POST; these two checks do not depend on that. A JSON content type
     cannot be sent cross-site without a preflight this route never answers, and a browser always
     names the page's origin on a POST. */
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    return bad(res, 415, 'Send JSON.');
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    if (!originHost || originHost !== String(req.headers.host || '')) return bad(res, 403, 'Cross-site request refused.');
  }
  // a browser that says where the request came from is believed when it says "not this site"
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') return bad(res, 403, 'Cross-site request refused.');

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { return bad(res, 400, 'Bad JSON.'); } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(res, 400, 'Bad request.');
  const action = body.action;
  const wssn = body.wssn;
  if (!isWssn(wssn)) return bad(res, 400, 'A supply number is required.');

  try {
    const supply = await loadSupply(wssn);
    if (!supply) return bad(res, 404, 'There is no water supply with that number.');
    const user = await officeUserOf(req, sb);
    const kind = authorityOf(user, supply.wssn);

    /* ---- who is this browser, for this town? (open) -----------------------------------------
       The page asks this first. It answers the same for "not signed in" and "signed in but not
       this town's admin" except for the two flags — it never says why somebody is not an admin. */
    if (action === 'whoami') {
      const slug = await tenantSlugOf(supply.wssn);
      return res.status(200).json({
        ok: true, ver: VER, town: supply.name || null, hub: slug ? `/${slug}` : null,
        signedIn: Boolean(user), townAdmin: Boolean(kind), productAdmin: kind === 'product_admin',
        user: user ? { name: user.name || null, email: user.email } : null,
      });
    }

    // ---- everything below needs a town admin of THIS town, or CivicScope ---------------------
    if (!user) return bad(res, 401, 'Sign in to manage this town\'s settings.', { needsSignIn: true });
    if (!kind) return bad(res, 403, 'You are signed in, but you are not a town admin for this town.', { notAdmin: true });
    const ctx = { supply, user, kind };

    switch (action) {
      case 'state': return res.status(200).json(await readState(ctx));
      case 'save_settings': return res.status(200).json(await saveSettings(ctx, body));
      case 'add_operator': return res.status(200).json(await addOperator(ctx, body));
      case 'set_operator': return res.status(200).json(await setOperator(ctx, body));
      case 'add_person': return res.status(200).json(await addPerson(ctx, body));
      case 'set_person': return res.status(200).json(await setPerson(ctx, body));
      default: return bad(res, 400, 'Unknown action.');
    }
  } catch (e) {
    if (e instanceof Refuse) return bad(res, e.status, e.message, e.extra);
    /* A database error is never shown to a town admin as it came: it can quote a row. */
    console.error('water-town error:', redact(e));
    return bad(res, 500, 'Something went wrong on the server. Reload the page and check what was saved before trying again.');
  }
}

// ---------------------------------------------------------------------------------------------
// state — everything the page draws
// ---------------------------------------------------------------------------------------------
async function readState(ctx) {
  const { supply, user, kind } = ctx;
  const [ops, people, log] = await Promise.all([
    sb(`water_operators?supply_id=eq.${supply.id}&select=${OPERATOR_COLS}&order=name`),
    sb(`app_users?water_wssn=eq.${enc(supply.wssn)}&select=${PERSON_COLS}&order=role,email`),
    sb(`water_admin_log?supply_id=eq.${supply.id}&select=at,actor_name,actor_email,actor_kind,summary&order=at.desc&limit=30`),
  ]);
  const settings = {};
  for (const k of SETTING_KEYS) settings[k] = k === 'require_pin' ? supply.require_pin === true : (supply[k] ?? null);
  return {
    ok: true, ver: VER,
    town: { wssn: supply.wssn, name: supply.name, county: supply.county || null, classification: supply.classification || null },
    me: { name: user.name || null, email: user.email, productAdmin: kind === 'product_admin' },
    settings,
    operators: (ops || []).map(publicOperator),
    people: (people || []).map((p) => publicPerson(p, ctx)),
    /* WHO is the sign-in address, with the name beside it — never the name alone. A display name is
       whatever somebody's Google account says, so on its own it could read "CivicScope"; the address
       and the server's own word for the kind of account cannot be chosen by the person. */
    log: (log || []).map((l) => ({
      at: l.at,
      who: `${l.actor_name ? `${l.actor_name} (${l.actor_email || 'no address'})` : (l.actor_email || 'someone')}`
        + `${l.actor_kind === 'product_admin' ? ' — CivicScope' : ''}`,
      summary: l.summary,
    })),
  };
}

/* What the page may know about one office person, and which buttons it may draw. The same two
   rules are enforced again in setPerson(); these flags only save a click that would be refused. */
function publicPerson(p, { user, kind }) {
  const isMe = p.id === user.id;
  const civicscope = p.role === 'admin';
  return {
    id: p.id, email: p.email, name: p.name || null, role: p.role, active: p.active === true,
    town_admin: p.town_admin === true, last_seen_at: p.last_seen_at || null, is_me: isMe,
    can_edit: !isMe && !civicscope && (p.town_admin !== true || kind === 'product_admin'),
    can_set_admin: !isMe && !civicscope && kind === 'product_admin',
  };
}

// ---------------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------------
async function operatorsWithoutPin(supplyId) {
  const rows = await sb(`water_operators?supply_id=eq.${supplyId}&active=is.true&select=name,initials,pin_hash,pin&order=name`);
  return (rows || []).filter((o) => !o.pin_hash && !o.pin);
}

async function saveSettings(ctx, body) {
  const { supply } = ctx;
  const changes = body.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) refuse(400, 'Nothing to save.');
  const keys = Object.keys(changes);
  if (!keys.length) refuse(400, 'Nothing to save.');
  /* Refused, never silently dropped: a form that posts a field it may not set and gets "saved"
     back has been told its change landed. */
  const notAllowed = keys.filter((k) => !has(SETTINGS, k));
  if (notAllowed.length) refuse(400, `These cannot be changed here: ${notAllowed.join(', ')}. They are set by CivicScope.`);

  const patch = {}; const diff = {};
  for (const k of keys) {
    const next = SETTINGS[k].clean(changes[k]);
    const cur = k === 'require_pin' ? supply.require_pin === true : (supply[k] ?? null);
    if (next !== cur) { patch[k] = next; diff[k] = { from: cur, to: next }; }
  }
  const changed = Object.keys(patch);
  if (!changed.length) return { ok: true, changed: [], logged: true };

  /* ⛔ PIN AT THE WELL CANNOT BE SWITCHED ON OVER A CREW THAT HAS NO PINS (the owner's admin page
     has the same refusal). An active operator with no PIN would be turned away by the tablet the
     moment the setting took effect. */
  if (patch.require_pin === true) {
    const missing = await operatorsWithoutPin(supply.id);
    if (missing.length) {
      refuse(400, 'PIN at the well cannot be turned on yet. These operators have no PIN: '
        + `${missing.map((o) => `${o.name} (${o.initials})`).join(', ')}. Set a PIN for each of them, or retire them, first.`);
    }
  }

  const rows = await sb(`water_supplies?id=eq.${supply.id}&select=id`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('settings write matched no row');

  const parts = changed.map((k) => (k === 'require_pin'
    ? `Turned PIN at the well ${patch[k] ? 'on' : 'off'}`
    : `Changed ${SETTINGS[k].label} from ${quote(diff[k].from)} to ${quote(diff[k].to)}`));
  const logged = await writeLog(ctx, 'save_settings', parts.join('; '),
    { targetKind: 'supply', targetId: supply.id, detail: { changes: diff } });
  return { ok: true, changed, logged };
}

// ---------------------------------------------------------------------------------------------
// operators
// ---------------------------------------------------------------------------------------------
const pinPatchSet = (pin) => ({ pin_hash: hashPin(String(pin)), pin: null, pin_failed_count: 0, pin_locked_until: null });
const PIN_PATCH_CLEAR = { pin_hash: null, pin: null, pin_failed_count: 0, pin_locked_until: null };

function pinFrom(body) {
  // undefined = not being changed · null or '' = clear · otherwise it must be 4 to 8 digits
  if (!has(body, 'pin') || body.pin === undefined) return undefined;
  if (body.pin === null || body.pin === '') return null;
  const p = typeof body.pin === 'number' ? String(body.pin) : body.pin;
  if (typeof p !== 'string' || !isPinFormat(p.trim())) refuse(400, 'A PIN is 4 to 8 digits.');
  return p.trim();
}

async function addOperator(ctx, body) {
  const { supply } = ctx;
  const name = textRequired(body.name, 'Name', 80);
  const initials = String(typeof body.initials === 'string' ? body.initials : '').trim().toUpperCase();
  if (!/^[A-Z]{1,4}$/.test(initials)) refuse(400, 'Initials are 1 to 4 letters.');
  const pin = pinFrom(body);
  if (supply.require_pin === true && !pin) {
    refuse(400, 'This town requires a PIN at the well, so a new operator needs one (4 to 8 digits).');
  }
  /* Initials are how a reading says who took it. Two people on one town's list with the same
     initials would make every later reading ambiguous — retired or not. */
  const same = await sb(`water_operators?supply_id=eq.${supply.id}&initials=eq.${enc(initials)}&select=name,active&limit=1`);
  if (same && same[0]) {
    refuse(400, same[0].active === false
      ? `The initials ${initials} belong to ${same[0].name}, who is retired. Bring them back, or use different initials.`
      : `The initials ${initials} are already used by ${same[0].name}.`);
  }
  const ins = await sb('water_operators?select=id', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ supply_id: supply.id, name, initials, is_oic: false, active: true, ...(pin ? { pin_hash: hashPin(pin) } : {}) }]),
  });
  if (!Array.isArray(ins) || !ins[0]) throw new Error('operator insert returned no row');
  const logged = await writeLog(ctx, 'add_operator', `Added operator ${nm(name)} (${initials})${pin ? ', with a PIN' : ''}`,
    { targetKind: 'operator', targetId: ins[0].id, detail: { name, initials, pin_set: Boolean(pin) } });
  return { ok: true, logged };
}

async function setOperator(ctx, body) {
  const { supply } = ctx;
  if (!isUuid(body.operator_id)) refuse(400, 'Choose an operator.');
  /* The operator must belong to THIS town. The supply filter is in the read and again in the write. */
  const cur = (await sb(`water_operators?id=eq.${body.operator_id}&supply_id=eq.${supply.id}&select=${OPERATOR_COLS}&limit=1`) || [])[0];
  if (!cur) refuse(404, 'That operator is not on this town\'s list.');

  const pin = pinFrom(body);
  const setsActive = has(body, 'active') && body.active !== undefined;
  if (setsActive && typeof body.active !== 'boolean') refuse(400, 'Active must be on or off.');
  if (pin === undefined && !setsActive) refuse(400, 'Nothing to change.');

  const willBeActive = setsActive ? body.active : cur.active !== false;
  const willHavePin = pin === undefined ? Boolean(cur.pin_hash || cur.pin) : pin !== null;
  /* ⛔ NOBODY ENDS UP ON THE TABLET LIST WITHOUT A PIN IN A TOWN THAT REQUIRES ONE — whether by
     clearing a PIN or by bringing somebody back. Same refusal as the owner's admin page. */
  if (supply.require_pin === true && willBeActive && !willHavePin) {
    refuse(400, pin === null
      ? 'This town requires a PIN at the well, so an operator on the tablet list cannot have theirs cleared. Set a new PIN instead, or retire them first.'
      : 'This town requires a PIN at the well. Set a PIN for this operator before bringing them back.');
  }

  const patch = {};
  if (setsActive && body.active !== (cur.active !== false)) patch.active = body.active;
  if (pin === null) Object.assign(patch, PIN_PATCH_CLEAR);
  else if (pin !== undefined) Object.assign(patch, pinPatchSet(pin));
  if (!Object.keys(patch).length) return { ok: true, logged: true };

  const rows = await sb(`water_operators?id=eq.${cur.id}&supply_id=eq.${supply.id}&select=id`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  if (!Array.isArray(rows) || rows.length !== 1) refuse(404, 'That operator is not on this town\'s list.');

  const who = `${nm(cur.name)} (${cur.initials})`;
  const parts = [];
  if (has(patch, 'active')) parts.push(patch.active ? `Brought ${who} back onto the tablet list` : `Retired ${who}`);
  if (pin === null) parts.push(`Cleared the PIN for ${who}`);
  else if (pin !== undefined) parts.push(`Set a new PIN for ${who}`);
  const logged = await writeLog(ctx, 'set_operator', parts.join('; '), {
    targetKind: 'operator', targetId: cur.id,
    detail: { ...(has(patch, 'active') ? { active: patch.active } : {}), ...(pin !== undefined ? { pin: pin === null ? 'cleared' : 'set' } : {}) },
  });
  return { ok: true, logged };
}

// ---------------------------------------------------------------------------------------------
// office sign-ins
// ---------------------------------------------------------------------------------------------
async function personByEmail(email) {
  const rows = await sb(`app_users?email=ilike.${enc(likeExact(email))}&select=${PERSON_COLS}&limit=20`);
  const hits = (rows || []).filter((r) => normEmail(r.email) === email);
  if (hits.length > 1) refuse(400, 'That address cannot be added here. Ask CivicScope to add it.');
  return hits[0] || null;
}

async function addPerson(ctx, body) {
  const { supply, user } = ctx;
  const name = textRequired(body.name, 'Name', 120);
  const email = normEmail(typeof body.email === 'string' ? body.email : '');
  if (!email || email.length > 200 || !EMAIL_RE.test(email)) refuse(400, 'Enter the person\'s email address.');
  /* ⛔ A TOWN ADMIN CAN NEVER MINT A CIVICSCOPE ADMIN. `role` is one of two words; anything else,
     including 'admin', is refused. `town_admin` is not accepted here at all. */
  if (body.role !== 'staff' && body.role !== 'oic') refuse(400, 'Choose office staff or operator in charge.');
  const role = body.role;
  const slug = await tenantSlugOf(supply.wssn);

  const existing = await personByEmail(email);
  let personId = null;
  if (!existing) {
    const ins = await sb('app_users?select=id', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ email, name, role, muni_tenant: slug, water_wssn: supply.wssn, active: true, invited_by: user.email || null }]),
    });
    if (!Array.isArray(ins) || !ins[0]) throw new Error('person insert returned no row');
    personId = ins[0].id;
  } else {
    /* The address is already on file somewhere. It may be adopted ONLY when it belongs to nobody
       else's town: a person who tried to sign in and is waiting (no town at all), or somebody
       already on THIS town's list who was turned off. A CivicScope account, a town admin, or a
       person enrolled for another town is refused with one sentence that says nothing about why —
       the answer must not tell one town who is enrolled in another. */
    const elsewhere = (existing.water_wssn && existing.water_wssn !== supply.wssn)
      || (existing.muni_tenant && existing.muni_tenant !== slug);
    if (existing.role === 'admin' || existing.town_admin === true || elsewhere) {
      refuse(400, 'That address cannot be added here. Ask CivicScope to add it.');
    }
    if (existing.water_wssn === supply.wssn && existing.active === true) {
      refuse(400, 'That address is already on this town\'s list.');
    }
    /* ⛔ THE WRITE REPEATS EVERYTHING THE READ RELIED ON (independent review, 2026-11-18). The filter
       names the exact town, hub and on/off state this row was seen in, so a row that was enrolled
       for another town — or adopted by another town's admin — between the read above and this write
       matches nothing and is refused. Checking only role and the admin mark here would have let the
       last writer win and moved somebody out of the town that had just enrolled them. */
    const seen = (col, v) => (v === null || v === undefined ? `${col}=is.null` : `${col}=eq.${enc(v)}`);
    const rows = await sb(`app_users?id=eq.${existing.id}&role=neq.admin&town_admin=is.false`
      + `&${seen('water_wssn', existing.water_wssn)}&${seen('muni_tenant', existing.muni_tenant)}`
      + `&active=is.${existing.active === true}&select=id`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ name, role, muni_tenant: slug, water_wssn: supply.wssn, active: true, invited_by: user.email || null }),
    });
    if (!Array.isArray(rows) || rows.length !== 1) refuse(400, 'That address cannot be added here. Ask CivicScope to add it.');
    personId = existing.id;
  }
  const logged = await writeLog(ctx, 'add_person', `Added ${nm(name)} (${email}) as ${ROLE_WORDS[role]}`,
    { targetKind: 'person', targetId: personId, detail: { email, role } });
  return { ok: true, logged };
}

async function setPerson(ctx, body) {
  const { supply, user, kind } = ctx;
  if (!isUuid(body.person_id)) refuse(400, 'Choose a person.');
  const setsActive = has(body, 'active') && body.active !== undefined;
  const setsAdmin = has(body, 'town_admin') && body.town_admin !== undefined;
  if (!setsActive && !setsAdmin) refuse(400, 'Nothing to change.');
  if (setsActive && typeof body.active !== 'boolean') refuse(400, 'Sign-in must be on or off.');
  if (setsAdmin && typeof body.town_admin !== 'boolean') refuse(400, 'Town admin must be yes or no.');

  /* The person must be on THIS town's list. Somebody enrolled for another town does not exist here. */
  const cur = (await sb(`app_users?id=eq.${body.person_id}&water_wssn=eq.${enc(supply.wssn)}&select=${PERSON_COLS}&limit=1`) || [])[0];
  if (!cur) refuse(404, 'That person is not on this town\'s list.');
  if (cur.role === 'admin') refuse(403, 'CivicScope accounts are managed by CivicScope.');
  if (cur.id === user.id) refuse(400, 'You cannot change your own sign-in here.');
  /* ⛔ ONLY CIVICSCOPE DECIDES WHO IS A TOWN ADMIN, AND ONLY CIVICSCOPE TURNS ONE OFF. A town admin
     who could grant the mark could hand the town to anybody; one who could turn another off could
     lock the town's other admin out. */
  if (setsAdmin && kind !== 'product_admin') refuse(403, 'Only CivicScope can change who is a town admin.');
  if (setsActive && cur.town_admin === true && kind !== 'product_admin') refuse(403, 'Only CivicScope can change a town admin\'s sign-in.');

  const patch = {};
  if (setsActive && body.active !== (cur.active === true)) patch.active = body.active;
  if (setsAdmin && body.town_admin !== (cur.town_admin === true)) patch.town_admin = body.town_admin;
  if (!Object.keys(patch).length) return { ok: true, logged: true };

  /* The write repeats the rules above: this town, never a CivicScope account, and — for a town
     admin — never a row that carries the town-admin mark, even one granted since the read. */
  const rows = await sb(`app_users?id=eq.${cur.id}&water_wssn=eq.${enc(supply.wssn)}&role=neq.admin`
    + `${kind === 'product_admin' ? '' : '&town_admin=is.false'}&select=id`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  if (!Array.isArray(rows) || rows.length !== 1) refuse(404, 'That person is not on this town\'s list, or has just been changed. Reload the page.');

  const who = `${nm(cur.name || cur.email)} (${cur.email})`;
  const parts = [];
  if (has(patch, 'active')) parts.push(patch.active ? `Turned sign-in back on for ${who}` : `Turned sign-in off for ${who}`);
  if (has(patch, 'town_admin')) parts.push(patch.town_admin ? `Made ${who} a town admin` : `Removed ${who} as a town admin`);
  const logged = await writeLog(ctx, 'set_person', parts.join('; '),
    { targetKind: 'person', targetId: cur.id, detail: { ...patch } });
  return { ok: true, logged };
}

// Exported for the local check (scripts/verify-water-town.mjs), which drives the real rules.
export { authorityOf, SETTING_KEYS, VER };
