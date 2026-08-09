# WhatsApp Personal Agent: Architecture, Design, and Decision Log

This document explains the application as if the reader has never built a software system before. It describes what each process does, how data moves, where data is stored, which decisions are enforced by deterministic code, where AI is allowed to help, why the chosen technologies were selected, which alternatives were considered, and how to rebuild or extend the system safely.

The document describes the current code in this repository. The operational setup guides remain:

- [README.md](README.md) for local setup and everyday use;
- [AWS_FREE_DEPLOYMENT.md](AWS_FREE_DEPLOYMENT.md) for Amazon EC2;
- [CLOUD_DEPLOYMENT.md](CLOUD_DEPLOYMENT.md) for Oracle Cloud;
- [android-sms-companion/README.md](android-sms-companion/README.md) for the Android application.

## 1. The problem being solved

The project turns one private WhatsApp account into a personal interface for several independent workflows:

1. Record food from text or voice notes and estimate servings and nutrition.
2. Add food-shopping requests to Google Tasks instead of treating them as consumed food.
3. Return daily macro summaries and vegetarian meal suggestions.
4. Generate one-stock or complete-batch HTML equity research reports.
5. Build a monthly spending report from transaction SMS, optional Gmail receipts, and optional Swiggy order history.
6. Run the stock and budget workflows automatically on schedules while the agent is online.

The important architectural choice is that WhatsApp is only the user interface. It is not the database, scheduler, calculation engine, or secrets store. One long-running Node.js process coordinates those responsibilities.

## 2. Beginner glossary

| Term | Meaning in this project |
|---|---|
| Agent | The long-running `node index.js` process. |
| API | A defined way for one program to request data or an action from another program. |
| Container | An isolated runtime containing Node, Python, Chromium, and the application. Docker creates it. |
| Cron expression | A compact schedule such as `0 18 * * 1-5`, meaning 6:00 PM Monday through Friday. |
| Deterministic | The same validated input follows explicit code rules and produces predictable behavior. |
| Enrichment | Optional extra information added to an already valid base record. |
| HMAC | A signature proving that an HTTP request was created by a device holding the shared secret and was not changed in transit. |
| JID | WhatsApp's serialized chat identifier, such as an `@lid`, `@c.us`, or `@g.us` value. |
| OAuth | A delegated login flow where Google or Swiggy grants a token without giving the application the user's password. |
| Paise | One hundredth of an Indian rupee. Monetary arithmetic uses integer paise to avoid floating-point errors. |
| Runtime state | Mutable data created while the program runs: sessions, tokens, caches, logs, reports, and schedule checkpoints. |
| Tailscale | A private encrypted network connecting the phone, Windows computer, and EC2 VM. |
| Trust boundary | A point where untrusted or sensitive input enters another part of the system and must be validated. |

## 3. System-wide invariants

These are design rules that should remain true even when the application is extended:

- Financial reports and stock reports are available only through the configured `PERSONAL_CHAT_ID`.
- Cook-chat messages may log food or create shopping tasks, but cannot retrieve private macro, stock, or budget data.
- Amounts, dates, refund direction, duplicate reconciliation, and monthly totals are calculated by code, not Gemini.
- Gemini may interpret language and classify bounded evidence, but its output is validated before use.
- Raw personal SMS conversations, OTPs, promotional messages, account numbers, UPI IDs, and payment references must not be sent to Gemini.
- The SMS endpoint remains bound to `127.0.0.1`; it is not opened to the public internet.
- Budget HTML is sent as a private WhatsApp attachment and is never converted into a public link.
- Mutable cloud data lives under `cloud-data/`, outside the container image, and survives a rebuild.
- A failed optional enrichment must not prevent core deterministic reporting when a safe fallback exists.
- The local Windows agent and EC2 agent must not run simultaneously because both could process the same WhatsApp message.

## 4. High-level architecture

```text
Android phone                         Google / external services
┌──────────────────────┐              ┌───────────────────────────────┐
│ WhatsApp mobile       │─────────────▶│ WhatsApp Web in Chromium      │
│ SMS Companion         │              │ Google Sheets / Tasks / Gmail │
│ Tailscale client      │              │ Gemini API                    │
└──────────┬───────────┘              │ Yahoo/public market metadata  │
           │ private HTTPS             │ Swiggy read-only MCP           │
           ▼                           └──────────────┬────────────────┘
┌────────────────────────────────────────────────────▼─────────────────┐
│ EC2 Ubuntu VM                                                       │
│  Tailscale Serve ──▶ 127.0.0.1:8787                                │
│  Docker Compose                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Node agent (`index.js`)                                       │  │
│  │  WhatsApp routing │ schedules │ SMS API │ Google integrations │  │
│  │          │                    │                               │  │
│  │          └──────────▶ Python stock engine                     │  │
│  │                       (`gemini-code.py`)                       │  │
│  └──────────────────────────────┬────────────────────────────────┘  │
│                                 │ bind mount                         │
│                          `cloud-data/`                               │
│  sessions │ encrypted SMS │ encrypted Swiggy cache │ reports │ logs │
└─────────────────────────────────────────────────────────────────────┘
```

There is intentionally one main application container. Schedules are in-process jobs rather than separate cron daemons. This makes `npm start` locally or one Compose service in EC2 the single operational unit.

## 5. End-to-end startup sequence

1. Docker Compose loads `.env.cloud` and mounts `./cloud-data` at `/data`.
2. `tini` becomes PID 1 inside the container so shutdown signals and child Python processes are handled correctly.
3. `npm start` launches `node index.js`.
4. `dotenv` loads local `.env` values when present. In Docker, Compose has already supplied the cloud environment.
5. Runtime paths are resolved. Cloud paths point into `/data`; local Windows paths preserve backward-compatible locations.
6. Google Tasks OAuth state is loaded if its token exists.
7. `whatsapp-web.js` starts headless Chromium using the persistent linked-device profile.
8. The agent waits for the genuine WhatsApp `ready` event. It does not pretend to be ready merely because authentication succeeded.
9. A readiness watchdog inspects the page. If WhatsApp is authenticated but its event layer is missing, it performs bounded reinjection. A genuine timeout clears only the disposable web cache and lets Docker restart the process; linked-device credentials are preserved.
10. After `ready`, the agent establishes its own private JID, registers message processing, enables audio download, validates the Python engine, starts schedules, starts the SMS HTTP service, and begins optional Swiggy synchronization.
11. Docker's `restart: unless-stopped` policy restarts the process after a crash or VM reboot unless an operator intentionally stopped it.

Why wait for WhatsApp before starting dependent services? Message delivery and scheduled WhatsApp responses require a usable client. The current implementation keeps startup state simple by using WhatsApp readiness as the application-ready boundary. One consequence is that the SMS health port is unavailable while WhatsApp is stuck; the readiness recovery exists to bound that state.

## 6. Repository map

### 6.1 Main Node.js modules

