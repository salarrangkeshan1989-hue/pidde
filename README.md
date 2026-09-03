# Pidde

VD:s privata operations-copilot for Senzum. Login, sedan rakt in i ett samtal med Pidde:
en erfaren Senzum-kollega som kan outsourcad kundtjanst, minns dig mellan samtal, ser
Senzums riktiga siffror och kan sla upp saker pa natet. Proffsig men mansklig. Bara for VD.

## Vad den ar

- **Chatt** som du och Pidde bollar dagens utmaningar i: strategi, bemanning, personal,
  ekonomi, design, prognos. Streamande svar, mansklig ton.
- **Langtidsminne.** Varje samtal sparas (sidopanel med tidigare samtal). En minnesprofil
  av bestaende fakta om dig och foretaget matas in i varje samtal, sa Pidde blir en copilot
  som vaxer med dig. Pidde skriver till minnet sjalv nar den lar sig nagot varaktigt.
- **Live konsoldata.** Pidde loggar in i NEXUS-konsolen (eget konto) och laser dina riktiga
  siffror darifran, SLA, bemanning, telefoni, ekonomi/marginal, avtal, kvalitet, prognos.
  Ingenting rors i konsolen. Saknas konto sager Pidde det rakt ut i stallet for att gissa.
- **Kunskapsbas.** Ladda upp dokument (.txt/.md/.docx/.pdf) eller klistra in text. Pidde
  soker i dem nar det behovs.
- **Webbsok.** Via Claudes inbyggda web search. Av tills du slar pa det (se .env.example).
- **Claude nu, OpenAI forberett.** Modellvaxlaren i UI:t tands nar OPENAI_API_KEY finns.

## Arkitektur

Fristaende Express-app. Ingen databas, en JSON-fil-store pa en volym (`DATA_DIR`):
`users.json`, `threads.json`, `memory.json`, `knowledge.json`. Auth: signerad httpOnly-cookie,
async scrypt, brute-force-spärr, CSP. Samma beprovade monster som kunskapsbas-apparna.

```
src/
  server.js     Express-limmet: routes, auth, SSE-streaming
  auth.js       sessioner, scrypt, throttle, anvandar-store
  store.js      atomar JSON-fil-persistens (tradar, minne, kunskap)
  console.js    NEXUS-koppling: login + senzum_data-verktyget
  knowledge.js  kunskapsbas: lagra dokument + sok
  llm.js        agentiska loopen (Claude/OpenAI), verktygsutskick, streaming
  persona.js    systemprompten: Pidde-persona + Senzum/BPO-kunskap + minne + arlighet
public/
  login.html    inloggning
  index.html    chatten (sidopanel, stream, minne, kunskap, modellval)
```

## Kom igang

```bash
cd pidde
npm install
cp .env.example .env      # fyll i ANTHROPIC_API_KEY, PIDDE_USER/PASSWORD, SESSION_SECRET
npm start                 # http://localhost:4180
```

For live-data: satt `CONSOLE_URL` + `CONSOLE_USER`/`CONSOLE_PASSWORD` till ett konsolkonto
med admin/superadmin-roll (t.ex. ett eget `pidde@senzum.com`). For webbsok: aktivera web
search pa Anthropic-kontot och satt `ENABLE_WEB_SEARCH=1`.

## Deploy (Railway)

Egen tjanst. `node src/server.js`. Montera en volym och peka `DATA_DIR` dit. Satt
`SESSION_SECRET`, `PIDDE_USER`/`PIDDE_PASSWORD`, `ANTHROPIC_API_KEY`, och konsol-variablerna.

## Sakerhet

Ett konto (VD). Aldrig nagra nycklar i klienten, allt bakom servern. Konsol-losenordet och
API-nycklar bor bara i miljon. Byt `SESSION_SECRET` och VD-losenordet for produktion.
