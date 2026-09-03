/**
 * knowledge.js
 * ─────────────────────────────────────────────────────────────────────────
 * Piddes kunskapsbas: dokument VD/du laddar upp (org, personalhandbok, avtal,
 * strategi) eller klistrar in. Lagras som text pa DATA_DIR. Nar Pidde behover
 * nagot ur dem soker den via verktyget search_knowledge.
 *
 * Extrahering speglar konsolen exakt: .txt/.md ras, .docx via mammoth, .pdf via
 * pdf-parse 2.x (klass, getText). Soket ar en enkel men vettig relevanssok over
 * stycken — noll externa beroenden, funkar offline, racker for en matten
 * kunskapsbas. (Embeddings kan komma senare om basen vaxer.)
 * ─────────────────────────────────────────────────────────────────────────
 */
import path from 'node:path';
import { filePath, readJSON, writeJSONAtomic, rid, nowISO } from './store.js';

const KB_FILE = filePath('knowledge.json');
const MAX_DOC_CHARS = 200_000;
const str = (v) => (v == null ? '' : String(v));

function load() { const raw = readJSON(KB_FILE, null); return raw && Array.isArray(raw.docs) ? raw : { docs: [] }; }
function save(db) { writeJSONAtomic(KB_FILE, db); }

/** Metadata for admin-panelen (utan fulltext). */
export function listDocs() {
  return load().docs
    .map((d) => ({ id: d.id, title: d.title, source: d.source || '', chars: d.chars || (d.text ? d.text.length : 0), addedAt: d.addedAt }))
    .sort((a, b) => str(b.addedAt).localeCompare(str(a.addedAt)));
}
export function getDoc(id) { return load().docs.find((d) => d.id === id) || null; }

export function addDoc({ title, text, source }) {
  const t = str(text).slice(0, MAX_DOC_CHARS).trim();
  if (!t) return { error: 'Dokumentet ar tomt.' };
  const db = load();
  const doc = { id: rid('k_'), title: str(title).trim().slice(0, 200) || 'Namnlost dokument', source: str(source).slice(0, 200), text: t, chars: t.length, addedAt: nowISO() };
  db.docs.push(doc);
  save(db);
  return { doc: { id: doc.id, title: doc.title, source: doc.source, chars: doc.chars, addedAt: doc.addedAt } };
}

export function deleteDoc(id) {
  const db = load();
  const before = db.docs.length;
  db.docs = db.docs.filter((d) => d.id !== id);
  if (db.docs.length === before) return false;
  save(db);
  return true;
}

/** Extrahera text ur en uppladdad fil efter filandelse. Speglar konsolen. */
export async function extractText(buffer, filename) {
  const ext = path.extname(str(filename)).toLowerCase();
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  try {
    if (['.txt', '.md', '.csv', '.json'].includes(ext)) return { text: buf.toString('utf8').trim(), error: null };
    if (ext === '.pdf') {
      const { PDFParse } = await import('pdf-parse');
      const p = new PDFParse({ data: new Uint8Array(buf) });
      let t = '';
      try { t = ((await p.getText()).text || '').trim(); } finally { await p.destroy().catch(() => {}); }
      return t ? { text: t, error: null } : { text: '', error: 'PDF:en innehaller ingen texttolkbar text (troligen en inskannad bild).' };
    }
    if (ext === '.docx') {
      const mammoth = await import('mammoth');
      const out = await (mammoth.default || mammoth).extractRawText({ buffer: buf });
      const t = (out.value || '').trim();
      return t ? { text: t, error: null } : { text: '', error: 'Dokumentet innehaller ingen text.' };
    }
    return { text: '', error: `Filtypen ${ext || '(okand)'} stods inte. Anvand .txt, .md, .docx eller .pdf, eller klistra in texten.` };
  } catch (e) {
    return { text: '', error: 'Kunde inte lasa filen: ' + ((e && e.message) || String(e)) };
  }
}

/* ── sok ─────────────────────────────────────────────────────────────────── */
const STOP = new Set(['och', 'att', 'det', 'som', 'en', 'ett', 'pa', 'for', 'med', 'av', 'i', 'ar', 'the', 'a', 'of', 'to', 'and', 'om', 'den', 'de', 'vi', 'du']);
const norm = (s) => str(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
const terms = (q) => [...new Set(norm(q).split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)))];

const CHUNK = 700; // haller varje bit inom visningsfonstret (slice 900), sa en traff aldrig trunkeras bort
function chunks(text) {
  // Dela i stycken; sla ihop sma, och HARD-splitta stora stycken (t.ex. en
  // .csv/.json/PDF utan tomrader) sa ingen bit blir langre an den vi visar.
  const parts = str(text).split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  for (const p of parts) {
    if (p.length > CHUNK) {
      flush();
      let i = 0;
      while (i < p.length) {
        let end = Math.min(i + CHUNK, p.length);
        if (end < p.length) { const sp = p.lastIndexOf(' ', end); if (sp > i + 200) end = sp; }
        out.push(p.slice(i, end).trim());
        i = end;
      }
      continue;
    }
    if (buf && buf.length + p.length + 2 > CHUNK) flush();
    buf = buf ? buf + '\n\n' + p : p;
  }
  flush();
  return out.length ? out : [str(text).trim()].filter(Boolean);
}

/**
 * Verktygsfunktionen. Returnerar text: de mest relevanta styckena med kalltitel,
 * eller en tydlig "inget hittades". Aldrig ett kast.
 */
export function searchKnowledge(query, k = 5) {
  const qs = terms(query);
  if (!qs.length) return 'Ingen sokterm angavs.';
  const docs = load().docs;
  if (!docs.length) return 'Kunskapsbasen ar tom — inga dokument ar uppladdade an.';
  const hits = [];
  for (const d of docs) {
    const titleN = norm(d.title);
    for (const c of chunks(d.text)) {
      const cn = norm(c);
      let score = 0;
      for (const t of qs) {
        const inChunk = cn.split(t).length - 1;
        const inTitle = titleN.includes(t) ? 2 : 0;
        score += inChunk + inTitle;
      }
      if (score > 0) hits.push({ score, title: d.title, chunk: c });
    }
  }
  if (!hits.length) return `Inget i kunskapsbasen matchar "${str(query).slice(0, 80)}".`;
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k)
    .map((h) => `[${h.title}]\n${h.chunk.slice(0, 900)}`)
    .join('\n\n---\n\n');
}

export const SEARCH_KNOWLEDGE_TOOL = {
  name: 'search_knowledge',
  description: 'Soker i Piddes kunskapsbas — dokument VD har laddat upp (org, personalhandbok, avtal, strategi, rutiner m.m.). Anvand nar fragan kan besvaras ur foretagets egna dokument snarare an live-siffror. Ger tillbaka de mest relevanta styckena med kalltitel.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Sokfras pa svenska, t.ex. "regler for foraldraledighet" eller "uppsagningstid Cellbes".' } },
    required: ['query'],
  },
};
