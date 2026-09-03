/**
 * server.js
 * ─────────────────────────────────────────────────────────────────────────
 * Pidde — Express-limmet. Serverar login + chatt-appen, och ett litet API:
 * inloggning, samtalstradar, langtidsminne, kunskapsbas, och sjalva chatten
 * som en streamad SSE-respons (texten tickar in tecken for tecken).
 *
 * Ett konto (VD). Allt bakom servern; inga nycklar i klienten.
 * ─────────────────────────────────────────────────────────────────────────
 */
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initAuth, findUser, verifyPassword, pubUser, changePassword,
  signSession, sessionCookie, clearCookie, currentUser,
  tooMany, recordFail, clearFails,
} from './auth.js';
import {
  nowISO, listThreads, getThread, createThread, appendThreadMessages, renameThread, deleteThread,
  getMemory, setProfile, addFact, deleteFact,
} from './store.js';
import { listDocs, addDoc, deleteDoc, extractText } from './knowledge.js';
import { runChat, providersStatus } from './llm.js';
import { consoleHealth, hasConsole } from './console.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 4180;

initAuth();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Stor JSON bara pa kunskaps-uppladdning (base64-kodad fil); liten overallt annars.
const bigJson = express.json({ limit: '30mb' });
const smallJson = express.json({ limit: '2mb' });
app.use((req, res, next) => (req.path === '/api/knowledge/upload' ? bigJson : smallJson)(req, res, next));

const str = (v) => (v == null ? '' : String(v));
// req.ip respekterar 'trust proxy' (klientens riktiga IP bakom Railways proxy).
// Utan detta bucketas brute-force-spärren pa proxyns adress = en konstant, och
// en angripare kan lasa ut VD-kontot for alla.
const ipOf = (req) => req.ip || req.socket.remoteAddress || 'ip';

function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Inloggning kravs.' });
  req.user = u;
  next();
}

function titleFrom(text) {
  const first = str(text).split('\n')[0].trim();
  if (first.length <= 52) return first;
  return first.slice(0, 52).replace(/\s+\S*$/, '') + '...';
}