| File | Responsibility | Why it is separate |
|---|---|---|
| `index.js` | Composition root: creates clients, handles WhatsApp events, routes actions, starts schedules, and coordinates integrations. | Cross-service orchestration belongs in one visible entry point. Pure logic is moved out so it can be tested. |
| `message-policy.js` | Deterministic text shortcuts, Gemini action authorization, budget phrase parsing, MIME normalization, and generated-message loop prevention. | Routing and authorization rules should be testable without connecting to WhatsApp. |
| `gemini-resilience.js` | Gemini error classification, retry policy, hard-quota detection, and model fallback. | All AI calls use consistent quota and availability behavior. |
| `whatsapp-readiness.js` | Authenticated-but-not-ready diagnostics, bounded reinjection, and disposable cache recovery. | WhatsApp Web changes independently and needs isolated lifecycle tests. |
| `whatsapp-media.js` | Reconstructs changed WhatsApp message IDs and downloads/decrypts voice notes with retries. | Media failures are different from intent or nutrition failures. |
| `runtime-paths.js` | Cross-platform data directories and browser executable discovery. | Local Windows and Linux containers use different paths without scattering platform checks. |
| `stock-reports.js` | Parses stock commands, validates tickers, finds Python, serializes jobs, and parses Python results. | Keeps long-running Python execution out of general WhatsApp routing. |
| `budget-access-policy.js` | Validates the personal chat, rejects unsafe destinations, disables public budget links, and redacts budget audit bodies. | Financial authorization is a dedicated, fail-closed boundary. |
| `budget-reports.js` | Transaction parsing, merchant/item categorization, Gemini-safe projections, deduplication, Swiggy matching, totals, WhatsApp summaries, HTML/JSON generation, and custom rules. | Budget logic is large but remains independently testable and deterministic around money. |
| `budget-schedule-state.js` | Monthly run claiming, completion state, catch-up behavior, and retry cooldown. | Prevents duplicates across restarts and makes schedule behavior testable with fake dates. |
| `sms-ingestion.js` | Signed HTTP API, server-side SMS filtering, minimization, encryption, replay prevention, deduplication, and scan checkpoints. | Treats the phone-to-server boundary as a security subsystem. |
| `swiggy-orders.js` | Read-only MCP client, allowlisted tools, OAuth state checks, normalization, encryption, retention, and cache synchronization. | Swiggy is optional and should fail independently of base SMS reporting. |

### 6.2 Helper and authorization programs

| File | Purpose |
|---|---|
| `auth-tasks.js` | One-time Google Tasks OAuth on localhost port 3000. |
| `auth-budget.js` | Optional Gmail read-only OAuth on localhost port 3001. |
| `auth-swiggy.js` | Interactive Swiggy Food and Instamart authorization. |
| `setup-sms-secret.js` | Generates or reveals the long SMS HMAC/encryption secret without putting it in Git. |
| `cloud-check.js` | Preflight validation of environment variables, paths, Chromium, Python, Google credentials, SMS security, and optional integrations. |
| `run-tests.js` | Finds the test directory reliably and invokes Node's built-in test runner. |

### 6.3 Python stock modules

| File | Responsibility |
|---|---|
| `gemini-code.py` | Fetches market/fundamental data, calculates valuation and technical metrics, validates analyst evidence, generates HTML, and supports ticker batches. |
| `stock_intelligence.py` | AI value-chain taxonomy, memory/storage subtypes, current-year analyst validation, public-feed normalization, relevance/noise/source scoring, and five-level market signal aggregation. |

### 6.4 Android modules

| File | Responsibility |
|---|---|
| `MainActivity.kt` | Consent, endpoint/secret configuration, permissions, manual synchronization, and last-success display. |
| `SecureConfigStore.kt` | Encrypts endpoint, secret, consent, installation ID, and last-sync metadata with Android Keystore. |
| `SmsRepository.kt` | Reads only the current IST month's SMS inbox through Android's content provider. |
| `TransactionSmsFilter.kt` | Rejects personal or non-transaction messages locally and minimizes accepted text. |
| `SmsPayloadBuilder.kt` | Creates bounded schema-v2 batches and the mandatory completion checkpoint. |
| `HmacUploadClient.kt` | Signs and POSTs exact JSON bytes over HTTPS. |
| `SmsSyncWorker.kt` | Performs the scan, filtering, batching, upload, completion, and last-success update. |
| `SmsSyncScheduler.kt` | WorkManager immediate and six-hour background jobs with connected-network constraints and exponential retry. |
| `IncomingSmsReceiver.kt` | Requests background synchronization after a new SMS broadcast. |

## 7. Technology and package decisions

### 7.1 Node.js as orchestrator

Node.js is well suited to event-driven WhatsApp messages, HTTP callbacks, OAuth servers, schedules, and child-process management. Rewriting the Python valuation engine was unnecessary, so Node launches Python only for stock jobs.

Alternatives considered:

- All Python: strong for analysis, but would require replacing mature WhatsApp and existing Node integrations.
- Multiple microservices: cleaner at very large scale, but introduces service discovery, multiple deployments, queues, and more failure modes for one user.
- Serverless functions: unsuitable because WhatsApp Web needs a persistent browser and schedules/reports may outlive request limits.

### 7.2 Important npm packages

| Package | Use | Decision rationale |
|---|---|---|
| `whatsapp-web.js` | Controls WhatsApp Web through Chromium. | Supports linked-device sessions and message/media events without a paid WhatsApp Business API. It is unofficial and therefore requires recovery logic and may break when WhatsApp changes. |
| `@google/generative-ai` | Gemini calls for intent, nutrition, suggestions, and bounded budget enrichment. | Matches the established Gemini implementation and supports text plus audio input. |
| `@googleapis/sheets` | Food and budget sheet writes. | Official generated Google API client. |
| `@googleapis/tasks`, `googleapis`, `google-auth-library` | Google Tasks, Gmail, OAuth, and service-account authentication. | Official Google libraries with refresh-token support. |
| `node-cron` | Weekday and monthly schedules. | Small in-process scheduler; no second operating-system service is required. |
| `@modelcontextprotocol/sdk`, `mcp-remote` | Swiggy read-only MCP access and interactive authorization. | Uses the provider interface rather than scraping authenticated pages. |
| `qrcode`, `qrcode-terminal` | Writes a QR image and displays a terminal QR. | Supports headless cloud pairing and recovery. |
| `dotenv` | Loads local environment configuration. | Keeps deploy-specific values out of source. |

The WhatsApp dependency is pinned to a specific upstream commit rather than a loose version. Reproducibility matters because an upstream change can alter injection and event behavior. Updating it must be tested against authentication, readiness, self-chat messages, group messages, and voice media.

### 7.3 Python packages

| Package | Use |
|---|---|
| `yfinance` | Market prices, financial statements, recommendation history, analyst targets, and public Yahoo metadata. |
| `pandas` | Tabular transformations and financial-series calculations. |
| `requests` | Public metadata feeds and optional provider HTTP calls. |
| `google-genai` | Optional grounded Google Search for public analyst-action evidence. |

The core report remains operational when Gemini grounding is unavailable. Market data, technical calculations, independent valuation, and HTML generation are not delegated to Gemini.

### 7.4 Android packages

Android uses Kotlin, API 26 minimum, API 35 target, Java 17, Material UI, and WorkManager. WorkManager was selected instead of an always-running background service because Android restricts continuous background processes and can schedule network-aware retry work more responsibly.

## 8. Configuration model

Secrets and deployment choices are environment variables; mutable tokens and state are files. `.env.example` is for Windows/local operation and `.env.cloud.example` is copied to `.env.cloud` on a VM.

