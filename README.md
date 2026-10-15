# Baton

**Not advice, just the record: "Sam logged metformin at 8:00. Log again anyway?"**

Live demo: https://baton.tunapro.xyz (until 21 Nov)

Baton is a shared care log you talk to. Everyone who looks after an older parent (a son on the morning shift, an aide in the afternoon, a daughter staying with her this week) writes to the same record by voice, and everyone sees the same answer to "did Mom get her evening pill?".

> **Not a medical device.** Baton records your family's plan and who did what. It never suggests a dose.

All people and data in this repository are fictional. The demo household is June Harper (fictional, 81).

## How it works

- One MCP server (protocol `2025-11-25`, Streamable HTTP) holds the log. It exposes nine tools and four resources.
- A web host with a real MCP client plays the part of an Alexa+-style simulated assistant. Two browser sessions stay in sync through resource subscriptions.
- If someone logs a dose that is already logged for the same window, the server asks first (MCP elicitation): "Sam logged metformin at 8:00. Log again anyway?" Declining writes nothing.
- "Since you left" briefs and a visit timeline for the clinician are built from the log with fixed templates. The timeline lists dates only and implies no link between entries.
- When a caregiver's shift starts on the simulated clock, the shared kitchen device shows that person what happened since they left, without being asked.
- A device without a screen is heard by everyone in the room. The host declares the MCP Apps UI extension (`io.modelcontextprotocol/ui`) only when it can draw views; switch on "No-screen device" and that panel reconnects as a new session without it. The server reads the client's capabilities and, for that session, leaves medicine names, pill descriptions, strengths and the words of notes out of everything it says: "Sam already logged this one at 8:00. Log again anyway?" Names stay on screen. The spoken wording lives next to the regular wording in `contract/src/contract.ts` (`SPOKEN`).
- Before the host opens any connection it asks once, per household: what is sent to the Baton server and why. "Not now" opens no MCP session.
- Push-to-talk speech is recognised in the browser. Chrome's Web Speech API is used only when it can run on the device (`processLocally`); otherwise Whisper (`whisper-base.en`) runs in a Web Worker with transformers.js. Recognisers bend drug names ("met forming"), so near misses of the family's own plan names are put back before the line reaches the assistant (`host/src/stt-match.ts`). There is no drug dictionary.

## MCP features in use

| Feature | Where |
|---|---|
| Streamable HTTP, stateful sessions, standalone GET stream | `server/src/http.ts` |
| `resources/subscribe` and `notifications/resources/updated` to every subscribed session | `server/src/hub.ts`, `server/src/mcp.ts` |
| Elicitation: single select (who is speaking, which tablet), confirm (second dose, corrections), multi select (notes for the visit) | `server/src/mcp.ts`, drawn by `host/src/elicit.ts` |
| `outputSchema` and `structuredContent` on every tool | `contract/src/contract.ts` |
| MCP Apps views (`ui://baton/today`, `brief`, `visit`) with `inline` and `fullscreen` display modes | `server/views/`, mounted by `host/src/view-frame.ts` through `AppBridge` |
| Tool annotations (`readOnlyHint`, `destructiveHint`) | `contract/src/contract.ts` |
| Client capability negotiation: the MCP Apps UI extension decides spoken or screen wording | `host/src/device.ts`, `server/src/mcp.ts` |

## The pattern, for your own MCP server

Nothing here is specific to pills. Any record that two people write to can use the same three rules, all of them in the server:

1. Before a write that may repeat someone else's entry, the server checks its own record and asks through elicitation: "Sam logged metformin at 8:00. Log again anyway?" Declining writes nothing (`log_care_event` in `server/src/mcp.ts`; `server/test/tools.test.ts`, `partial-duplicate.test.ts`).
2. If the client did not declare elicitation, the server writes nothing and returns the fact instead: "Sam logged metformin at 8:00. Nothing new was logged." (`server/test/noelicit.test.ts`).
3. If the client did not declare the MCP Apps UI extension, it may be a speaker in a shared room, so replies leave out the sensitive words (`server/test/policy.test.ts`).