/* ── auth ────────────────────────────────────────────────────────────────── */
app.post('/api/login', async (req, res) => {
  const ip = ipOf(req);
  if (tooMany(ip)) return res.status(429).json({ error: 'For manga forsok. Forsok igen om en stund.' });
  const b = req.body || {};
  const u = findUser(b.username);
  if (!(await verifyPassword(u, b.password))) { recordFail(ip); return res.status(401).json({ error: 'Fel anvandarnamn eller losenord.' }); }
  clearFails(ip);
  res.setHeader('Set-Cookie', sessionCookie(signSession(u), req));
  res.json({ user: pubUser(u) });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', clearCookie()); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { const u = currentUser(req); return u ? res.json({ user: pubUser(u) }) : res.status(401).json({ error: 'unauth' }); });

app.get('/api/config', requireAuth, (req, res) => {
  res.json({ user: pubUser(req.user), providers: providersStatus(process.env), consoleConfigured: hasConsole(process.env) });
});
app.get('/api/console/health', requireAuth, async (req, res) => { res.json(await consoleHealth(process.env)); });

app.post('/api/password', requireAuth, async (req, res) => {
  const b = req.body || {};
  const r = await changePassword(req.user, str(b.current), str(b.next));
  return r.error ? res.status(400).json(r) : res.json({ ok: true });
});

/* ── tradar ──────────────────────────────────────────────────────────────── */
app.get('/api/threads', requireAuth, (req, res) => res.json({ threads: listThreads() }));
app.post('/api/threads', requireAuth, (req, res) => res.status(201).json({ thread: createThread(str((req.body || {}).title)) }));
app.get('/api/threads/:id', requireAuth, (req, res) => {
  const t = getThread(req.params.id);
  return t ? res.json({ thread: t }) : res.status(404).json({ error: 'Samtalet finns inte.' });
});
app.patch('/api/threads/:id', requireAuth, (req, res) => {
  const t = renameThread(req.params.id, str((req.body || {}).title));
  return t ? res.json({ thread: { id: t.id, title: t.title } }) : res.status(404).json({ error: 'Samtalet finns inte.' });
});
app.delete('/api/threads/:id', requireAuth, (req, res) => {
  return deleteThread(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Samtalet finns inte.' });
});

/* ── minne ───────────────────────────────────────────────────────────────── */
app.get('/api/memory', requireAuth, (req, res) => res.json(getMemory()));
app.put('/api/memory/profile', requireAuth, (req, res) => res.json(setProfile(str((req.body || {}).profile))));
app.post('/api/memory/facts', requireAuth, (req, res) => {
  const t = str((req.body || {}).text).trim();
  if (!t) return res.status(400).json({ error: 'Tom fakta.' });
  res.json(addFact(t));
});
app.delete('/api/memory/facts/:id', requireAuth, (req, res) => res.json(deleteFact(req.params.id)));

/* ── kunskapsbas ─────────────────────────────────────────────────────────── */
app.get('/api/knowledge', requireAuth, (req, res) => res.json({ docs: listDocs() }));
app.post('/api/knowledge', requireAuth, (req, res) => {
  const b = req.body || {};
  const r = addDoc({ title: str(b.title), text: str(b.text), source: str(b.source) });
  return r.error ? res.status(400).json(r) : res.status(201).json({ ok: true, doc: r.doc });
});
app.post('/api/knowledge/upload', requireAuth, async (req, res) => {
  const b = req.body || {};
  const filename = str(b.filename);
  if (!filename || !b.dataBase64) return res.status(400).json({ error: 'filename och dataBase64 kravs.' });
  let buf;
  try { buf = Buffer.from(str(b.dataBase64), 'base64'); } catch { return res.status(400).json({ error: 'Ogiltig fildata.' }); }
  if (!buf.length) return res.status(400).json({ error: 'Tom fil.' });
  const { text, error } = await extractText(buf, filename);
  if (error) return res.status(400).json({ error });
  const r = addDoc({ title: str(b.title) || filename, text, source: filename });
  return r.error ? res.status(400).json(r) : res.status(201).json({ ok: true, doc: r.doc });
});
app.delete('/api/knowledge/:id', requireAuth, (req, res) => {
  return deleteDoc(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Dokumentet finns inte.' });
});

/* ── chatt (SSE-streamad) ────────────────────────────────────────────────── */
app.post('/api/chat', requireAuth, async (req, res) => {
  const me = req.user;
  const b = req.body || {};
  const text = str(b.message).trim();
  if (!text) return res.status(400).json({ error: 'Tomt meddelande.' });

  const existing = b.threadId ? getThread(str(b.threadId)) : null;
  const createdNow = !existing; // for att kunna stada bort en tom trad om svaret misslyckas
  const thread = existing || createThread('');
  const isFirst = (thread.messages || []).length === 0;
  const history = [...(thread.messages || []).map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: text }];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Klientfrankoppling signaleras av RESPONSENS 'close' (inte requestens — den
  // fyras sa fort bodyn ar forbrukad och skulle kvava svaret innan det borjat).
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = (ev) => { if (!closed) { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* stangd */ } } };

  send({ type: 'thread', id: thread.id, title: thread.title });
  try {
    const { answer, model, tools } = await runChat({ history, provider: str(b.provider), model: str(b.model), sink: send, env: process.env, userName: me.name || 'VD' });
    // Append bara det nya utbytet (las-modifiera-skriv mot aktuell disk), sa parallella
    // sandningar mot samma trad inte skriver over varandra.
    appendThreadMessages(thread.id, [
      { role: 'user', content: text, ts: nowISO() },
      { role: 'assistant', content: answer, ts: nowISO(), model, tools },
    ], isFirst ? titleFrom(text) : undefined);
    const saved = getThread(thread.id);
    send({ type: 'done', model, tools, title: saved ? saved.title : thread.title, threadId: thread.id });
  } catch (e) {
    // Misslyckades svaret pa en nyss skapad trad: ta bort den tomma spoktraden.
    if (createdNow) { try { deleteThread(thread.id); } catch { /* ignore */ } }
    send({ type: 'error', message: (e && e.message) || String(e) });
  }
  if (!closed) res.end();
});

/* ── statiskt (login + appen) ────────────────────────────────────────────── */
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'";
function htmlHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cache-Control', 'no-cache');
}
app.get('/', (req, res) => { htmlHeaders(res); res.sendFile(path.join(PUBLIC, 'index.html')); });
app.get('/login', (req, res) => { htmlHeaders(res); res.sendFile(path.join(PUBLIC, 'login.html')); });
app.use(express.static(PUBLIC, { index: false, setHeaders: (res, f) => { if (f.endsWith('.html')) htmlHeaders(res); } }));

app.use((req, res) => res.status(404).json({ error: 'Okand endpoint.' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Filen ar for stor.' });
  // Klientfel (t.ex. trasig JSON-body) ar 4xx, inte serverfel.
  const code = err && (err.status || err.statusCode);
  if (code && code >= 400 && code < 500) {
    if (res.headersSent) return next(err);
    return res.status(code).json({ error: err.type === 'entity.parse.failed' ? 'Ogiltig JSON i begaran.' : 'Ogiltig begaran.' });
  }
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Serverfel.' });
});

app.listen(PORT, '0.0.0.0', () => {
  const p = providersStatus(process.env);
  console.log(`Pidde lyssnar pa 0.0.0.0:${PORT}`);
  console.log(`  motor: ${p.anthropic ? 'Claude ' + p.models.claude : (p.openai ? 'OpenAI ' + p.models.openai : 'INGEN — satt ANTHROPIC_API_KEY')}`);
  console.log(`  webbsok: ${p.web ? 'pa' : 'av'} | konsoldata: ${p.console ? 'kopplad' : 'ej kopplad'}`);
});
