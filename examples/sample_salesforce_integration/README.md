# sample_salesforce_integration

A complete, runnable Ballerina + Salesforce integration that you can clone, configure, and run in a few minutes. Demonstrates both directions:

- **Publishing flow** — an HTTP service that maps inbound REST calls onto Salesforce CRUD operations (`create`, `getById`, `update`, `delete`, `query`).
- **Consuming flow** — a Change Data Capture (CDC) listener on `/data/AccountChangeEvent` and a Platform Event listener on `/event/Sample_Event__e`.

Realistic error handling is included: typed domain errors, retry-with-backoff for transient Salesforce failures, and proper HTTP status mapping (404, 400, 409, 502, 500).

---

## Endpoint cheat-sheet

**Publisher (REST) — port `9090`, backed by `sfClient`:**

| Method | Path | Action |
|--------|------|--------|
| GET | /health | Service health (`{"status":"UP"}`) |
| GET | /accounts | List recent Account records |
| POST | /accounts | Create an Account |
| GET | /accounts/{id} | Get an Account by ID |
| PUT | /accounts/{id} | Update an Account |
| DELETE | /accounts/{id} | Delete an Account |

**Consumer (events) — outbound CometD subscriptions, no inbound port:**

| Channel | Listener file | Handlers |
|---------|---------------|----------|
| `/data/AccountChangeEvent` | `cdc_account.bal` | onCreate / onUpdate / onDelete / onRestore |
| `/event/Sample_Event__e` | `event_sample.bal` | onMessage |