### 8.1 Required core settings

| Variable | Meaning |
|---|---|
| `GEMINI_API_KEY` | Gemini API key. |
| `SPREADSHEET_ID` | Google Sheet used for food and budget output. |
| `COOK_CHAT_ID` | Chat allowed to log food and create shopping tasks. |
| `PERSONAL_CHAT_ID` | Exact direct chat allowed to retrieve macros, suggestions, stocks, and budgets. |
| `USER_GOAL` | Nutrition goal text used in summaries and suggestions. |

### 8.2 Runtime and WhatsApp settings

| Variable | Meaning |
|---|---|
| `AGENT_DATA_DIR` | Root of mutable data on cross-platform deployments. Docker fixes this at `/data`. |
| `WHATSAPP_AUTH_PATH` | Persistent linked-device browser profile. |
| `WHATSAPP_WEB_CACHE_PATH` | Disposable WhatsApp HTML/module cache. |
| `WHATSAPP_BROWSER_EXECUTABLE` | Chromium/Chrome/Brave executable. |
| `WHATSAPP_HEADLESS` | `true` avoids a visible browser. |
| `WHATSAPP_READY_TIMEOUT_MS` | Authenticated readiness watchdog, bounded to 30 seconds–10 minutes. |
| `AGENT_STATUS_PATH`, `WHATSAPP_QR_PATH`, `WHATSAPP_AUDIT_LOG_PATH` | Status, QR, and audit locations. |

### 8.3 Budget and SMS settings

| Variable | Meaning |
|---|---|
| `SMS_INGESTION_ENABLED` | Enables the private SMS API. |
| `SMS_INGESTION_HOST` | Must remain `127.0.0.1` in the cloud design. |
| `SMS_INGESTION_PORT` | Default `8787`. |
| `SMS_INGESTION_SECRET_FILE` | Shared HMAC and storage-key material. |
| `SMS_SCAN_MAX_AGE_HOURS` | Maximum age of a completed scan, default 12 hours. |
| `MONTHLY_BUDGET_INR` | Optional budget target. |
| `BUDGET_ALLOW_INITIAL_CATCH_UP` | Prevents surprise backfill on a new installation unless explicitly enabled. |

### 8.4 Optional settings

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and Gmail token path enable optional receipt collection.
- `SWIGGY_ORDER_HISTORY_ENABLED` and its auth/cache paths enable item-level Swiggy enrichment.
- Market sentiment environment variables enable/disable Reddit and GDELT, set lookback, provide reviewed author scores, or add an official X API token.
- `REPORT_PUBLIC_BASE_URL` can create links for stock reports. Budget delivery explicitly ignores it.
- `FMP_API_KEY` optionally adds an FMP company profile when the account has access; paid analyst datasets are not assumed.

## 9. Runtime storage and why it is outside Git

In Docker, `./cloud-data:/data` is a bind mount. Rebuilding the image replaces code and dependencies but not `/data`.

```text
cloud-data/
├── whatsapp-auth/                 linked-device session; sensitive
├── whatsapp-web-cache/            disposable web cache
├── secrets/
│   ├── service-account.json       Google Sheets service account
│   ├── google-tasks-token.json    OAuth refresh/access tokens
│   ├── google-budget-token.json   optional Gmail token
│   ├── sms-ingestion-secret.txt   HMAC/encryption key material
│   └── swiggy-mcp-auth/           optional Swiggy OAuth state
├── budget-data/
│   ├── android-sms.enc.jsonl      encrypted minimized SMS records
│   ├── android-sms-scan-state.json
│   ├── swiggy-orders.enc.json     encrypted normalized orders
│   ├── category-rules.json
│   └── monthly-schedule-state.json
├── budget-reports/                private JSON and HTML reports
├── stock-reports/                 generated stock HTML/ZIP output
├── logs/chat-events.log           audit log with budget redaction
└── status/
    ├── agent-status.json
    └── whatsapp-qr.png
```

These files must not be committed. `.gitignore` reduces accidental inclusion, but it is not encryption and does not protect files already committed or copied by OneDrive.

## 10. WhatsApp integration design

### 10.1 Why WhatsApp Web

The official WhatsApp Business Platform is intended for registered business messaging and has different identity, template, webhook, and pricing requirements. This personal research agent uses a linked WhatsApp Web device so messages sent from the mobile account can be observed in the self-chat.

Trade-offs:

- Advantage: works with the existing personal account and self-chat.
- Cost: requires long-running Chromium, persistent browser state, and more recovery code.
- Risk: it is an unofficial automation path and can change independently. It should not be presented as a supported multi-user SaaS foundation.

### 10.2 Chat identity and authorization

Every message is resolved into a scope:

- cook chat;
- exact configured personal chat;
- unrelated chat.

`@lid` and `@c.us` identities may represent the same private user differently. Matching logic normalizes the relevant identity cases. Group IDs end with `@g.us` and are never accepted as a budget destination.

The auto-detected `client.info.wid` is useful for diagnostics but is not allowed to silently replace `PERSONAL_CHAT_ID` for financial access. Budget configuration fails closed.

### 10.3 Message routing order

Ordering prevents expensive or unsafe work from stealing another command:

1. Audit the message and determine chat scope.
2. Ignore messages older than the agent's ready timestamp and deduplicate message IDs.
3. Reject agent-generated replies so self-chat output does not create a loop.
4. Download voice media when applicable.
5. Detect budget context before external AI and block it outside the configured personal chat.
6. In the personal chat, evaluate deterministic macro, meal, and stock shortcuts. Recognized budget context bypasses stock parsing.
7. Use Gemini for remaining natural-language intent.
8. Validate Gemini's proposed action against chat permissions.
9. Execute exactly one action: log food, add task, summarize, suggest, generate stock report, generate budget, or ignore.

The stock parser requires deliberate stock language and rejects other report domains. This exists because a phrase such as “in this budget report I...” must never treat the pronoun `I` as a ticker.

### 10.4 Readiness and cache recovery

WhatsApp can emit `authenticated` at 99–100% without completing library injection. The code does not manually emit `ready`, because that could start the agent before message listeners exist.

Instead, the watchdog:

- observes authentication and high loading percentages;
- checks document readiness, socket state, and `window.WWebJS`;
- performs at most two full reinjections when synchronization evidence exists but the event layer is missing;
- logs a structured diagnostic after the safety timeout;
- destroys Chromium;
- clears only `whatsapp-web-cache`;
- preserves `whatsapp-auth` so QR pairing is normally retained;
- exits so Docker can restart cleanly.

### 10.5 Voice notes

Outgoing self-chat voice messages can have incomplete serialized IDs in some WhatsApp builds. `whatsapp-media.js` reconstructs the ID, refetches the message, attempts direct media decryption when appropriate, and retries temporary empty downloads. The normalized audio MIME type is sent to Gemini for transcription and intent analysis. Tests use mocked media; they do not send real WhatsApp messages.

## 11. Gemini boundary

Gemini is used for language tasks that benefit from semantic understanding:

- distinguishing food consumption from purchasing intent;
- extracting food items, servings, meal type, and estimated nutrition;
- transcribing/interpreting supported voice input;
- generating meal suggestions and compact macro summaries;
- interpreting monthly budget intent and constrained custom category proposals;
- classifying sanitized merchant-name projections when deterministic rules cannot decide;
- optional grounded discovery of public, current-year analyst actions.

