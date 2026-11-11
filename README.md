# Approve before Pay

An agent reads a plain language payment request and prepares a PayPal order. Nothing is captured until a person reviews a checkable summary and approves that version. Reject and edit are available. The approval gate is enforced on the server, and every step is written to an audit log.

Built by Isaac Adekunle / Drew & Crew with AI coding agents, for the PayPal AI Hackathon.

## What the recorded demo shows

The video and screenshots in `demo/` were recorded at 22:17 GMT on 11 November 2026, against the live PayPal sandbox and Cloudflare Workers AI. No OpenAI call was made. This is a sandbox run, not a production charge, and not a mock.

- **PayPal: sandbox.** The desk called Orders v2 on `https://api-m.sandbox.paypal.com`. The calls were `POST /v1/oauth2/token`, `POST /v2/checkout/orders` with intent `CAPTURE`, `GET /v2/checkout/orders/{id}`, and after human approval `POST /v2/checkout/orders/{id}/capture`. Desk capture sent PayPal's published sandbox test card (`PAYPAL_CAPTURE_WITH_TEST_CARD=true`), so the capture could complete without a payer approving the order in PayPal.
- Recorded sandbox order: `9W5288732H463711G`. It was created with status `CREATED`, then captured to `COMPLETED`.
- Recorded sandbox capture: `2GK80902TN269473E`, status `COMPLETED`.
- **AI: Cloudflare Workers AI.** The desk requested `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with one `POST /accounts/{account_id}/ai/run/{model}` and function calling for `propose_payment`. Workers AI reported the answering model as `@cf/meta/llama-3.3-70b-json`. The banner and the audit log name that model. `OPENAI_API_KEY` was not set. This run did not use `offline-rules-v1`.

The banner in the app states the same thing while it is running. In the video, a capture click is refused until a person approves. After approval, the same order is captured.

## What it does

A reviewer pastes a request such as: "Plumber needs a £150 deposit to book a boiler service next Tuesday."

The agent proposes a payee, amount, currency, purpose, and timing. For each field it keeps the exact words it used. The server checks that each quote is really in the request. It also raises risk flags, including a new payee, a missing email, more than one amount, an amount that does not match the text, or a large amount (1000 or more in major units).

It then opens a PayPal order with intent `CAPTURE` and stops. Capture is a separate step. The server returns HTTP 403 if capture is attempted before a person approves the current version, after a rejection, or after an edit (an edit clears approval and opens a new uncaptured order).

## How it works

1. The reviewer submits the request text.
2. The agent extracts a proposal. With Workers AI or OpenAI credentials, that is one tool call named `propose_payment` (or one JSON object for a Workers AI model that does not support function calling). Without credentials, the offline rules extractor does the same job and says so.
3. The server checks quotes and computes risk flags. It does not trust the model for those checks.
4. The PayPal client creates an order (`intent` `CAPTURE`) and reads it back. It does not capture.
5. The reviewer sees the original text, the extracted fields, the quotes, the flags, and the PayPal operations that already ran.
6. Approve, reject, or edit. Approve requires the reviewer name, a short note, and an acknowledgement of every warning or block flag. The server checks that list.
7. Capture runs only after that approval, and only for the same proposal version.
8. Each of those steps is an audit event the reviewer can read.

Known payees live in `data/known-payees.json`. A name that is not on that list is flagged as new. The named payee is written on the order description. It is not sent as a PayPal `payee.email_address`, because that field has to be a real PayPal account and a wrong email would fail order creation. In sandbox mode the receiver is the merchant for the API credentials. In mock mode the receiver is a mock merchant.

## Architecture

```
Browser desk
  |
  |  /api/cases, /approve, /reject, /capture
  v
Case service (the approval gate)
  |-- Agent: Cloudflare Workers AI, optional OpenAI tool call, or offline rules
  |-- Quote check and risk flags
  |-- PayPal client: sandbox Orders v2, or mock
  |-- Audit log
  v
data/store.json
```

The gate lives in `assertCaptureAllowed` in `src/server/service.ts`. Route handlers call that service. Hiding the button is not the control. `POST /api/cases/:id/capture` refuses when the case is not approved.

## PayPal API

Sandbox host: `https://api-m.sandbox.paypal.com`

