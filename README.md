# Baton

**Alexa reminds. Baton records who did it.**

Baton is a shared care log you talk to. Everyone who looks after an older parent (a son on the morning shift, an aide in the afternoon, a daughter who calls from another city) writes to the same record by voice, and everyone sees the same answer to "did Mom get her evening pill?".

> **Not a medical device.** Baton records your family's plan and who did what. It never suggests a dose.

All people and data in this repository are fictional. The demo household is June Harper (fictional, 81).

## How it works

- One MCP server (protocol `2025-11-25`, Streamable HTTP) holds the log. It exposes nine tools and four resources.
- A web host with a real MCP client plays the part of an Alexa+-style simulated assistant. Two browser sessions stay in sync through resource subscriptions.
- If someone logs a dose that is already logged for the same window, the server asks first (MCP elicitation): "Sam logged metformin at 8:05. Log again anyway?" Declining writes nothing.
- "Since you left" briefs and a visit timeline for the clinician are built from the log with fixed templates. The timeline lists dates only and implies no link between entries.

## Packages

| Package | What it holds |
|---|---|
| `contract/` | Tool names, input and output schemas, resource URIs, the simulated clock and the fictional fixture. Every other package imports from here. |
| `server/` | The MCP server (low-level `Server`, resource subscriptions, elicitation). |
| `host/` | The web host and the MCP Apps views. |
| `proxy/` | The assistant proxy: live mode or recorded responses, plus the output guardrail. |
| `evals/` | Guardrail and number checks that run without an API key. |

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

## Simulated clock

Business rules never read the real time. The server keeps a simulated clock that starts at the fixture's day:

- `GET /clock` returns `{"now":"2026-10-20T08:05:00"}`.
- `POST /clock` with `{"set":"<iso>"}` or `{"advanceMinutes":n}` moves it and returns the new time.

When a dose window closes or a shift starts, subscribed sessions get `notifications/resources/updated`.

## Development

```sh
npm install
npm test -w contract
```

## What Baton does not do

Baton has no reminders, no refills, no ordering, no pharmacy link and no drug information. It does not suggest, change or approve doses, and it does not interpret symptoms. Questions about doses get a fixed reply that quotes the family's plan and points to the clinician.

## License

MIT. See `LICENSE`.