Gemini is not trusted to:

- authorize a chat;
- select an arbitrary budget destination;
- alter transaction amounts, refund direction, timestamps, or duplicate matching;
- see raw Android SMS bodies during merchant classification;
- assign protected categories such as Ayush transfers or credit-card payments;
- invent receipt items or analyst targets without evidence.

The primary model and fallback list live in `message-policy.js`. `gemini-resilience.js` distinguishes retryable overload/rate-limit errors from invalid requests. A hard daily quota moves to the fallback instead of repeatedly spending time on a model that cannot succeed. This is why a log can show a primary `429` followed by a successful report.

Alternative considered: send every message directly to an LLM. Rejected because it increases latency, quota use, false positives, and exposure of unrelated text. Deterministic shortcuts and chat guards run first.

## 12. Nutrition and shopping workflow

### 12.1 Intent rule

In either the cook or personal chat:

- Food language without buying intent is treated as consumed or prepared food and logged.
- Buying/bringing/purchasing intent creates a Google Task instead.

Examples:

- `2 servings of poha for breakfast` → estimate and log.
- `Make 2 servings of poha` → estimate and log.
- `Chana and paneer for breakfast` → estimate and log.
- `Buy paneer and milk` → Google Tasks, not nutrition.

Macro summaries and meal suggestions are personal-chat-only. Confirmations resulting from cook-chat actions are routed privately to the configured personal chat.

### 12.2 Nutrition persistence

Gemini returns structured item estimates. The agent converts them into Sheet rows and appends them through the Sheets service account. Daily summaries read today's rows, total calories/protein/carbohydrates/fat/fiber, compare them with `USER_GOAL`, and ask Gemini only to format a concise explanation.

Nutrition estimates remain estimates. Portion ambiguity, preparation oil, recipes, and brand variation can affect precision. The Sheet provides an auditable log rather than claiming laboratory accuracy.

### 12.3 Google authentication split

Google Sheets uses a service account because the agent writes to one explicitly shared spreadsheet without interactive user login.

Google Tasks uses user OAuth because tasks belong to the user's Google account. `auth-tasks.js` stores a refresh token and automatically writes refreshed credentials back to its token file. Gmail also uses user OAuth, but with its own optional token and read-only receipt scope. These identities should not be conflated.

## 13. Android SMS security architecture

### 13.1 Why a companion application is mandatory

Windows and EC2 cannot read Android's protected SMS database. Android grants `READ_SMS` only to an installed application after user approval. The companion reads locally, filters locally, and uploads only selected transaction evidence.

Alternatives considered:

- ADB extraction: requires a cable/debugging session, is unsuitable for unattended operation, and broadens access.
- SMS forwarding to a public provider: introduces another company and often a recurring cost.
- Reading notification history: incomplete and device/OEM dependent.
- Bank APIs: fragmented, difficult for personal access, and do not cover every payment source.

### 13.2 On-device minimization

The companion scans the current month in Asia/Kolkata. It requires:

- an INR amount;
- explicit settled evidence such as debited, spent, paid, charged, purchased, refunded, withdrawn, transferred, or a clearly completed payment;
- a non-personal automated sender.

It rejects:

- blank, unknown, phone-number, or ordinary personal senders;
- OTP, verification, PIN, and security-code messages;
- payment requests, pending/failed payments, due notices, balance-only alerts, and order-status-only messages;
- promotional messages without a clear completed transaction;
- self-transfer language and ordinary personal conversations.

Before upload it removes or replaces URLs, email/UPI identifiers, phone numbers, account/card references, long references, transaction IDs, security tails, balance tails, and marketing tails. Lengths and batch sizes are bounded.

### 13.3 Payload and completion protocol

The companion sends schema-v2 JSON batches of at most 100 candidate messages. Each scan carries:

- an installation ID;
- send time;
- redacted sender, occurrence time, minimized body, and stable message identity;
- scan ID, IST month, start and upper bound;
- inbox count and selected candidate count;
- `complete: false` while records are uploading.

After every candidate batch succeeds, it sends an empty signed batch with `complete: true`. That final checkpoint is essential: receiving some transactions does not prove the whole inbox scan finished. Even a month with zero candidates sends the completion checkpoint.

### 13.4 HMAC request authentication

For each HTTP request:

```text
timestamp = current Unix time in milliseconds
nonce     = new random URL-safe value
canonical = timestamp + "." + nonce + "." + exact_JSON_request_body
signature = HMAC-SHA256(shared_secret, canonical)
```

The companion sends the timestamp, nonce, and hexadecimal signature as headers. The server recomputes the signature over the exact received bytes and uses constant-time comparison.

The server also rejects:

- timestamps outside a five-minute window;
- repeated nonces/replays;
- non-JSON content;
- oversized bodies or batches;
- malformed schema and invalid scan windows;
- records that fail the server's second transaction filter.

HTTPS encrypts transport. HMAC proves request integrity/authenticity. They solve different problems, so both are used.

### 13.5 Encryption at rest

Accepted minimized records are not written as plaintext. The Node server:

1. Derives a 256-bit storage key from the shared SMS secret.
2. Generates a fresh random initialization vector.
3. Encrypts each JSON record with AES-256-GCM.
4. Stores an envelope containing version/IV/authentication tag/ciphertext as one JSONL line.

GCM provides confidentiality and tamper detection. JSONL permits append-only storage and record-by-record decryption/deduplication. The report JSON is a processed output and is sensitive even though identifiers are minimized; it remains private under `cloud-data`.

The Android endpoint, shared secret, consent state, installation ID, and last-sync timestamp are encrypted using Android Keystore-backed configuration. Android backup is disabled for the app.

## 14. Why Tailscale Serve

The SMS API listens only on `http://127.0.0.1:8787`. That address is reachable from the EC2 VM itself but not from the public internet or phone.

Tailscale creates a private WireGuard-based network among approved devices. Tailscale Serve adds a private HTTPS hostname and forwards it to the loopback HTTP service:

```text
Phone HTTPS request
  → encrypted Tailscale network
  → https://EC2-TAILNET-NAME.ts.net/v1/sms/transactions
  → Tailscale Serve
  → http://127.0.0.1:8787/v1/sms/transactions
```

Reasons for this choice:

- no public port 8787;
- no public DNS/certificate administration;
- valid HTTPS for Android;
- device access controlled by the tailnet;
- free for the small personal-device topology;
- stable private hostname even if the EC2 public IP changes.

Alternatives:

- Open port 8787 publicly: rejected because HMAC alone should not replace network isolation and TLS.
- Nginx + Let's Encrypt: viable, but requires a domain, firewall, renewal, and public attack surface.
- SSH reverse/forward tunnel from Android: operationally awkward for a mobile background worker.
- Cloudflare Tunnel: viable, but adds another external control plane and public hostname policy.

The phone configuration must use the complete upload URL:

```text
https://EXACT-TAILSCALE-HOST/v1/sms/transactions
```

`/health` is only a GET diagnostic. The companion posts to the exact endpoint entered and does not append the API path automatically.

## 15. Monthly budget pipeline

### 15.1 Source collection

