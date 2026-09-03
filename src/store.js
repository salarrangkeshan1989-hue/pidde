/**
 * store.js
 * ─────────────────────────────────────────────────────────────────────────
 * Atomar JSON-fil-persistens pa DATA_DIR. Ingen databas: Pidde har en anvandare
 * och matta datamangder, sa filer racker och overlever deploys nar DATA_DIR ar
 * en monterad volym. Lagrar samtalstradar och langtidsminnet; auth.js och
 * knowledge.js lanar lagnivahjalparna harifran for sina egna filer.
 *
 * Alla skrivningar ar atomara (skriv .tmp, byt namn) sa en krasch mitt i en
 * skrivning aldrig lamnar en trasig fil.
 * ─────────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const THREADS_FILE = path.join(DATA_DIR, 'threads.json');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');

/* ── lagniva ─────────────────────────────────────────────────────────────── */
export function filePath(name) { return path.join(DATA_DIR, name); }
export function readJSON(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return fallback; } // saknas = normalt (forsta start)
  try { return JSON.parse(raw); }
  catch (e) {
    // Filen FINNS men gar inte att tolka (trunkerad/korrupt). Skriv INTE tyst over
    // den: backa upp den sa datan aldrig forsvinner utan spar, och logga hogt.
    try {
      const bak = file + '.corrupt-' + Date.now();
      fs.renameSync(file, bak);
      console.error(`[store] KORRUPT ${path.basename(file)} — backade upp till ${path.basename(bak)}: ${e.message}`);
    } catch (e2) { console.error(`[store] KORRUPT ${path.basename(file)} kunde inte backas upp: ${e2.message}`); }
    return fallback;
  }
}
export function writeJSONAtomic(file, obj) {
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd); // tvinga ut till disk innan rename — overlever en oren avstangning
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
export const nowISO = () => new Date().toISOString();
export const rid = (p = '') => p + crypto.randomBytes(8).toString('hex');
const asArr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? '' : String(v));

/* ── samtalstradar ───────────────────────────────────────────────────────── */
// threads.json = { threads: [{ id, title, createdAt, updatedAt, messages:[...] }] }
// En message: { role:'user'|'assistant', content, ts, model?, tools?:[] }
const MAX_MESSAGES_PERSISTED = 400; // rimligt tak per trad; halls latt inom minnet

function loadThreads() {
  const raw = readJSON(THREADS_FILE, null);
  return raw && Array.isArray(raw.threads) ? raw : { threads: [] };
}
function saveThreads(db) { writeJSONAtomic(THREADS_FILE, db); }

/** Lista tradar (utan meddelanden) for sidopanelen, nyaste forst. */
export function listThreads() {
  return loadThreads().threads
    .map((t) => ({ id: t.id, title: t.title || 'Nytt samtal', createdAt: t.createdAt, updatedAt: t.updatedAt, count: asArr(t.messages).length }))
    .sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)));
}
export function getThread(id) { return loadThreads().threads.find((t) => t.id === id) || null; }

export function createThread(title) {
  const db = loadThreads();
  const t = { id: rid('t_'), title: str(title).slice(0, 120) || 'Nytt samtal', createdAt: nowISO(), updatedAt: nowISO(), messages: [] };
  db.threads.push(t);
  saveThreads(db);
  return t;
}

/**
 * Lagg TILL nya meddelanden mot den aktuella traden pa disk (las-modifiera-skriv i
 * ETT svep). Append i stallet for replace sa tva overlappande chattar mot samma
 * trad inte skriver over varandra (sista-skrivaren-vinner-forlust).
 */
export function appendThreadMessages(id, newMessages, title) {
  const db = loadThreads();
  const t = db.threads.find((x) => x.id === id);
  if (!t) return null;
  t.messages = asArr(t.messages).concat(asArr(newMessages)).slice(-MAX_MESSAGES_PERSISTED);
  if (title && !t.titleLocked) { t.title = str(title).slice(0, 120); }
  t.updatedAt = nowISO();
  saveThreads(db);
  return t;
}

export function renameThread(id, title) {
  const db = loadThreads();
  const t = db.threads.find((x) => x.id === id);
  if (!t) return null;
  t.title = str(title).slice(0, 120) || t.title;
  t.titleLocked = true; // en manuell titel skrivs inte over av auto-namngivning
  t.updatedAt = nowISO();
  saveThreads(db);
  return t;
}

export function deleteThread(id) {
  const db = loadThreads();
  const before = db.threads.length;
  db.threads = db.threads.filter((t) => t.id !== id);
  if (db.threads.length === before) return false;
  saveThreads(db);
  return true;
}

/* ── langtidsminne ───────────────────────────────────────────────────────── */
// memory.json = { profile: "fritext om VD/foretaget", facts:[{id,text,addedAt}], updatedAt }
// profile redigeras av anvandaren; facts skrivs mest av Pidde sjalv (save_memory).
export function getMemory() {
  const m = readJSON(MEMORY_FILE, null) || {};
  return { profile: str(m.profile), facts: asArr(m.facts), updatedAt: m.updatedAt || null, onboarded: !!m.onboarded };
}
function saveMemory(m) { writeJSONAtomic(MEMORY_FILE, { ...m, updatedAt: nowISO() }); }

/** Har Pidde redan halsat forsta gangen? Satts efter det allra forsta svaret. */
export function isOnboarded() { return getMemory().onboarded; }
export function markOnboarded() { const m = getMemory(); if (!m.onboarded) saveMemory({ ...m, onboarded: true }); }

export function setProfile(text) {
  const m = getMemory();
  m.profile = str(text).slice(0, 8000);
  saveMemory(m);
  return getMemory();
}

/** Lagg till en bestaende fakta. Deduplicerar pa exakt text. */
export function addFact(text) {
  const t = str(text).trim().slice(0, 600);
  if (!t) return getMemory();
  const m = getMemory();
  if (!m.facts.some((f) => f.text.toLowerCase() === t.toLowerCase())) {
    m.facts.unshift({ id: rid('f_'), text: t, addedAt: nowISO() });
    m.facts = m.facts.slice(0, 300);
    saveMemory(m);
  }
  return getMemory();
}

export function deleteFact(id) {
  const m = getMemory();
  const before = m.facts.length;
  m.facts = m.facts.filter((f) => f.id !== id);
  if (m.facts.length !== before) saveMemory(m);
  return getMemory();
}

/** Kompakt minnestext som matas in i systemprompten. Tom strang om inget finns. */
export function memoryDigest() {
  const m = getMemory();
  const parts = [];
  if (m.profile.trim()) parts.push(m.profile.trim());
  if (m.facts.length) parts.push(m.facts.map((f) => '- ' + f.text).join('\n'));
  return parts.join('\n\n').slice(0, 6000);
}