| Step | Method and path | When |
| --- | --- | --- |
| Access token | `POST /v1/oauth2/token` | Sandbox mode only, client credentials |
| Create order | `POST /v2/checkout/orders` | When a proposal is ready. Body `intent` is `CAPTURE`. |
| Read order | `GET /v2/checkout/orders/{id}` | Immediately after create |
| Capture | `POST /v2/checkout/orders/{id}/capture` | Only after human approval of the current version |

Mock mode implements the same three order operations in memory. Order ids start with `MOCK`. Capture ids start with `MOCKCAP`. The audit text says the result is simulated.

A real sandbox capture often still needs the payer to approve the order in PayPal, unless the sandbox app can take a card. Set `PAYPAL_CAPTURE_WITH_TEST_CARD=true` and a card number from the [PayPal card testing page](https://developer.paypal.com/tools/sandbox/card-testing/) only if that app has card processing turned on. The recorded demo did this, so the desk capture could complete.

## AI

| Provider | When it is used | Model |
| --- | --- | --- |
| Cloudflare Workers AI | `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set. This is the default. | Requested model is `CF_AI_MODEL`, default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. `POST /accounts/{account_id}/ai/run/{model}`. Function calling for `propose_payment` when the model supports it. Otherwise one JSON object, checked with the same schema. The audit records the model name Workers AI reports, which can differ from the requested name. |
| OpenAI | Workers AI credentials are absent and `OPENAI_API_KEY` is set, or `AI_PROVIDER=openai` | `OPENAI_MODEL`, default `gpt-4o-mini`. Chat completions with tool `propose_payment`. |
| Offline fallback | No credentials, `AI_PROVIDER=offline`, or the model call fails or hits the call cap | `offline-rules-v1`. Rules for amounts, payee, purpose, timing, and email. |

`AI_PROVIDER=auto` picks Workers AI, then OpenAI, then offline.

If a configured model call fails, the case falls back to `offline-rules-v1` and the audit says the model result was not kept.

## Setup

Requirements: Node.js 22.

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

Copy `.env.example` to `.env.local` if you want to change mode. Restart the dev server after changing variables. Do not commit `.env.local`.

### Switch to PayPal sandbox

Create a REST app at [developer.paypal.com](https://developer.paypal.com/) and put the sandbox client id and secret in `.env.local`:

```
PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_secret
```

Restart `npm run dev`. With both values set, the desk uses the sandbox. With either value missing, it stays in mock mode. `PAYPAL_MODE=mock` forces mock even when the credentials are present.

Orders are created on the sandbox merchant for those credentials. Capture in the desk still waits for approval in this app. If PayPal returns `ORDER_NOT_APPROVED`, the payer has not approved the order yet. The audit keeps the failure and does not mark the case captured.

To send a published sandbox test card on desk capture, set `PAYPAL_CAPTURE_WITH_TEST_CARD=true` and `PAYPAL_TEST_CARD_NUMBER` to a card from the PayPal card testing page. The recorded demo used that setting.

### Switch to a real model

Cloudflare Workers AI is the default. Put the account id and token in `.env.local`:

```
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_token
```

Leave `CF_AI_MODEL` unset to request `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. That model supports function calling, so the desk sends `propose_payment` as a tool. Set `CF_AI_MODEL` only when you want a different Workers AI model. Models that do not support function calling get one JSON reply, which this app checks with the same schema.

OpenAI is optional. It runs when Workers AI credentials are absent and `OPENAI_API_KEY` is set, or when you force it:

```
AI_PROVIDER=openai
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4o-mini
```

Restart the server. Before a request is on screen, the banner names the configured provider and says no request has run yet. After a request, the banner and the audit log show the provider and the model name that ran. For Workers AI that name is the `model` field on the run result when present, otherwise the model on the run URL. For OpenAI it is the `model` field on the chat completion. If the call fails or the process hits `AI_MAX_CALLS` (default 20), the case falls back to `offline-rules-v1` and the text says the model result was not kept.

## Tests

```bash
npm test
```

The tests cover the approval gate: capture is refused before approval, refused when risk flags are not acknowledged, refused after rejection, and refused after an edit clears approval. They also check that create does not call capture, that a quote missing from the text is flagged, that the sandbox client posts to `/v2/checkout/orders` and only hits the capture URL when capture is requested, and that a Workers AI tool call and a JSON reply both record the model name, including the name Workers AI reports when it differs from the requested model, and that the call cap stops further model calls.

### Sandbox smoke

With `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in the environment:

```bash
npm run sandbox:smoke
```

This gets a sandbox access token, creates a 1.00 USD order with intent `CAPTURE`, reads it, then captures it using PayPal's published sandbox Visa `4012000033330026` (or `PAYPAL_TEST_CARD_NUMBER` if you set one). It prints the order id and the create, read, and capture statuses. It does not print the client secret or the card number. It exits with an error if capture does not come back `COMPLETED`. The desk is not involved, so this does not pass the human approval gate.

### Record the demo

Start the desk first so it sees the same environment (`npm run dev` loads `.env.local`). Then:

```bash
npm run demo:record
```

Playwright drives the full flow against `http://127.0.0.1:4317` and writes:

- `demo/approve-before-pay-demo.mp4` (about 1 to 2 minutes)
- `demo/01-proposal.png`
- `demo/02-capture-refused.png`
- `demo/03-captured.png`
- `demo/mode.json` (the banner text at the start of that run, before a request is opened)

The recording uses whatever PayPal and AI mode the running server is in.

## Demo files

- `demo/approve-before-pay-demo.mp4` (90 seconds)
- `demo/01-proposal.png`
- `demo/02-capture-refused.png`
- `demo/03-captured.png`

These files are from the 11 November 2026 recording described above: PayPal sandbox Orders v2, and Cloudflare Workers AI model `@cf/meta/llama-3.3-70b-json` (requested `@cf/meta/llama-3.3-70b-instruct-fp8-fast`).

## Built with

- PayPal Orders v2 sandbox (`POST /v1/oauth2/token`, `POST /v2/checkout/orders` with intent `CAPTURE`, `GET /v2/checkout/orders/{id}`, `POST /v2/checkout/orders/{id}/capture`). Mock mode is what runs when `PAYPAL_CLIENT_ID` or `PAYPAL_CLIENT_SECRET` is absent.
- Cloudflare Workers AI `POST /accounts/{account_id}/ai/run/{model}`. Default requested model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, override `CF_AI_MODEL`. Function calling for `propose_payment` on that model. OpenAI chat completions remain an optional fallback. Offline rules `offline-rules-v1` run when no credentials are set.
- Next.js, React, and TypeScript.

Final recorded run (do not invent later values):

- PayPal mode: sandbox
- Recorded order id: `9W5288732H463711G`
- Recorded capture id: `2GK80902TN269473E`
- Recorded capture status: `COMPLETED`
- AI that ran in the recording: Cloudflare Workers AI, model `@cf/meta/llama-3.3-70b-json` (requested `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, function calling, `OPENAI_API_KEY` unset)

## Devpost pitch

Project name: **Approve before Pay**

Pitch (166 characters):

> An agent turns a plain language request into a PayPal order. A person checks the evidence and approves before any capture. The gate is server side, with an audit log.

## Limitations

- The recorded demo contacts the PayPal sandbox, not the live production PayPal API. No production payments were made.
- The offline extractor is a set of rules, not a language model. It expects a short request that names a payee up front and includes a currency amount. It was not used in the recorded demo.
- There is no login. Anyone who can open the local server can approve. This is a local review desk, not a multi user product.
- The store is a JSON file on disk (`data/store.json`). It is not a database, and it is not shared across machines.
- Currencies are GBP, USD, and EUR only. The large amount flag is a flat threshold of 1000 major units, not a risk engine.
- Editing a proposal leaves the previous PayPal order uncaptured and creates a new one. It does not call the PayPal update endpoint.
- The named payee is not paid by setting PayPal's payee email. See "How it works" above.
- The recorded demo sent a published sandbox test card on capture. A normal sandbox capture can still fail until a payer approves the order in PayPal if that setting is off.