1. Verify a complete, recent Android scan checkpoint for the requested month.
2. Decrypt and revalidate minimized SMS records.
3. Optionally read Gmail receipts using the authorized read-only OAuth token.
4. Optionally refresh/read the encrypted Swiggy cache.
5. Convert every accepted source into a common transaction structure.

Android coverage is mandatory by design. Gmail and Swiggy are enrichment sources and cannot substitute for proof that the current SMS inbox was fully scanned.

### 15.2 Deterministic transaction model

Each normalized transaction carries a stable ID, provider/source type, occurrence time, direction, integer amount in paise, sanitized merchant, category, items, source list, and duplicate evidence. Internal-only evidence fields are removed before the public report object is written.

### 15.3 Merchant and item categorization

The order of authority is:

1. Locked deterministic merchant rules for known platforms or protected cases.
2. Safely extracted merchant/payee evidence from transaction templates.
3. Bounded Gemini merchant classification for unresolved SMS projections.
4. Conservative fallback categories.
5. Month-specific custom category rules, validated against a bounded schema.

Examples:

- Swiggy/Zomato/Ownly/EatClub → Online food.
- Zepto/Instamart/Blinkit/BigBasket/Flipkart Minutes → Online delivery.
- Bottle Lab → Office cafeteria.
- Exact Ayush Mehta variants → Ayush transfers.
- Tata Payments → Credit card payment.
- Foreign-currency evidence → Forex.

Item categories require actual receipt/order evidence. The system never allocates a bank payment total across invented items. Swiggy item names may classify paneer, vegetables, milk, dal, etc. as essential groceries; protein bars, Diet Coke, and chips remain online delivery; poha has its own category.

### 15.4 Gemini privacy projection

For SMS merchant classification, Gemini receives only:

- a locally hashed row ID;
- a sanitized merchant/payee name.

It does not receive the SMS body, sender, amount, time, account/card information, UPI ID, or payment reference. Model output must reference an offered hashed ID, use an allowlisted category, and meet validation/confidence requirements. Deterministically locked merchants cannot be overridden.

### 15.5 Duplicate and refund reconciliation

Duplicates are matched conservatively, using compatible evidence such as:

- stable record identity after companion reinstall/rescan;
- exact amount plus matching order reference;
- bank and gateway alerts within 30 seconds;
- same merchant and exact amount within 90 seconds;
- matching receipt/payment evidence within four hours;
- matching refunds within a five-minute boundary.

Refunds are reconciled separately from debits. The algorithm avoids chain-merging records outside the allowed time from the original record. Transfers and forex do not use unsafe amount/time-only merging.

### 15.6 Totals and excluded money movements

Integer paise prevents errors such as `0.1 + 0.2` floating-point drift. Expense debits minus expense refunds produce net spend.

`Ayush transfers` and `Credit card payment` are visible but excluded from:

- debit/refund expense totals;
- net spend;
- remaining budget;
- expense category totals;
- top expense merchants;
- itemized expense coverage.

They appear in the transaction ledger and a separate excluded-money-movements section. Credit-card bill payment exclusion avoids counting underlying card purchases and the later bill settlement twice.

### 15.7 Custom post-report categories

A personal-chat instruction can propose month-scoped category rules. Gemini converts language into a constrained proposal; deterministic validation limits rule count, label length, selectors, merchant types, and operations. Rules may merge by default. Clearing or replacing all rules requires explicit matching language. Rules can regroup records but cannot change money, dates, refunds, or deduplication.

### 15.8 Outputs

- WhatsApp summary: compact totals, categories, exclusions, sources, and coverage notes.
- HTML: readable cards, category tables, excluded movements, item evidence, complete transaction ledger, and warnings.
- JSON: processed report structure used for audit/regeneration.
- Google Sheets: normalized transaction and missing-item rows for analysis.

## 16. Swiggy order-history enrichment

Swiggy is optional because a budget must still work from SMS if authorization expires.

The integration uses two read-only MCP endpoints: Food and Instamart. Locally enforced allowlists prevent calling mutation or unknown tools even if a remote server advertises them. Interactive authorization is performed once through SSH-forwarded callback ports 16148 and 21621.

The sync process:

1. Confirms usable provider-specific OAuth state.
2. Calls only allowlisted order-list/detail tools.
3. Normalizes order ID, provider, time, payable amount, merchant, item names/quantities/line values, and fees.
4. Hashes public order IDs.
5. Merges new orders into a 90-day encrypted cache.
6. Matches orders to bank payments only when platform, amount, and time evidence produce a unique safe match.
7. Adds item evidence without changing the bank total.

Instamart currently exposes a limited rolling source window, so daily synchronization preserves earlier successful records in the encrypted cache. Provider failures retain the last good cache. Authorization lifetime is controlled by Swiggy and may require periodic renewal.

Authenticated website scraping was not chosen because it is brittle, can expose credentials/cookies, must defeat changing anti-bot UI, and has a larger security and policy surface. The provider MCP remains a third-party dependency and can change.

## 17. Stock-report architecture

### 17.1 Request modes and job serialization

- A deliberate ticker request such as `stock report AMD` passes one validated symbol to Python.
- A generic request such as `stock report of the day` omits `--tickers`, causing Python to use its configured ticker list.
- The weekday schedule runs the same complete batch at 6:00 PM IST.

Stock and budget jobs are serialized in queues so overlapping requests do not compete heavily for network/API resources or overwrite an identical ticker output.

### 17.2 Core market and valuation layer

`gemini-code.py` uses Yahoo/yfinance for price history, financial statements, estimates, recommendations, and available target metadata. It calculates technical indicators and an independent valuation. Optional FMP profile data is used only when an API key/entitlement exists.

Analyst targets are not the independent fair value. The report separates:

- current-year sourced analyst actions/targets;
- provider rolling consensus when its individual dates are unavailable;
- independently calculated bear/base/bull valuation; and
- an evidence-calibrated 12-month objective.

The objective is deliberately bounded. Verified current-year targets use only the latest valid target per firm, are filtered for plausible units and robust statistical outliers, and receive a median-heavy anchor. Their influence is capped by valuation archetype and reduced when targets disagree. When only one or two verified firm targets exist, they are blended transparently with the rolling consensus at reduced reliability instead of being silently discarded. A rolling provider consensus has an additional reliability penalty because its underlying dates and individual votes are not available. The independent value is always displayed and is never overwritten.

Automatic price scaling is deliberately disabled. Silently dividing or multiplying prices can create catastrophic errors for post-spinoff or newly relisted companies such as storage/NAND businesses.

Currency normalization is separate from price scaling. The quote currency, filing currency, and each estimate table's declared currency are tracked explicitly. Monetary statements are converted with a market FX pair; per-share quote fields are left on the listed-share basis. The quote-equivalent share count is reconciled against `market capitalization / current price`, which prevents an ADR from being valued with the underlying local-share count. Missing cross-currency FX data causes dependent inputs to be omitted and confidence to be capped rather than combining incompatible units.

FY0 and FY+1 estimates are calendarized to the actual date twelve months after report generation. A fixed extra half-year roll was rejected because it extrapolated MU beyond an August FY+1 endpoint while simultaneously treating TSM's December FY+1 endpoint as though it were equally close. The DCF's first forecast year uses the same calendarized next-twelve-month revenue base.

