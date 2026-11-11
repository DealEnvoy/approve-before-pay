# Approve before Pay

An agent reads a plain language payment request and prepares a PayPal order. Nothing is captured until a person reviews a checkable summary and approves that version. Reject and edit are available. The approval gate is enforced on the server, and every step is written to an audit log.

Built by Isaac Adekunle / Drew & Crew with AI coding agents, for the PayPal AI Hackathon.

## Demo mode, stated plainly

The recorded demo video and the screenshots in `demo/` were made with:

- **PayPal: mock mode.** `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` were not set. No live PayPal call was made. No money moved.
- **AI: offline fallback, model `offline-rules-v1`.** `OPENAI_API_KEY` was not set, and Cloudflare Workers AI credentials were not set. A language model was not called.

The banner in the app states the same thing while it is running. Do not describe this demo as a live PayPal charge or a live model call.

The sandbox Orders v2 client and the OpenAI / Cloudflare tool calling client are implemented. Unit tests exercise the Orders v2 URLs against a fake HTTP server, and they exercise the tool call parser against a fixture. Those tests do not call PayPal or a model provider.

## What it does

A reviewer pastes a request such as: "Plumber needs a £150 deposit to book a boiler service next Tuesday."

The agent proposes a payee, amount, currency, purpose, and timing. For each field it keeps the exact words it used. The server checks that each quote is really in the request. It also raises risk flags, including a new payee, a missing email, more than one amount, an amount that does not match the text, or a large amount (1000 or more in major units).

It then opens a PayPal order with intent `CAPTURE` and stops. Capture is a separate step. The server returns HTTP 403 if capture is attempted before a person approves the current version, after a rejection, or after an edit (an edit clears approval and opens a new uncaptured order).

## How it works

1. The reviewer submits the request text.
2. The agent extracts a proposal. With a model key, that is one tool call named `propose_payment`. Without a key, the offline rules extractor does the same job and says so.
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
  |-- Agent: OpenAI tool call, Cloudflare Workers AI, or offline rules
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

A real capture often still needs the payer to approve the order in PayPal, unless the sandbox app can take a card. Set `PAYPAL_CAPTURE_WITH_TEST_CARD=true` and a card number from the [PayPal card testing page](https://developer.paypal.com/tools/sandbox/card-testing/) only if that app has card processing turned on. This demo did not do that.

## AI

| Provider | When it is used | Model |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` is set, or `AI_PROVIDER=openai` | `OPENAI_MODEL`, default `gpt-4o-mini`. Chat completions with tool `propose_payment`. |
| Cloudflare Workers AI | Cloudflare account id and API token are set, and OpenAI is not | `CLOUDFLARE_AI_MODEL`, default `@cf/meta/llama-3.1-8b-instruct`, via the OpenAI compatible endpoint and the same tool. |
| Offline fallback | No key, or `AI_PROVIDER=offline`, or the model call fails | `offline-rules-v1`. Rules for amounts, payee, purpose, timing, and email. |

`AI_PROVIDER=auto` picks OpenAI, then Cloudflare, then offline.

If a configured model call fails, the case falls back to `offline-rules-v1` and the audit says the model result was not kept.

## Setup

Requirements: Node.js 22.

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

Copy `.env.example` to `.env.local` if you want to change mode. Restart the dev server after changing variables.

### Switch to PayPal sandbox

1. Create a REST app at [developer.paypal.com](https://developer.paypal.com/) and copy the sandbox client id and secret.
2. In `.env.local`:

```
PAYPAL_MODE=sandbox
PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_secret
```

3. Restart `npm run dev`. The banner should say sandbox, not mock mode.
4. Orders are created on the sandbox merchant for those credentials. Capture still happens only after approval in this app. If PayPal returns `ORDER_NOT_APPROVED`, the payer has not approved the order yet. The audit keeps the failure and does not mark the case captured.

Leave the variables empty, or set `PAYPAL_MODE=mock`, to force mock mode even if old credentials are present.

### Switch to a real model

OpenAI:

```
AI_PROVIDER=openai
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4o-mini
```

Cloudflare Workers AI:

```
AI_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_token
CLOUDFLARE_AI_MODEL=@cf/meta/llama-3.1-8b-instruct
```

Restart the server. The banner names the provider. Each case also records which provider actually produced that proposal.

## Tests

```bash
npm test
```

The tests cover the approval gate: capture is refused before approval, refused when risk flags are not acknowledged, refused after rejection, and refused after an edit clears approval. They also check that create does not call capture, that a quote missing from the text is flagged, and that the sandbox client posts to `/v2/checkout/orders` and only hits the capture URL when capture is requested.

## Demo files

- `demo/approve-before-pay-demo.mp4`
- `demo/01-proposal.png`
- `demo/02-capture-refused.png`
- `demo/03-captured.png`

`npm run demo` records them again against the dev server. It does not change the mode. It writes `demo/mode.json` with the banner text from that run.

## Devpost pitch

Project name: **Approve before Pay**

Pitch (166 characters):

> An agent turns a plain language request into a PayPal order. A person checks the evidence and approves before any capture. The gate is server side, with an audit log.

## Limitations

- Mock mode does not contact PayPal. Sandbox mode does, and this repository's demo was recorded in mock mode.
- The offline extractor is a set of rules, not a language model. It expects a short request that names a payee up front and includes a currency amount.
- There is no login. Anyone who can open the local server can approve. This is a local review desk, not a multi user product.
- The store is a JSON file on disk (`data/store.json`). It is not a database, and it is not shared across machines.
- Currencies are GBP, USD, and EUR only. The large amount flag is a flat threshold of 1000 major units, not a risk engine.
- Editing a proposal leaves the previous PayPal order uncaptured and creates a new one. It does not call the PayPal update endpoint.
- The named payee is not paid by setting PayPal's payee email. See "How it works" above.
- Card capture is optional and was not used in the demo. A normal sandbox capture can still fail until a payer approves the order in PayPal.