`server/test/pattern.test.ts` runs all three rules against one household record, with one named test per rule: a client with a screen, one that cannot be asked, and a speaker without a screen.

To check that your own server's replies can be read aloud, point voice-ready-mcp at it with a few tool calls:

```sh
npx github:tunapro1234/voice-ready-mcp#v0.1.0 --url http://127.0.0.1:3000/mcp --fixtures calls.json
```

## On a real Alexa+ add-on

Baton runs against its own web host, a simulated Alexa+-style assistant with a real MCP client. I have not deployed it to Alexa+. As I read the MCP Toolkit pages, some parts already line up: Streamable HTTP, protocol `2025-11-25` and MCP Apps views. A real add-on would still need a public HTTPS endpoint, OAuth 2.1 (authorization code with PKCE) in front of the household record, a deploy with the toolkit's `alexa-ai` CLI, and a review against the add-on policy. The pages do not say whether Alexa+ forwards a server's elicitation to the user. If it does not, rule 2 above applies: Baton writes nothing and says who already logged it.

Rule 3 is the part that would change. The display modes page calls voice-only "the always-on baseline of an add-on" and asks that a tool's data "remain intelligible without any visual support", so Alexa+ may speak from that data. I found no field that tells the server, per request, whether this reply will be spoken on a device without a screen. Baton keeps the structured result whole for its views, names included, and only the text is reworded. On Alexa+ it would need to use the spoken wording for every session and take the names out of the structured result as well, unless Alexa+ adds such a signal.

## Packages

| Package | What it holds |
|---|---|
| `contract/` | Tool names, input and output schemas, resource URIs, the simulated clock and the fictional fixture. Every other package imports from here. |
| `server/` | The MCP server (low-level `Server`, resource subscriptions, elicitation). |
| `host/` | The web host and the MCP Apps views. |
| `proxy/` | The assistant proxy: live mode or recorded responses, plus the output guardrail. |
| `evals/` | Guardrail, number and speech checks that run without an API key. The speech clips in `evals/stt/audio` are synthetic adult voices made with a text-to-speech API (`npm run stt:audio -w evals`): 30 in `sentences.json` and 12 in `heldout.json`, written after the plan-name matcher was tuned on the first 30. |

## Two modes

- **Live:** the proxy reads `ANTHROPIC_API_KEY` from the environment. No key is ever stored in this repository. A spending cap in code stops live calls when the daily or monthly budget is reached.
- **Mock ("Limited fixed script"):** assistant turns come from `recorded_responses/*.json` and carry a "Recorded response (mock)" badge. The server, elicitation, views and sync still run for real.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BATON_PORT` | `3000` | Listen port, bound to 127.0.0.1 only |
| `BATON_DB` | `./baton.db` | SQLite path; `:memory:` works |
| `BATON_NOW` | fixture "today" at 07:00 | Start of the simulated clock (local ISO time, no zone) |
| `BATON_FIXTURE` | `june` | Loads `contract/fixtures/<name>.json` into an empty database |
| `BATON_TOKEN` | empty | When set, `/mcp` and `/clock` require `Authorization: Bearer <token>` |
| `BATON_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | Comma-separated list of allowed origins |
| `ANTHROPIC_API_KEY` | unset | Live mode only |
| `BATON_MODEL` | `claude-haiku-5-5` | Model for live mode |
| `BATON_BUDGET_USD_DAY` | `1` | Daily live spending cap |
| `BATON_BUDGET_USD_MONTH` | `8` | Monthly live spending cap |
| `BATON_PROXY_PORT` | `3001` | Assistant proxy port, bound to 127.0.0.1 only |
| `BATON_HOST_PORT` | `5173` | Web host (Vite) port |
| `VITE_BATON_SERVER` | `http://127.0.0.1:3000` | Where the web host finds the MCP server |
| `VITE_BATON_PROXY` | `http://127.0.0.1:3001` | Where the web host finds the assistant proxy |