> Enable Account in **Setup → Change Data Capture**, or the CDC handshake is refused with `403::Handshake denied`. Worked examples for every endpoint are in [Try the publishing flow](#try-the-publishing-flow) and [Try the consuming flow](#try-the-consuming-flow) below.

---

## What's in the project

```
sample_salesforce_integration/
├── Ballerina.toml             # Package manifest (connector v8.7.0, dist 2201.12.0)
├── Config.toml.example        # Template — copy to Config.toml and fill in
├── .gitignore                 # Excludes Config.toml and build artefacts
├── main.bal                   # HTTP service + shared salesforce:Client
├── account.bal                # Account CRUD with classified errors and retries
├── cdc_account.bal            # CDC listener (consume Account changes)
├── event_sample.bal           # Platform event listener
├── errors.bal                 # Typed errors + retry helper + HTTP mapping
└── README.md
```

---

## Prerequisites

1. **Ballerina** distribution `2201.12.0` — install from [ballerina.io](https://ballerina.io/downloads/).
2. **A Salesforce Connected App** with:
   - OAuth scopes: `api`, `refresh_token`, `offline_access`
   - Callback URL: `https://login.salesforce.com/services/oauth2/success` (or any URL you control)
3. **A refresh token** for that Connected App. The MCP server can produce one for you:
   - Call `sf_get_oauth_auth_url` → open the URL → approve → copy the `?code=` value
   - Call `sf_exchange_oauth_code` → save the `refresh_token` and `instance_url`
4. **Change Data Capture enabled** for `Account` in Salesforce Setup → *Integrations* → *Change Data Capture* (only needed if you want the CDC listener to attach).
5. **(Optional)** A Platform Event named `Sample_Event__e` in Salesforce Setup → *Platform Events*, or rename the channel in `event_sample.bal` to match an existing event.
6. **Refresh Token Rotation OFF** on the Connected App — *Manage → Edit Policies → OAuth Policies* → uncheck **"Enable Refresh Token Rotation"** and set **Refresh Token Policy = "Refresh token is valid until revoked."** This sample runs the REST client **and** two event listeners, all sharing one refresh token; with rotation on they rotate it out from under each other (`invalid_grant` / `INVALID_SESSION_ID`).

---

## Configure

```bash
cp Config.toml.example Config.toml
# Edit Config.toml and paste in: clientId, clientSecret, refreshToken, baseUrl.
# For sandbox orgs, set refreshUrl to https://test.salesforce.com/services/oauth2/token.
```

Alternatively, run with environment variables (Config.toml not required):

```bash
export SF_CLIENT_ID=...
export SF_CLIENT_SECRET=...
export SF_REFRESH_TOKEN=...
export SF_REFRESH_URL=https://login.salesforce.com/services/oauth2/token
export SF_BASE_URL=https://myorg.my.salesforce.com
```

---

## Run

```bash
bal run
```

You should see:

```
Compiling source
        wso2bi/sample_salesforce_integration:1.0.0

Running executable

time=... level=INFO module=wso2bi/sample_salesforce_integration message="Initiating service(s) in 'sample_salesforce_integration'"
[ballerina/http] started HTTP/WS listener 0.0.0.0:9090
```

The CDC and platform-event listeners attach in the background. Any subsequent change to an Account in Salesforce will be logged within a few seconds.

If the platform event `Sample_Event__e` doesn't exist in your org, comment out `event_sample.bal` (or rename the channel) before running.

---

## Try the publishing flow

### Health check

```bash
curl -s http://localhost:9090/health | jq
```

```json
{
  "status": "UP",
  "package": "wso2bi/sample_salesforce_integration",
  "sf_api_version": "62.0"
}
```

### Create an Account

```bash
curl -s -X POST http://localhost:9090/accounts \
  -H "Content-Type: application/json" \
  -d '{ "Name": "Acme Corp", "Industry": "Technology", "BillingCity": "Colombo" }' | jq
```

Returns `201` with `{ "id": "001…", "success": true }`. Missing or empty `Name` returns `400` with a `VALIDATION_FAILED` body — caught locally, no Salesforce round-trip wasted.

### Fetch by ID

```bash
curl -s http://localhost:9090/accounts/001ABC123XYZ | jq
```

Unknown IDs return `404` with a `NOT_FOUND` body.

### List recent accounts

```bash
curl -s http://localhost:9090/accounts | jq
```

### Update

```bash
curl -s -X PUT http://localhost:9090/accounts/001ABC123XYZ \
  -H "Content-Type: application/json" \
  -d '{ "Industry": "Finance" }' | jq
```

### Delete

```bash
curl -s -X DELETE http://localhost:9090/accounts/001ABC123XYZ -o /dev/null -w "%{http_code}\n"
# → 204
```

---

## Try the consuming flow

### CDC events

1. Open Salesforce Setup → search for **Accounts** → create / edit / delete an Account.
2. Watch the service logs:

```
INFO  message="Account created (CDC)" payload={"Id":"001…","Name":"Acme Corp",…}
INFO  message="Account updated (CDC)" changed={"Industry":"Finance"}
INFO  message="Account Industry changed" industry="Finance"
```

CDC events only contain changed fields, so the sample defensively extracts `Industry` and only reacts when it's present.

### Platform events

Publish an event from Salesforce (via Workbench, Apex, or another integration):

```apex
Sample_Event__e ev = new Sample_Event__e(Customer_Id__c = '12345');
EventBus.publish(ev);
```

Service logs:

```
INFO  message="Platform event received" channel="/event/Sample_Event__e" payload={…}
```

---

## Error handling in this sample

| Failure | What the sample does | Caller sees |
|---|---|---|
| Missing required field (e.g. `Account.Name`) | Validated locally before any SF call | `400 VALIDATION_FAILED` |
| Salesforce returns `NOT_FOUND` / `ENTITY_IS_DELETED` / `MALFORMED_ID` | Classified to `RecordNotFound` | `404 NOT_FOUND` |
| Salesforce returns `DUPLICATE_VALUE` / `DUPLICATES_DETECTED` | Classified to `DuplicateRecord` | `409 DUPLICATE` |
| Salesforce returns `INVALID_FIELD`, `REQUIRED_FIELD_MISSING`, `FIELD_INTEGRITY_EXCEPTION`, `STRING_TOO_LONG` | Classified to `ValidationFailed` | `400 VALIDATION_FAILED` |
| `invalid_grant`, `invalid_client`, `INVALID_SESSION_ID`, `INSUFFICIENT_ACCESS` | Classified to `AuthFailed` | `502 UPSTREAM_AUTH_FAILED` |
| `REQUEST_LIMIT_EXCEEDED`, `SERVER_UNAVAILABLE`, `UNABLE_TO_LOCK_ROW`, network timeouts | `withRetry` retries with exponential backoff (default 3 attempts: 500ms → 1s → 2s) | success, or final error after exhausting retries |
| Unhandled error | Logged with stack, sanitized response | `500 INTERNAL` |
| CDC / platform-event handler throws | Logged with context; message is acknowledged so the channel keeps flowing | (n/a — consumer side) |

The retry policy is configurable per-deployment:

```toml
maxRetries     = 3
retryBackoffMs = 500
```

Non-transient errors (validation, not-found, auth) fail fast — there's no point retrying them.

---

## Where this fits with the MCP server

This project is exactly what `sf_quickstart` would scaffold for you, plus the polished error-handling layer in `errors.bal` and the documented HTTP-status mapping. Use it as:

- A reference for what well-structured Ballerina + Salesforce code looks like.
- A starting point you can clone and extend with additional SObjects (`sf_add_custom_object`) or additional CDC channels (`sf_add_cdc_listener`).
- A smoke-test target for your Connected App credentials before scaffolding a real production project.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `invalid_client` at startup | Connected App not yet active (wait 2–10 minutes after creating it) or wrong consumer key/secret. |
| `invalid_grant` at startup | Refresh token revoked or you're using a production token against `test.salesforce.com` (or vice versa). |
| `invalid_grant` / `INVALID_SESSION_ID` once it had worked, or only some listeners connect | **Refresh Token Rotation is ON** — disable it (Prerequisite 6). The REST client and listeners share one token; rotation invalidates it for all but the first consumer. |
| `Resource 'AccountChangeEvent' is not enabled` | Enable CDC for Account in Salesforce Setup. |
| `Resource '/event/Sample_Event__e' not found` | Create the Platform Event in your org, or comment out `event_sample.bal`. |
| Port 9090 already in use | Set `servicePort = 9100` in Config.toml. |