Annual EPS passes a period-matched consistency gate using available `0q` and `+1q` EPS/revenue. The envelope is company-specific: it allows quarter-corroborated structural HBM margins and shrinks only an annual estimate that exceeds the quarterly/current margin evidence. Revenue-analyst and EPS-analyst counts produce separate weights so broad revenue coverage cannot make a one-analyst EPS number look reliable.

Valuation methods are never winsorized into artificial agreement. Raw DCF, earnings-relative, enterprise-relative, and cash-flow-relative outputs remain visible. A method outside the robust band is downweighted explicitly, method-family breadth enters confidence, and the diagnostic names any downweighted method. Dual listings such as ASE's `ASX` ADR and `3711.TW` ordinary share are deduplicated at issuer level before peer medians are calculated.

### 17.3 AI value-chain taxonomy

`stock_intelligence.py` recognizes hyperscalers, AI compute, wafer foundries, wafer equipment, process control/inspection, advanced packaging, semiconductor testing, photonics/optics, memory/storage, data-center power, power generation, regulated utilities, AI cloud infrastructure, and AI software.

Ticker overrides exist for well-known cases, with exact primary-business phrases as the fallback for unknown symbols. Memory/storage is split into NAND flash, diversified memory, HDD, controllers, and memory IP. Packaging is split into OSAT operators and packaging-equipment suppliers. Test is split into ATE, probe/test interfaces, and burn-in/reliability. Data-center power is split into critical power/cooling, distributed generation, electrical/grid equipment, and construction; merchant generators and regulated utilities stay separate.

Primary economic architecture and secondary AI exposure are deliberately different fields. Sandisk (`SNDK`) is modeled as NAND rather than generic storage. Micron (`MU`) uses a diversified DRAM/HBM/NAND policy whose forward earnings must be corroborated by quarterly margins and cash-flow/EBITDA methods. Taiwan Semiconductor (`TSM`) uses a foundry policy after ADR and TWD-to-USD normalization while CoWoS/SoIC appears as secondary advanced-packaging exposure. AMKR/ASX are OSATs; KLIC/BESI are packaging equipment; TER/COHU are ATE; FORM is test interface; AEHR is burn-in; KLAC/ONTO/CAMT/NVMI are process control. Bloom, VRT, ETN/GEV, and PWR use distinct power subtypes and peer groups.

### 17.4 Analyst evidence

Current-calendar-year records can come from:

- dated Yahoo upgrades/downgrades and target fields;
- one target-focused Gemini Google Search grounded request per ticker; and
- public-feed headlines containing explicit firm/action/target evidence.

Every source passes the same final validator. It requires a valid current-year date, named firm or acceptable attribution, sensible target, source evidence, and rejection of issuer-as-analyst mistakes. Explicit local-currency targets such as `NT$` are rejected for a USD ADR unless a separately auditable conversion is available. Duplicates are merged and the latest valid firm action is retained. If no verifiable current-year row exists, the report says so instead of inventing one.

The grounded adapter tries the configured model list on retryable `429` or `503` errors. If Gemini remains unavailable, Yahoo data, valuation, technical analysis, public-feed intelligence, and HTML generation continue. Precision is reduced only in optional analyst-discovery coverage, not in arithmetic already sourced from market/fundamental data.

### 17.5 Market sentiment and noise control

Public metadata sources include Yahoo news metadata, Google News RSS, optional GDELT DOC metadata, Reddit public RSS, and optional official X API v2 results. Paywalled article bodies are not bypassed or scraped. A Bloomberg or Reuters headline can still appear when exposed through public metadata.

Each item is scored using:

- publisher/domain reputation prior;
- exact operator-reviewed author reputation, when configured;
- ticker/company/theme relevance;
- freshness within the lookback;
- independent corroboration;
- lexical positive/negative evidence;
- spam, clickbait, ambiguity, and duplicate noise penalties.

Syndicated duplicates add corroboration but not extra votes. The aggregate combines filtered evidence with trend, 50/200-day moving averages, RSI, and momentum. It returns Strong Sell, Sell, Hold, Buy, or Strong Buy with diagnostics when evidence is thin.

This is research output, not a guarantee or automated trading instruction.

## 18. Scheduling decisions

| Job | Schedule | Implementation |
|---|---|---|
| Stock batch | Monday–Friday, 6:00 PM IST | `node-cron` in `index.js`. |
| Monthly budget | 26th, 6:00 PM IST | `node-cron`, plus persisted state. |
| Missed budget check | Hourly at minute 5 | Claims eligible missed runs and observes a six-hour failure cooldown. |
| Swiggy sync | Startup and default 3:10 AM IST | Optional `node-cron`; also runs before a budget report. |
| Android synchronization | Manual/new SMS/approximately every six hours | Android WorkManager, not Node cron. |

Why in-process cron? One start command owns the complete application, and the jobs need the already-authenticated WhatsApp client. The downside is that an offline container cannot execute at that instant. Budget schedule state adds safe recovery; the stock schedule does not silently backfill every missed weekday.

Time calculations use Asia/Kolkata explicitly so EC2's UTC system clock does not shift user-facing schedules or month boundaries.

## 19. Docker and EC2 design

### 19.1 Image

The image starts from `node:24-bookworm-slim`, installs Chromium, fonts, Python, `tini`, timezone data, and a Python virtual environment, then installs locked npm dependencies with `npm ci` and Python requirements.

It runs as the unprivileged `node` user instead of root. `--no-sandbox` is still required by the containerized Chromium arrangement, so the container also uses `no-new-privileges` and should not be treated as a general-purpose shared host.

### 19.2 Compose choices

- `network_mode: host`: permits loopback callbacks and Tailscale Serve/SSH tunnels to reach the container consistently on Linux.
- `restart: unless-stopped`: unattended recovery after reboot/crash while respecting an intentional stop.
- `shm_size: 1gb`: prevents Chromium failures caused by Docker's small default shared-memory allocation.
- `stop_grace_period: 30s`: gives schedules, HTTP service, browser, and child processes time to close.
- bind-mounted `cloud-data`: persistent and inspectable backup boundary.
- rotating JSON logs: three 10 MB files cap disk growth.

Host networking means cloud firewall discipline matters. Only SSH port 22 should be public. Ports 8787, 3000, 3001, 16148, and 21621 are used through Tailscale or temporary SSH tunnels, not public security-group rules.

### 19.3 Why EC2 rather than Vercel

Vercel/serverless platforms suspend processes, limit request duration, and do not preserve a continuously logged-in Chromium profile in the required way. EC2 supplies a real VM with persistent disk and Docker. Oracle Ampere Always Free was also documented because it can provide ongoing free ARM capacity, but account/capacity availability can be difficult. AWS is operationally easier but its free terms/credits are temporary and must be monitored.

### 19.4 Swap

A small EC2 instance can run Chromium, Node, and Python simultaneously. A 4 GB swap file provides an emergency memory buffer and reduces abrupt out-of-memory kills. Swap is much slower than RAM; sustained heavy swapping indicates that jobs should be serialized further or the VM resized.

## 20. Security and privacy threat model

### 20.1 Protected assets

- WhatsApp linked-device session;
- Google and Swiggy refresh tokens;
- Gemini/API credentials;
- SMS HMAC/encryption secret;
- minimized transaction records and reports;
- food logs and private chat IDs.