## Simulated clock

Business rules never read the real time. The server keeps a simulated clock that starts at the fixture's day:

- `GET /clock` returns `{"now":"2026-10-20T08:05:00"}`.
- `POST /clock` with `{"set":"<iso>"}` or `{"advanceMinutes":n}` moves it and returns the new time.

When a dose window closes or a shift starts, subscribed sessions get `notifications/resources/updated`.

## Run it locally

Node 22.18 or newer: the services run their TypeScript sources directly, which Node does by default from 22.18. Three processes, each in its own terminal:

```sh
npm install
npm start -w server      # MCP server on 127.0.0.1:3000
npm start -w proxy       # assistant proxy on 127.0.0.1:3001 (mock mode unless ANTHROPIC_API_KEY is set)
npm run dev -w host      # web host on http://127.0.0.1:5173
```

Open the web host. The left panel is a shared kitchen device and asks who is speaking; the right panel is Nora's phone. Type what you would say, or use the shortcut buttons, which call the server directly. The clock buttons move the simulated time. The protocol panel lists every JSON-RPC message of both sessions.

## Public demo mode

`npm run demo` starts the service behind the hosted demo: one process on one port (`BATON_PORT`, 127.0.0.1 only), meant to sit behind a reverse proxy that serves the static host build from `npm run build:demo -w host` (output in `host/dist-demo`).

- Every visitor gets a room: a fresh copy of the fictional household, held in memory only. The room id is in the page URL (`?room=`), so a reload keeps it. A room nobody uses for 30 minutes is dropped, along with everything typed into it.
- At most 20 rooms at a time, 8 sessions per room, 64 KB per request, 240 requests per minute and 10 new rooms per hour from one address (`server/src/rooms.ts`).
- The assistant answers from recorded responses only. The service will not start if `ANTHROPIC_API_KEY` is set, and both budget caps are 0.
- Every response carries `X-Robots-Tag: noindex, nofollow`, the page has a matching robots meta tag, and `robots.txt` disallows the whole site.

## Tests

```sh
npm test                    # unit tests in every package, no API key, no network
npm run eval:guardrail      # 40 dose and symptom cases through the output filter
npm run eval:numbers        # 20 scripted turns: no number in a reply that the tools did not return
npm run eval:stt            # 30 synthetic voice clips through the on-device Whisper model and the plan-name matcher
npm run eval:stt:heldout    # the 12 held-out clips
npx playwright test -c host # end to end: two sessions, sync, double-dose dialog, demo flow, display modes
npm run e2e:demo -w host     # the demo build and service: a room per visitor, shared by the same link
```

`npm run check:voice` starts the server in memory and runs voice-ready-mcp (the dev dependency `git+https://github.com/tunapro1234/voice-ready-mcp.git#v0.1.0`, fetched over HTTPS so no GitHub SSH key is needed) against it with the read-only calls in `scripts/voice-calls.json`. It checks that every reply can be read aloud, that p95 latency stays under 500 ms, that a foreign Origin gets 403 and an unsupported protocol version gets 400, and that each view is served as `text/html;profile=mcp-app`. The result goes to `report.json`. CI runs all of the above except Playwright and `eval:stt` on every push (`.github/workflows/ci.yml`).

## Limitations

- Baton only knows what people tell it. A dose nobody logged looks the same as a dose nobody gave, so Baton never says a dose was missed. It says no one has logged it.

## What Baton does not do

Baton has no reminders, no refills, no ordering, no pharmacy link and no drug information. It does not suggest, change or approve doses, and it does not interpret symptoms. Questions about doses get a fixed reply that quotes the family's plan and points to the clinician.

## License

MIT. See `LICENSE`.
