/**
 * auth.js
 * ─────────────────────────────────────────────────────────────────────────
 * Inloggning for det enda kontot (VD). Samma beprovade monster som
 * kunskapsbas-apparna: signerad httpOnly-cookie, async scrypt (haller
 * event-loopen fri, ingen sync-DoS), timing-jamn verifiering, och en
 * brute-force-spärr per IP. Kontot seedas fran PIDDE_USER/PIDDE_PASSWORD och
 * losenordet kan bytas inifran appen.
 *
 * Ingen nyckel eller hemlighet i klienten. Cookien bar bara ett signerat
 * anvandar-id och en utgangstid.
 * ─────────────────────────────────────────────────────────────────────────
 */
import crypto from 'node:crypto';
import { filePath, readJSON, writeJSONAtomic, rid } from './store.js';

const USERS_FILE = filePath('users.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const SESSION_TTL = 1000 * 60 * 60 * 12; // 12 timmar
const ADMIN_USER = process.env.PIDDE_USER || 'vd@senzum.com';
const ADMIN_PASSWORD = process.env.PIDDE_PASSWORD || 'byt-mig';

const str = (v) => (v == null ? '' : String(v));

/* ── scrypt (async) ──────────────────────────────────────────────────────── */
const scryptAsync = (password, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(str(password), salt, 64, (err, dk) => (err ? reject(err) : resolve(dk))));
const DUMMY_SALT = crypto.randomBytes(16).toString('hex'); // jamnar timing nar anvandaren saknas

function makeUser(username, password, name, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex'); // bara vid boot-seedning
  // tokenVersion bakas in i varje session-token; ett losenordsbyte hojer den och
  // ogiltigforklarar darmed alla tidigare utfardade cookies (aven ev. stulna).
  return { id: rid('u_'), username, name: name || username, role: role || 'vd', salt, hash, tokenVersion: 0 };
}

export async function verifyPassword(user, password) {
  try {
    const dk = await scryptAsync(password, user ? user.salt : DUMMY_SALT);
    if (!user) return false;
    const a = Buffer.from(dk.toString('hex'), 'hex');
    const b = Buffer.from(user.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

/* ── anvandar-store ──────────────────────────────────────────────────────── */
let users = [];
export function initAuth() {
  users = readJSON(USERS_FILE, null) || [];
  const exists = users.find((u) => u.username.toLowerCase() === ADMIN_USER.toLowerCase());
  if (!exists) {
    // Fresh store, eller PIDDE_USER andrades: droppa ett foraldrat auto-seedat konto
    // och seeda det konfigurerade, sa env faktiskt tar effekt.
    if (ADMIN_USER.toLowerCase() !== 'vd@senzum.com') {
      users = users.filter((u) => u.username.toLowerCase() !== 'vd@senzum.com');
    }
    users.push(makeUser(ADMIN_USER, ADMIN_PASSWORD, 'VD', 'vd'));
    writeJSONAtomic(USERS_FILE, users);
    console.log('[auth] seedade inloggning "' + ADMIN_USER + '"');
  }
  if (process.env.NODE_ENV === 'production' &&
      (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-insecure-secret-change-me')) {
    // Fail-closed: en default/saknad hemlighet i produktion later vem som helst
    // forfalska en giltig VD-cookie (nyckeln ar publik). Vagra starta.
    throw new Error('[auth] SESSION_SECRET saknas eller ar default i produktion. Satt en lang slumpmassig SESSION_SECRET innan start.');
  }
}
function saveUsers() { writeJSONAtomic(USERS_FILE, users); }
export function findUser(username) {
  return users.find((u) => u.username.toLowerCase() === str(username).toLowerCase().trim()) || null;
}
export const pubUser = (u) => (u ? { id: u.id, username: u.username, name: u.name, role: u.role } : null);

export async function changePassword(user, current, next) {
  if (!(await verifyPassword(user, current))) return { error: 'Nuvarande losenord stammer inte.' };
  if (str(next).length < 8) return { error: 'Nytt losenord maste vara minst 8 tecken.' };
  const salt = crypto.randomBytes(16).toString('hex');
  user.salt = salt;
  user.hash = (await scryptAsync(str(next), salt)).toString('hex');
  user.tokenVersion = (user.tokenVersion || 0) + 1; // ogiltigforklarar alla tidigare sessioner
  saveUsers();
  return { ok: true };
}

/* ── sessioner (signerad cookie) ─────────────────────────────────────────── */
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();

export function signSession(user) {
  const payload = b64url(JSON.stringify({ u: user.id, v: user.tokenVersion || 0, e: Date.now() + SESSION_TTL }));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  return payload + '.' + sig;
}
function verifySession(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  const expect = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data; try { data = JSON.parse(b64urlDecode(payload)); } catch { return null; }
  if (!data || typeof data.e !== 'number' || data.e < Date.now()) return null;
  const u = users.find((x) => x.id === data.u);
  if (!u) return null;
  // Token-versionen maste matcha; ett losenordsbyte hojer den och slar ut gamla cookies.
  if ((data.v || 0) !== (u.tokenVersion || 0)) return null;
  return u;
}

function parseCookies(req) {
  const out = {}; const h = req.headers.cookie || '';
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch { /* skip */ } }
  });
  return out;
}
export function sessionCookie(token, req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.FORCE_SECURE === '1' || process.env.NODE_ENV === 'production';
  return `pidde_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${secure ? '; Secure' : ''}`;
}
export const clearCookie = () => 'pidde_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
export const currentUser = (req) => verifySession(parseCookies(req).pidde_session);

/* ── brute-force-spärr (in-memory, per IP) ───────────────────────────────── */
const fails = {};
export const tooMany = (ip) => { const f = fails[ip]; return !!(f && f.count >= 8 && Date.now() - f.at < 15 * 60 * 1000); };
export const recordFail = (ip) => { const f = fails[ip] || (fails[ip] = { count: 0, at: 0 }); f.count++; f.at = Date.now(); };
export const clearFails = (ip) => { delete fails[ip]; };