### 20.2 Main threats and controls

| Threat | Control |
|---|---|
| Unrelated chat requests a budget | Exact personal JID validation before Gemini and again at delivery. |
| Cook chat leaks private summary | Retrieval commands are ignored outside personal chat. |
| SMS endpoint exposed publicly | Loopback bind, closed AWS ports, private Tailscale Serve. |
| Forged/replayed phone upload | HTTPS, HMAC, clock window, nonce replay protection, schema validation. |
| Personal SMS sent to server/LLM | On-device strict filter, server re-filter, minimization, Gemini projection. |
| Disk theft or accidental inspection | AES-GCM encrypted SMS/Swiggy caches; secret file permissions; private VM. |
| LLM changes totals | Money and reconciliation remain deterministic; model output is bounded and validated. |
| Public budget URL | Budget delivery forces `allowPublicLink: false`. |
| Duplicate self-chat loop | Generated response headers and message IDs are recognized and ignored. |
| Container compromise as root | Non-root user and `no-new-privileges`; only required data volume mounted. |
| Unbounded logs/disk | Docker log rotation, bounded input sizes, limited cache/report directories. |

Encryption does not make an actively compromised running VM safe: the process must access keys to decrypt records. Keep EC2 patched, restrict SSH, protect the private key, and never paste secrets into chat, Git, or public logs.

## 21. Testing strategy

`npm test` invokes Node's built-in test runner over the repository's `test` directory. Tests cover:

- chat and budget authorization boundaries;
- text/voice-equivalent intent routing without sending WhatsApp messages;
- Gemini quota fallback;
- merchant parsing, protected categories, refunds, and duplicate windows;
- privacy projections and rejection of malformed AI output;
- encrypted SMS ingestion, HMAC, replay, scan completeness, and reinstall deduplication;
- Swiggy allowlists, normalization, encryption, cache fallback, and matching;
- stock ticker parsing and Python discovery;
- WhatsApp media repair/retry and readiness recovery;
- runtime paths across Windows and Linux.

`npm run test:stock` executes Python unit tests for source reputation, relevance/noise scoring, analyst validation, AI themes, technical signals, and memory/storage policy.

Tests favor pure functions and injected fake time/network clients. Live WhatsApp, Gemini, Google, Yahoo, Swiggy, and public feeds can change and therefore require a separate manual smoke test after deployment.

Minimum release checks:

```bash
npm test
npm run test:stock
docker compose --env-file .env.cloud run --rm agent npm run cloud:check
```

Then verify one harmless WhatsApp intent, one food log, the SMS health endpoint, and one small stock report before relying on schedules.

### 21.1 Data contracts a replacement implementation must preserve

The Android companion sends JSON schema version 2. Each ordinary batch contains at most 100 minimized candidates. A separate final checkpoint has an empty `messages` array and `scan.complete=true`; this distinction proves that the phone finished reading the entire requested month rather than merely uploading one successful batch.

```json
{
  "schemaVersion": 2,
  "source": "android-sms",
  "deviceId": "stable-random-install-id",
  "sentAt": 1786070000000,
  "messages": [
    {
      "id": "device-local-message-id",
      "sender": "bank-or-payment-sender",
      "occurredAt": 1786069000000,
      "body": "minimized transaction evidence only"
    }
  ],
  "scan": {
    "id": "random-scan-id",
    "monthKey": "2026-08",
    "from": 1785522600000,
    "through": 1786070000000,
    "inboxMessageCount": 420,
    "transactionCandidateCount": 31,
    "complete": false
  }
}
```

The phone sends these headers:

- `x-budget-timestamp`: the same current Unix-millisecond timestamp used for signing;
- `x-budget-nonce`: a fresh unpredictable request identifier;
- `x-budget-signature`: lowercase hexadecimal HMAC-SHA256.

The exact signed byte sequence is `timestamp + "." + nonce + "." + rawJsonBody`. The server must verify the signature over the unchanged raw request bytes, use a timing-safe comparison, reject timestamps outside its clock-skew window, and reject a nonce that it has already accepted. Parsing and reserializing JSON before checking HMAC can change whitespace or property ordering and will invalidate a correct signature.

Budget persistence in Google Sheets uses three stable tables:

| Sheet | Columns, in order |
|---|---|
| `BudgetTransactions` | `transaction_id`, `occurred_at_ist`, `month_key`, `provider`, `sources`, `source_type`, `merchant`, `channel_category`, `direction`, `amount_inr`, `currency`, `order_id_hash`, `item_count`, `source_ids`, `duplicate_alerts_merged`, `duplicate_reasons`, `record_status`, `matched_alert_times_utc` |
| `BudgetItems` | `transaction_id`, `line_no`, `item`, `quantity`, `line_amount_inr`, `item_category`, `confidence` |
| `BudgetRuns` | `run_id`, `month_key`, `trigger`, `generated_at`, `transaction_count`, `net_spend_inr`, `itemized_line_value_inr`, `warnings_json`, `duplicate_alerts_merged` |

Column order matters because the Google Sheets API appends arrays, not named objects. Changing a header requires a deliberate migration plus backward-compatible report reading. The JSON report is the machine-readable audit artifact; the HTML file and WhatsApp message are presentations derived from it.

### 21.2 Observability and failure-recovery map

| Symptom | Evidence to inspect first | Meaning and safe recovery |
|---|---|---|
| Container repeatedly restarts | `docker compose ... logs -f agent` and `cloud-data/whatsapp-runtime-status.json` | Usually Chromium/WhatsApp readiness or an invalid environment. Preserve the LocalAuth session; rebuild/restart first and clear only disposable cache when instructed. |
| Budget says no completed SMS scan | Companion's last-scan screen, `/health`, and `cloud-data/budget-data/android-sms-scan-state.json` | The final empty completion checkpoint did not reach this running server. Confirm phone Tailscale connectivity, URL, HMAC secret, server health, then sync again. |
| `curl 127.0.0.1:8787/health` fails on EC2 | `docker compose ... ps` and logs | The agent is stopped, still waiting for WhatsApp readiness, restarting, or using the wrong network/bind configuration. The SMS server starts as part of the agent; there is no second daemon to launch. |
| Google Tasks returns `invalid_grant` | Task OAuth token and logs | Refresh token was revoked/expired or belongs to the wrong client. Re-run the Tasks OAuth flow through the documented SSH tunnel and replace only its token. |
| Gemini returns 429/503 | Model name, retry information, quota dashboard, logs | 429 is quota/rate limiting; 503 is temporary model capacity. Deterministic routing and non-AI calculations remain available, while configured model fallbacks handle best-effort enrichment. |
| Stock report has missing analysts | JSON evidence/warnings and source diagnostics | Market/technical output can still be valid, but analyst coverage is incomplete. Do not silently reinterpret missing evidence as a bullish or bearish vote. |
| Duplicate WhatsApp actions | Verify only one agent is running; inspect message audit IDs | Local and EC2 copies, or two containers, may be consuming the same self-chat. Stop every extra copy before deleting any state. |
| Disk usage rises | `docker system df`, report/cache sizes, Docker logs | Logs are rotated, but old images and generated reports remain. Back up needed artifacts and prune explicit old targets—never delete the whole data directory. |

