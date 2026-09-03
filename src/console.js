/**
 * console.js
 * ─────────────────────────────────────────────────────────────────────────
 * Kopplingen till NEXUS-konsolen (senzum-power). Pidde loggar in som en egen
 * anvandare och laser Senzums riktiga siffror via konsolens AI-endpoint, som
 * kor konsolens egna rollstyrda dataverktyg (ekonomi, bemanning, telefoni,
 * avtal, QA) och redan haller de jarnhårda arlighetsreglerna. Ingenting rors i
 * konsolen; Pidde ar bara en till inloggad lasare.
 *
 * Kontot i CONSOLE_USER behover en roll som ser ekonomi/avtal/bemanning
 * (admin/superadmin), annars nekar konsolen de verktygen. Saknas CONSOLE_*
 * degraderar verktyget snallt: det sager rakt ut att live-data inte ar kopplad
 * i stallet for att lata Pidde gissa.
 * ─────────────────────────────────────────────────────────────────────────
 */

const CHAT_TIMEOUT_MS = 75_000;      // konsolens radgivare kor verktyg och kan ta tid
const SESSION_MAX_AGE = 1000 * 60 * 30; // logga in pa nytt var halvtimme proaktivt

const clean = (v) => String(v == null ? '' : v).trim().replace(/^[<"'\s]+|[>"'\s]+$/g, '').trim();
// Kontrollera <> pa RAVARDET (fore strippning), annars klassas platshallaren
// <your-console-url> som riktig eftersom clean() just tagit bort dess < och >.
const isReal = (v) => { const raw = String(v == null ? '' : v); return !!clean(v) && !/[<>]/.test(raw); };

export function hasConsole(env = process.env) {
  return isReal(env.CONSOLE_URL) && isReal(env.CONSOLE_USER) && isReal(env.CONSOLE_PASSWORD);
}
function baseUrl(env) { return clean(env.CONSOLE_URL).replace(/\/+$/, ''); }

let session = { cookie: null, at: 0 };

async function login(env) {
  const res = await fetch(baseUrl(env) + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: clean(env.CONSOLE_USER), password: clean(env.CONSOLE_PASSWORD) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`konsol-login gav HTTP ${res.status}`);
  // Echo tillbaka vilken cookie konsolen an satter — vi behover inte kanna namnet.
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const cookie = set.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) throw new Error('konsolen returnerade ingen session-cookie (fel losenord eller roll?)');
  session = { cookie, at: Date.now() };
  return cookie;
}

async function ensureSession(env, force = false) {
  if (!force && session.cookie && Date.now() - session.at < SESSION_MAX_AGE) return session.cookie;
  return login(env);
}

function postChat(env, cookie, body) {
  return fetch(baseUrl(env) + '/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
}

/**
 * Verktyget Pidde anropar for riktig konsoldata. Returnerar text (samma form som
 * konsolens radgivare svarar i), aldrig ett kast — ett fel blir en tydlig
 * text sa Pidde kan saga det rakt ut.
 */
export async function senzumData({ question, from, to } = {}, env = process.env) {
  if (!hasConsole(env)) {
    return 'KONSOLEN AR INTE ANSLUTEN (CONSOLE_URL/CONSOLE_USER/CONSOLE_PASSWORD saknas). Sag rakt ut for anvandaren att live-datan inte ar kopplad an — hitta INTE pa siffror.';
  }
  const body = { messages: [{ role: 'user', content: String(question || '').slice(0, 4000) }] };
  if (from) body.from = from;
  if (to) body.to = to;
  try {
    let cookie = await ensureSession(env);
    let res = await postChat(env, cookie, body);
    if (res.status === 401 || res.status === 403) { cookie = await ensureSession(env, true); res = await postChat(env, cookie, body); }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      const why = data && data.error ? ': ' + data.error : '';
      return `Kunde inte hamta fran konsolen (HTTP ${res.status}${why}). Sag det rakt ut i stallet for att gissa.`;
    }
    return String(data.answer || '(konsolen gav ett tomt svar)');
  } catch (e) {
    const msg = e && e.name === 'TimeoutError' ? 'konsolen svarade inte i tid' : (e && e.message) || String(e);
    return `Konsolen gick inte att na (${msg}). Sag det rakt ut for anvandaren — hitta inte pa siffror.`;
  }
}

/** Enkel halsokoll for UI:t: ar env satt, och gar det att logga in? */
export async function consoleHealth(env = process.env) {
  if (!hasConsole(env)) return { configured: false, ok: false };
  try { await ensureSession(env, true); return { configured: true, ok: true }; }
  catch (e) { return { configured: true, ok: false, error: (e && e.message) || String(e) }; }
}

export const SENZUM_DATA_TOOL = {
  name: 'senzum_data',
  description:
    'Hamtar Senzums RIKTIGA operativa siffror ur NEXUS-konsolen: samtal, arenden och SLA, kotid, bemanning ur Quinyx, telefoni ur Zisson, ekonomi och marginal per kund, avtalstext och priser, kvalitet (QA) och bemanningsprognos (Erlang C). Anvand ALLTID detta nar fragan ror faktiska tal, marginaler, SLA, bemanning, avbrott eller vad ett avtal sager. Formulera en tydlig delfraga pa svenska. Ange from/to om fragan galler en annan period an innevarande manad.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Vad du vill veta, i klartext. Ex: "CDON:s samtals-SLA och marginal i augusti 2026, och hur lag bemanningen mot volymen?"' },
      from: { type: 'string', description: 'Valfri periodstart, YYYY-MM-DD.' },
      to: { type: 'string', description: 'Valfritt periodslut, YYYY-MM-DD.' },
    },
    required: ['question'],
  },
};