Logs deliberately describe control flow and minimized identifiers. New code must not log OAuth tokens, HMAC secrets, full unrelated SMS bodies, WhatsApp session contents, or decrypted cache dumps.

### 21.3 Dependency and schema update policy

- Commit `package-lock.json`; use `npm ci` in repeatable builds. Do not casually upgrade `whatsapp-web.js` or Chromium because WhatsApp Web injection behavior is version-sensitive.
- Pin Python ranges in `requirements.txt`, rebuild the image, run `npm run test:stock`, and smoke-test at least one ticker after market-data library changes.
- Treat the Android `versionCode`, payload `schemaVersion`, and server parser as a compatibility set. Deploy a server that accepts both old and new clients before distributing a breaking APK.
- Never change cryptographic canonicalization, key derivation, encrypted-envelope fields, or stored paths without a migration test using data produced by the previous version.
- Update one integration family at a time. A lock-file update containing unrelated major upgrades is difficult to diagnose and should be split.
- Before deployment, back up `cloud-data`; after deployment, run `cloud:check`, automated tests, then narrow smoke tests. Keep the previous Git commit/image reference available for rollback, but do not roll back persistent data blindly.

## 22. How to rebuild the system from zero

A novice recreating this architecture should work in this order:

1. Build and test pure policy functions first: chat scopes, intent outputs, ticker parser, budget authorization.
2. Add WhatsApp Web with persistent local authentication and a message audit log.
3. Add Gemini behind a structured JSON schema and a deterministic authorization layer.
4. Add Google Sheets with a service account, then Google Tasks with user OAuth.
5. Extract stock command handling into a serialized Node-to-Python boundary with a machine-readable result marker.
6. Implement the Android local filter and its JVM tests before granting real SMS access.
7. Define a versioned payload, HMAC canonical format, replay boundary, and server validation.
8. Add AES-GCM storage and full-scan checkpoints before calculating a budget.
9. Build transaction normalization, integer-paise totals, refunds, and conservative duplicate logic.
10. Add optional Gemini merchant projection only after raw financial correctness works without AI.
11. Add optional Gmail and Swiggy sources; never make them the sole financial truth.
12. Add HTML/WhatsApp outputs and Google Sheet persistence.
13. Add schedules with persisted idempotency state.
14. Containerize Chromium + Node + Python, run non-root, and mount mutable state.
15. Place the VM and phone in Tailscale; expose only the loopback SMS API through Serve.
16. Add readiness watchdogs, cache recovery, preflight validation, rotating logs, and backups.

At every stage, keep one source of truth for money, one authorization boundary for financial delivery, and tests that prove an unrelated input cannot enter the wrong workflow.

## 23. Alternatives and rejected shortcuts

| Shortcut/alternative | Why the current design did not choose it |
|---|---|
| Send all WhatsApp messages to Gemini | More private-data exposure, quota cost, latency, and cross-intent mistakes. |
| Let Gemini calculate spending totals | LLM arithmetic and hallucination are inappropriate for financial truth. |
| Store SMS as plaintext JSON | Convenient but unnecessarily exposes transaction evidence at rest. |
| Trust only the Android filter | A compromised/old client could send unsafe data; the server revalidates. |
| Trust only an API secret in the body | Secrets leak into logs and do not protect request integrity/replay. |
| Publicly open the SMS port | Creates avoidable internet attack surface. |
| Scrape logged-in Swiggy pages | Brittle, credential-heavy, and harder to secure than the read-only MCP. |
| Scrape paywalled news bodies | Legally/politically fragile, brittle, and unnecessary for public metadata scoring. |
| Use only source popularity for sentiment | A reputable source can still publish irrelevant content; relevance, freshness, corroboration, and noise are separate. |
| Use one generic multiple for every AI stock | NAND, foundries, photonics, power, and hyperscalers have different economics. |
| Run local and cloud agents together | Duplicates message processing and browser-session competition. |
| Put schedules in Windows Task Scheduler plus cron | Creates multiple start paths; one agent owns all server-side schedules. |
| Delete WhatsApp auth when readiness stalls | Forces unnecessary QR repair; disposable web cache is cleared separately. |

## 24. Extending the application safely

### Add a WhatsApp command

1. Decide which chat scopes are authorized.
2. Add deterministic phrase detection only if it is narrow and unambiguous.
3. Otherwise extend the Gemini schema/prompt.
4. Add an action to `resolveGeminiAction` that rechecks scope.
5. Execute it in `index.js` through a dedicated function/module.
6. Add tests for personal, cook, unrelated, generated reply, and ambiguous neighboring intents.

### Add a budget category

1. Add a stable machine key and display label.
2. Decide whether Gemini may assign it or it must be deterministic/reserved.
3. Add merchant/item evidence rules.
4. Decide whether it counts as expense; exclusions require an explicit accounting policy.
5. Test debit, refund, duplicate, WhatsApp summary, HTML, and old-report regeneration.

### Add a new financial source

1. Use read-only authorization.
2. Normalize into the common transaction model.
3. Never add its totals until reconciliation with existing financial truth is defined.
4. Encrypt private cache data.
5. Bound retention, record counts, timeouts, and payload sizes.
6. Make failures optional unless the source is explicitly declared mandatory.

### Add a market source

1. Use an official API or public metadata feed.
2. Record origin, URL, title, timestamp, and author without copying protected article bodies.
3. Normalize and deduplicate before scoring.
4. Assign a conservative source prior.
5. Require relevance/freshness/noise controls and deterministic tests.

## 25. Operational commands

Run Docker commands after entering the project directory on EC2:

```bash
cd /home/ubuntu/whatsApp-agent
```

Start:

```bash
docker compose --env-file .env.cloud up -d agent
```

Stop intentionally:

```bash
docker compose --env-file .env.cloud stop agent
```

Restart:

```bash
docker compose --env-file .env.cloud restart agent
```

Live logs:

```bash
docker compose --env-file .env.cloud logs -f --tail=100 agent
```

`Ctrl+C` exits the live log viewer but does not stop the agent. `exit` closes SSH but does not stop the agent.

## 26. Known limitations

- WhatsApp Web automation is unofficial and can require library/recovery updates.
- Gemini free quotas and model availability can change; fallback quality/coverage may differ.
- Nutrition is an estimate, especially when portion or recipe details are absent.
- Swiggy OAuth and exposed tools/windows are controlled by Swiggy and can expire/change.
- SMS coverage depends on Android permission, Tailscale connectivity, a matching HMAC secret, and a completed current-month checkpoint.
- Gmail and SMS templates evolve; conservative parsing may classify an unfamiliar merchant as Miscellaneous.
- Free cloud offers and instance eligibility change over time.
- Market feeds can be delayed, incomplete, duplicated, or unavailable. The stock report is research, not financial advice.

## 27. Final mental model

Think of the application as a guarded pipeline:

```text
Input
  → authenticate source
  → minimize private data
  → determine chat/source authority
  → deterministic shortcut or bounded AI interpretation
  → validate structured result
  → deterministic calculation/action
  → private persistence
  → authorized WhatsApp output
```

The central design principle is not “use AI everywhere.” It is “use AI only where language ambiguity benefits from it, and surround it with deterministic identity, privacy, validation, accounting, and delivery controls.”
