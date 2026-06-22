# wso2-bi-salesforce-mcp-server

MCP server that lets AI assistants set up, run, and manage **Ballerina + Salesforce** integrations inside a **WSO2 Integrator (BI)** workspace — from zero credentials to a running REST service in one conversation.

Gives AI assistants **20 tools** to acquire OAuth2 tokens, validate credentials, discover SObjects, scaffold Ballerina projects, add CDC/Platform Event listeners, build, deploy, and stop the integration service — without exposing a shell command interface.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | 18+ | Run the MCP server |
| [Ballerina](https://ballerina.io/downloads/) | `2201.12.0` (Swan Lake) | Build and run the generated projects. Exact match recommended — scaffolded projects pin this distribution, and `sf_check_prerequisites` warns on a mismatch. |
| [Git](https://git-scm.com/) | Any | Clone the repo |
| Salesforce org | Any edition | Developer Edition is free — [sign up](https://developer.salesforce.com/signup) |

> **You don't need Salesforce credentials yet.** The MCP tools walk you through creating a Connected App and getting a refresh token.
>
> **Salesforce org setting (if using username-password flow):** Setup → Identity → OAuth and OpenID Connect Settings → enable **"Allow OAuth Username-Password Flows"**. This is a one-time 30-second toggle. Not required if using browser OAuth (Path C).

---

## Setup Ballerina + Salesforce — simple steps

From zero to a running integration. Steps 1–2 are one-time; after that `npm run setup` does the rest.

### 1. Install the toolchain
- **Ballerina** `2201.x` (Swan Lake) — [ballerina.io/downloads](https://ballerina.io/downloads/) (`bal version` to check)
- **Node.js** 18+

### 2. One-time Salesforce setup (in your org → Setup)
1. **Create a Connected App** — App Manager → *New Connected App* → enable OAuth:
   - Callback URL: `https://<your-domain>.my.salesforce.com/services/oauth2/success`
   - Scopes: **`api`** and **`refresh_token (offline_access)`**
   - Save, wait 2–10 min, then copy the **Consumer Key** and **Consumer Secret**.
2. **Disable Refresh Token Rotation** *(do this if you'll run the publisher and CDC together)* — the Connected App → Manage → **Edit Policies → OAuth Policies** → uncheck **"Enable Refresh Token Rotation"** and set **Refresh Token Policy = "Refresh token is valid until revoked"**. With rotation ON, the REST client and the CDC listeners share one refresh token and rotate it out from under each other (`invalid_grant` / `INVALID_SESSION_ID`).
3. **Enable Change Data Capture** *(only for the consumer/event flow)* — Setup → **Change Data Capture** → add the objects you want events for (e.g. Account). Requires Developer/Enterprise/Unlimited/Performance edition.

### 3. Install + build the MCP server
```bash
npm install
npm run build
```

### 4. Configure and run
```bash
cp .env.example .env     # fill in Consumer Key/Secret, SF_BASE_URL, and one auth option
chmod 600 .env
npm run setup            # token → scaffold → bal build → run (live logs in your terminal)
```
`npm run setup` obtains a refresh token (refresh token → password → browser OAuth, in that order), scaffolds a Ballerina project under `~/WSO2Integrator/<name>`, runs `bal build`, then launches it in the **foreground with live logs** (Ctrl+C stops it).

Key `.env` knobs:

| Key | Controls |
|-----|----------|
| `TARGET_OBJECTS` | Objects exposed as REST CRUD — the **publisher** flow (default `Account,Contact,Lead,Opportunity`). |
| `CDC_OBJECTS` | Objects you receive change events for — the **consumer** flow. One object = one listener. |
| `REST_API` | `true` (default) builds the REST publisher API; `false` builds a CDC-only project. |

### 5. What you get
- **Publisher (REST API):** `GET/POST/PUT/DELETE /<object>` backed by the Salesforce connector — e.g. `curl http://localhost:9090/accounts`.
- **Consumer (CDC):** listeners that handle create/update/delete/restore events for your `CDC_OBJECTS`.
- **Self-heal:** if a token expires, open `http://localhost:9090/auth/reauth` once to reauthorize — no restart.

> ⚠️ Running the publisher **and** CDC together requires **Refresh Token Rotation OFF** (step 2.2). They share one refresh token; with rotation on, each invalidates the other.

---

## Installation

### 1. Clone or locate the project

```bash
# If you already have the project directory:
cd /path/to/wso2-bi-salesforce-mcp-server

# Or clone from source:
git clone <repo-url>
cd wso2-bi-salesforce-mcp-server
```

### 2. Install dependencies

```bash
npm install
```

### 3. Build the server

```bash
npm run build
```

This compiles TypeScript to `dist/`. The entry point is `dist/index.js`.

### 4. Verify the build

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js
```

You should see a JSON response listing all 20 tools.

---

## Default project paths (auto-detected)

Projects are scaffolded into your WSO2 Integrator workspace by default. **No configuration required.**

| Platform | Default `bi_path` |
|----------|--------------------|
| macOS / Linux | `~/WSO2Integrator` |
| Windows | `%USERPROFILE%\WSO2Integrator` |

If `~/WSO2Integrator` doesn't exist, the server will create the project inside it. You can always override the path in any tool that accepts `bi_path` or `project_path`.

---

## Adding the MCP to AI clients

Replace `/absolute/path/to/wso2-bi-salesforce-mcp-server` with the actual path on your machine.

### Claude Desktop

1. Open **Claude Desktop** → Settings → Developer → Edit Config, or open the config file directly:

   ```
   # macOS
   ~/Library/Application Support/Claude/claude_desktop_config.json

   # Windows
   %APPDATA%\Claude\claude_desktop_config.json
   ```

2. Add the server under `mcpServers`:

   ```json
   {
     "mcpServers": {
       "ballerina-salesforce": {
         "command": "node",
         "args": [
           "/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"
         ]
       }
     }
   }
   ```

3. Restart Claude Desktop. The 20 tools will appear automatically.

---

### Claude Code (CLI)

Claude Code uses **dedicated MCP config files**, not `settings.json`. MCP servers never go in `settings.json`.

#### Recommended — CLI commands (writes the correct file automatically)

```bash
# User scope — available in all your projects (recommended for personal use)
claude mcp add --scope user --transport stdio ballerina-salesforce -- \
  node /absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js

# Project scope — shared with your team via .mcp.json at the repo root
claude mcp add --scope project --transport stdio ballerina-salesforce -- \
  node /absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js
```

Verify:

```bash
claude mcp list
```

#### Manual — edit the config files directly

**User scope** (`~/.claude.json` — available in all your projects):

```json
{
  "mcpServers": {
    "ballerina-salesforce": {
      "command": "node",
      "args": ["/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"],
      "type": "stdio"
    }
  }
}
```

**Project scope** (`.mcp.json` at your **project root** — commit this to share with your team):

```json
{
  "mcpServers": {
    "ballerina-salesforce": {
      "command": "node",
      "args": ["/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"],
      "type": "stdio"
    }
  }
}
```

> **Note:** `~/.claude/.mcp.json` is not a valid path. User-scope MCP config lives in `~/.claude.json` (top-level key). Project-scope config lives in `.mcp.json` at the project root, not inside `.claude/`.

---

### Cursor

1. Open **Cursor** → Settings → Features → MCP (or `Cursor Settings > MCP`).
2. Click **Add new MCP server**.
3. Fill in:
   - **Name:** `ballerina-salesforce`
   - **Type:** `stdio`
   - **Command:** `node`
   - **Args:** `/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js`

Or add directly to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ballerina-salesforce": {
      "command": "node",
      "args": [
        "/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"
      ]
    }
  }
}
```

Restart Cursor after saving.

---

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "ballerina-salesforce": {
      "command": "node",
      "args": [
        "/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"
      ]
    }
  }
}
```

Restart Windsurf after saving.

---

### VS Code

**Continue.dev** — add to `~/.continue/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "ballerina-salesforce",
      "command": "node",
      "args": [
        "/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"
      ]
    }
  ]
}
```

**GitHub Copilot (VS Code MCP support)** — add to VS Code `settings.json`:

```json
{
  "github.copilot.mcp.servers": {
    "ballerina-salesforce": {
      "command": "node",
      "args": [
        "/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"
      ],
      "type": "stdio"
    }
  }
}
```

---

### Zed

Add to `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "ballerina-salesforce": {
      "command": {
        "path": "node",
        "args": [
          "/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"
        ]
      }
    }
  }
}
```

---

### OpenAI Codex CLI

Codex stores MCP servers in `~/.codex/config.toml` (TOML, not JSON). Add a `[mcp_servers.<name>]` block:

```toml
[mcp_servers.ballerina-salesforce]
command = "node"
args = ["/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"]
```

Or use the CLI (recent Codex versions):

```bash
codex mcp add ballerina-salesforce -- node /absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js
```

> ⚠️ Codex uses `mcp_servers` (with an underscore) — every other client in this guide uses `mcpServers` (camelCase). Restart Codex or start a new session after editing.

---

### Gemini CLI (Google)

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "ballerina-salesforce": {
      "command": "node",
      "args": [
        "/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"
      ]
    }
  }
}
```

Run `/mcp` inside a Gemini CLI session to confirm the server connected and list its tools.

---

### Cline (VS Code extension)

In VS Code, open the **Cline** panel → **MCP Servers** → **Configure MCP Servers**. That opens `cline_mcp_settings.json` — add:

```json
{
  "mcpServers": {
    "ballerina-salesforce": {
      "command": "node",
      "args": [
        "/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"
      ]
    }
  }
}
```

The server appears in Cline's MCP Servers list once saved.

---

### Goose, JetBrains AI Assistant, Warp & others

Any client that speaks MCP over stdio works — point it at `node <abs-path>/dist/index.js`. For example, **Goose** uses `~/.config/goose/config.yaml` (or `goose configure` → *Add Extension* → *Command-line Extension*):

```yaml
extensions:
  ballerina-salesforce:
    type: stdio
    cmd: node
    args:
      - /absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js
    enabled: true
```

For JetBrains AI Assistant, Warp, and similar tools, use their "Add MCP server" UI with the command/args from the [generic client](#any-mcp-compatible-client-generic) section below.

---

### HTTP mode (any agent)

Run the server as an HTTP endpoint — useful for remote agents, containers, or any client that supports HTTP-based MCP.

```bash
TRANSPORT=http PORT=3001 SF_MCP_HTTP_TOKEN=your-secret-token node dist/index.js
```

- MCP endpoint: `http://127.0.0.1:3001/mcp`
- Auth header: `Authorization: Bearer your-secret-token`
- Health check: `http://127.0.0.1:3001/healthz`

> ⚠️ Always set `SF_MCP_HTTP_TOKEN` in HTTP mode. The server warns on startup if it is missing.

### Any MCP-compatible client (generic)

The server uses **stdio transport** — the standard for local MCP servers.

- **Command:** `node`
- **Args:** `["/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"]`
- **Transport:** `stdio`
- **Protocol:** JSON-RPC 2.0 over stdin/stdout

---

## One-shot setup script (`.env` → running service)

Prefer to configure everything once and run a single command, instead of feeding values to the assistant one prompt at a time? Use the `.env`-driven setup script. It drives the MCP server programmatically through the full pipeline — **obtain a refresh token (if needed) → `sf_quickstart` (validate + scaffold + build) → `sf_deploy_project`** — reusing the exact same tool logic, with no AI in the loop.

The script gets a refresh token three ways, in order of preference:
1. **`SF_REFRESH_TOKEN`** in `.env` — used directly, fully non-interactive.
2. **`SF_USERNAME` + `SF_PASSWORD`** — password flow (needs the org toggle); if it fails, the script **automatically falls back to browser OAuth**.
3. **Neither set (or pass `--browser`)** — **interactive browser OAuth**: the script builds the auth URL against your My Domain host, **opens your browser**, you approve and paste the `?code=` (or the full redirect URL) back into the terminal, and it exchanges + **writes `SF_REFRESH_TOKEN` into `.env`** so future runs need no browser.

```bash
cp .env.example .env     # fill in your Salesforce config
chmod 600 .env           # it holds secrets
npm run setup            # or: ./setup.sh   (also installs + builds if needed)
```

**`.env` keys** (see `.env.example` for the annotated template):

| Key | Required | Description |
|-----|----------|-------------|
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | ✅ | Connected App Consumer Key / Secret |
| `SF_BASE_URL` | ✅ | e.g. `https://myorg.my.salesforce.com` |
| `SF_REFRESH_TOKEN` | one of these | Pre-obtained refresh token (works on any org) |
| `SF_USERNAME` + `SF_PASSWORD` | one of these | Used to auto-obtain a token via the password flow (needs the org toggle) |
| `PROJECT_NAME`, `ORG_NAME`, `BI_PATH`, `TARGET_OBJECTS`, `PORT`, `SANDBOX`, `BUILD` | — | Optional; sensible defaults applied |

**Flags:**
- `npm run setup -- --browser` — force the interactive browser OAuth flow (skip token/password).
- `npm run setup -- --no-deploy` — stop after build; start it yourself later.
- `npm run setup -- --no-build` — scaffold only, skip `bal build`.

**Auth tips:** the `SF_REFRESH_TOKEN` path works on any org. The password path is fully hands-off but needs *Setup → Identity → OAuth and OpenID Connect Settings → Allow OAuth Username-Password Flows* enabled — if it isn't, the script falls back to browser OAuth automatically. The browser path also works on any org (no toggle), and after the first run your token is saved to `.env` so it's non-interactive thereafter.

> The MCP server stays useful after this for conversational, iterative work — adding objects, CDC listeners, inspecting schemas. The script just automates the initial end-to-end setup.

---

## Usage guide

Once configured, interact with the tools through your AI assistant using natural language. The assistant calls the correct tools automatically.

### Quick start (one command)

The fastest path if you already have a Salesforce refresh token:

```
"Set up a Ballerina Salesforce integration. Client ID: 3MVG9..., Secret: ..., Refresh token: 5Aep..., Base URL: https://myorg.my.salesforce.com"
```

This single phrase triggers `sf_quickstart`, which:
1. Validates your credentials with a live Salesforce API call
2. Auto-detects sandbox vs production from the URL
3. Scaffolds a complete Ballerina project at `~/WSO2Integrator/salesforce_integration/`
4. Writes `Config.toml` with mode 0600 (owner read/write only)
5. Returns the project path and ready-to-run instructions

Say **"Also compile it"** to add `build: true` and verify the project compiles immediately.

---

### Starting from zero (full walkthrough)

If you don't have credentials yet, the assistant walks you through the full setup.

**Step 1 — Get the setup guide:**
```
"Show me the Salesforce setup guide"
"I'm new to Salesforce — where do I start?"
"What do I need to set up a Ballerina Salesforce integration?"
```

**Step 2 — Create a Connected App** (3 min, manual in Salesforce):
> The guide returned by `sf_setup_guide` gives you the exact steps. In short:
> 1. Salesforce → Setup → App Manager → **New Connected App**
> 2. Enable OAuth: scopes `api` + `refresh_token (offline_access)`, callback `https://login.salesforce.com/services/oauth2/success`
> 3. Save → copy **Consumer Key** and **Consumer Secret**
> 4. Wait 2–10 min for the app to activate

**Step 3 — Check prerequisites:**
```
"Check if Ballerina is installed"
"Are my prerequisites met?"
```

**Step 4 — Get an OAuth refresh token:**
```
"Get me an OAuth URL for client ID 3MVG9..."
```
Open the returned URL in a browser, approve access, copy the `?code=` value from the redirect URL, then:
```
"Exchange this OAuth code: aPrx..."
```
Save the returned `refresh_token` and `instance_url`.

**Step 5 — Scaffold and run:**
```
"Set up a Salesforce integration for my org. Client ID: 3MVG9..., Secret: ..., Refresh token: 5Aep..., Base URL: https://myorg.my.salesforce.com"
```

**Step 6 — Deploy:**
```
"Start the integration service"
"Deploy the Salesforce project"
```

**Step 7 — Stop when done:**
```
"Stop the integration service"
```

---

### Example prompts

```
"Show me the Salesforce integration setup guide."

"Check if Ballerina is installed and ready."

"Get me an OAuth authorization URL for client ID 3MVG9... — this is a sandbox org."

"Exchange this code: aPrxQ7... and give me the refresh token."

"Validate my Salesforce connection — client ID 3MVG9..., secret ..., token 5Aep..., URL https://myorg.my.salesforce.com"

"List all custom objects in my Salesforce org."

"Describe the Invoice__c object fields."

"Set up a Ballerina Salesforce integration project with my credentials."

"Set up the project and also include Account CDC listeners so I get notified of Account changes."

"Add a listener for the OrderConfirmed__e platform event to my existing project."

"Add the Product2 object to my existing Salesforce integration project."

"Add the My_Custom__c object to my project — here are my credentials."

"Build my Salesforce integration project and show me any errors."

"Start the Salesforce service on port 8080."

"Update Config.toml in my project with these new credentials — my token was rotated."

"Stop the Salesforce integration service."
```

---

## Quick Start Prompts

Copy one of these into your AI agent (Claude Desktop, Claude Code, Cursor, etc.) to go from zero to a running integration in one conversation.

> **⚠️ One-time Salesforce admin step required for Path A and Path B (takes 30 seconds):**
> Paths A and B use the Salesforce username-password OAuth flow, which is **disabled by default** since Salesforce Spring '22.
> Before running either path, enable it once in your org:
> **Salesforce Setup → Identity → OAuth and OpenID Connect Settings → ✅ Allow OAuth Username-Password Flows**
>
> If you cannot enable this (enterprise org policy), use **Path C** (browser OAuth) instead — it has no such restriction.

---

### 🆕 Path A — First-time setup

Use this when you have Salesforce credentials but no existing Postman collection. The agent will generate a credential wallet, scaffold the Ballerina project, and start the service.

```
Set up a complete Ballerina + Salesforce integration for me.

My Salesforce details:
- Client ID: <consumer_key>
- Client Secret: <consumer_secret>
- Base URL: https://myorg.my.salesforce.com
- Username: me@myorg.com
- Password: myPasswordSecurityToken
  (if your org uses a security token, append it to the password: myPasswordABC123)

Steps I want you to do:
1. Check prerequisites (bal CLI installed and version matches)
2. Generate a Postman collection and save it as my credential wallet
3. Use the returned credentials to run sf_quickstart (scaffold + build the project)
4. Deploy the service and tell me the PID and port
```

> 💡 After step 2 you'll have a `~/WSO2Integrator/Salesforce Integration.postman_collection.json` file. Keep it — it's your credential wallet for future sessions. You can also import it into the Postman app to get fresh access tokens at any time.

---

### 🔁 Path B — Returning user (credential wallet already exists)

Use this in any future session after Path A. No credentials to type — the agent reads everything from the saved file.

```
Set up my Ballerina + Salesforce integration.
My credential wallet is at ~/WSO2Integrator/Salesforce Integration.postman_collection.json

Steps:
1. Import credentials from that Postman file
2. Run sf_quickstart with the extracted credentials
3. Deploy the service and give me the PID and port
```

---

### 🌐 Path C — Browser OAuth (no password flow)

Use this if your org has the username-password flow disabled (common in enterprise orgs).

```
Set up my Ballerina + Salesforce integration using browser OAuth.

My Salesforce details:
- Client ID: <consumer_key>
- Client Secret: <consumer_secret>
- Base URL: https://myorg.my.salesforce.com

Steps:
1. Check prerequisites
2. Give me the OAuth authorization URL to open in my browser
3. After I paste back the auth code, exchange it for a refresh token
4. Run sf_quickstart to scaffold and build the project
5. Deploy the service
```

---

### Step-by-step workflow

**Fastest path — generate a Postman collection (first-time setup):**
```
1. sf_generate_postman_collection → give credentials once, auto-obtain token, save to ~/WSO2Integrator/*.postman_collection.json
2. sf_quickstart                  → validate + scaffold + (optional) build (ready_for_quickstart returned above)
3. sf_deploy_project              → start the service
4. sf_stop_project                → stop the service when done
```

**Fastest path — already have a Postman collection?**
```
1. sf_import_postman_credentials  → extract all credentials from .postman_collection.json
   (if token expired) sf_get_token_password_flow → get fresh token, no browser needed
2. sf_quickstart                  → validate + scaffold + (optional) build
3. sf_deploy_project              → start the service
4. sf_stop_project                → stop the service when done
```

**Starting from scratch (browser OAuth):**
```
1. sf_setup_guide          → first-time guide: Connected App setup, credential steps
2. sf_check_prerequisites  → verify bal CLI version + platform info
3. sf_get_oauth_auth_url   → generate authorization URL (open in browser)
4. sf_exchange_oauth_code  → trade the ?code= for a refresh_token
5. sf_quickstart           → validate + scaffold + (optional) build  ← one call does it all
6. sf_deploy_project       → start the service in the background
7. sf_stop_project         → stop the service when done
```

**Starting from scratch (no browser — username + password):**
```
1. sf_check_prerequisites       → verify Ballerina is installed
2. sf_get_token_password_flow   → username+password → refresh_token (no browser)
3. sf_quickstart                → validate + scaffold + build
4. sf_deploy_project            → start the service
5. sf_stop_project              → stop the service when done
```

Or broken out manually:
```
1. sf_setup_guide          → read the setup instructions
2. sf_check_prerequisites  → verify Ballerina is installed
3. sf_get_oauth_auth_url   → get the auth URL
4. sf_exchange_oauth_code  → exchange code → refresh_token
5. sf_validate_connection  → confirm credentials work
6. sf_list_sobjects        → discover SObjects in the org
7. sf_describe_sobject     → inspect field metadata for a specific object
8. sf_scaffold_project     → generate the Ballerina project
9. sf_build_project        → compile with bal build
10. sf_deploy_project      → start the service
11. sf_stop_project        → stop the service when done
```

---

## Tool reference

### Onboarding

#### `sf_setup_guide`
Returns a step-by-step guide for first-time users: how to create a Salesforce Connected App, obtain credentials, and which tools to call in order. Call this at the start of any Salesforce integration session.

```
"Show me the Salesforce setup guide"
"I've never set up a Salesforce Connected App — walk me through it"
"What scopes do I need for the Connected App?"
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sandbox` | boolean | `false` | Show sandbox (test.salesforce.com) variant |

---

#### `sf_check_prerequisites`
Verifies the `bal` CLI is installed and reports its version vs. the expected Ballerina distribution.

```
"Check if Ballerina is installed"
"Are my prerequisites met for the Salesforce integration?"
"What version of Ballerina do I have?"
```

No parameters. Returns: `bal_cli.available`, `bal_cli.version`, `bal_cli.expected_distribution`, `bal_cli.version_match` (and `bal_cli.version_warning` when the installed distribution doesn't match `2201.12.0`), `node_version`, `platform`, `recommended_action`.

---

### OAuth2 authentication

#### `sf_get_oauth_auth_url`
Generates a Salesforce OAuth2 authorization URL. Open it in a browser to approve access — you receive a `?code=` query parameter in the redirect URL.

The generated URL has the form:

```
https://<your-instance>/services/oauth2/authorize?response_type=code&client_id=<CONSUMER_KEY>&redirect_uri=<REDIRECT_URI>&scope=api%20refresh_token%20offline_access
```

**Pass `sf_base_url`** (your org / My Domain URL) so the authorize endpoint targets **your org's own host** — e.g. `https://myorg.my.salesforce.com/services/oauth2/authorize`. This is the correct host for **My Domain orgs** and avoids "log in via your My Domain" redirects. If you omit `sf_base_url`, the URL falls back to `login.salesforce.com` (or `test.salesforce.com` when `sandbox: true`). The `scope=api refresh_token offline_access` is always included — `offline_access` is what makes Salesforce return a refresh token.

```
"Get me an OAuth URL for client ID 3MVG9... — my org is https://myorg.my.salesforce.com"
"Generate a Salesforce authorization URL — this is a sandbox"
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sf_client_id` | string | **required** | Consumer Key from your Connected App |
| `sf_base_url` | string | — | **Recommended.** Org / My Domain URL. When set, the authorize URL (and the default redirect) use this host. |
| `redirect_uri` | string | `https://login.salesforce.com/services/oauth2/success` | Must match a callback registered in your Connected App. When `sf_base_url` is set and this is left at the default, it auto-aligns to `<your-host>/services/oauth2/success`. |
| `sandbox` | boolean | `false` | Use `test.salesforce.com` instead of `login.salesforce.com`. Ignored when `sf_base_url` is set. |

Returns: `auth_url` (open this in a browser), `redirect_uri` (the one actually used — pass the same to `sf_exchange_oauth_code`), `next_step`.

---

#### `sf_exchange_oauth_code`
Exchanges the `?code=` from the redirect URL for a long-lived **refresh token**.

> The short-lived `access_token` is intentionally masked in output — it's shown as `access_token_preview` only. You never need it directly; the other tools refresh automatically on demand.

```
"Exchange this OAuth code: aPrxQ7..."
"I got the code from the redirect URL — exchange it for a refresh token"
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sf_client_id` | string | **required** | Consumer Key |
| `sf_client_secret` | string | **required** | Consumer Secret |
| `code` | string | **required** | The `?code=` value from the redirect URL |
| `redirect_uri` | string | success URL | Same URI used in `sf_get_oauth_auth_url` |
| `sandbox` | boolean | `false` | Must match where the code was obtained |

Returns: `refresh_token` (**save this!**), `instance_url` (use as `sf_base_url` in all other tools).

**Common errors:**
- `AUTH_INVALID_GRANT` — code expired or already used; re-run `sf_get_oauth_auth_url`
- `AUTH_CONNECTED_APP_NOT_READY` — wait 2–10 min after creating the Connected App

---

### Validation & discovery

#### `sf_validate_connection`
Makes a live Salesforce API call to confirm credentials work before writing any files to disk.

```
"Validate my Salesforce connection"
"Test that my credentials work"
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sf_client_id` | string | Consumer Key |
| `sf_client_secret` | string | Consumer Secret |
| `sf_refresh_token` | string | Refresh token |
| `sf_base_url` | string | e.g. `https://myorg.my.salesforce.com` |

Returns: `connected`, `org_id`, `username`, `instance_url`, `is_sandbox`.

---

#### `sf_list_sobjects`
Lists all SObjects in your org. Supports filtering and pagination.

```
"List all custom objects in my Salesforce org"
"Show me all Account-related SObjects"
"What objects are available in my org?"
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| *credentials* | — | **required** | All 4 credential fields |
| `include_custom` | boolean | `true` | Include `__c` objects |
| `filter` | string | — | Substring filter on name or label |
| `limit` | integer | `50` | Max results (1–200) |
| `offset` | integer | `0` | Pagination offset |

Returns: `total`, `count`, `has_more`, `next_offset`, `sobjects[]`.

---

#### `sf_describe_sobject`
Returns full field metadata for a specific SObject — field names, types, nullability, and relationship references.

```
"Describe the Invoice__c object"
"What fields does the Account object have?"
"Show me the schema for My_Custom__c"
```

| Parameter | Type | Description |
|-----------|------|-------------|
| *credentials* | — | All 4 credential fields |
| `object_name` | string | SObject API name, e.g. `Account` or `My_Custom__c` |

Returns: `name`, `label`, `field_count`, `fields[]` with full type info.

---

### Project scaffolding

#### `sf_quickstart` ⭐ Start here
**One-shot setup:** validates credentials → auto-detects sandbox → scaffolds the Ballerina project → (optional) compiles.

This is the recommended entry point. Most users only need this one tool after exchanging their OAuth code.

```
"Set up a Ballerina Salesforce project with my credentials"
"Scaffold the Salesforce integration and compile it to check for errors"
"Set up the integration and also add Account and Contact CDC listeners"
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sf_client_id` | string | **required** | Consumer Key |
| `sf_client_secret` | string | **required** | Consumer Secret |
| `sf_refresh_token` | string | **required** | Refresh token |
| `sf_base_url` | string | **required** | e.g. `https://myorg.my.salesforce.com` |
| `project_name` | string | `salesforce_integration` | Ballerina package name |
| `org_name` | string | `wso2bi` | Ballerina org name in `Ballerina.toml` |
| `bi_path` | string | `~/WSO2Integrator` | WSO2 BI workspace root |
| `target_objects` | string[] | `["Account","Contact","Lead","Opportunity"]` | SObject API names to scaffold CRUD for |
| `cdc_listeners` | array | — | CDC / Platform Event listeners to add (see below) |
| `build` | boolean | `false` | Run `bal build` after scaffolding |
| `sandbox` | boolean | auto-detected | Override sandbox detection (detected from URL by default) |

**`cdc_listeners` entry — specify exactly one of:**

| Field | Type | Channel generated |
|-------|------|------------------|
| `sobject` | string | `/data/<SObject>ChangeEvent` |
| `all_changes` | boolean `true` | `/data/ChangeEvents` |
| `platform_event` | string (ends `__e`) | `/event/<Name>__e` |
| `events` | string[] | Which callbacks: `onCreate`, `onUpdate`, `onDelete`, `onRestore` (default: all four) |

Returns: `status`, `connection`, `project_path`, `files_created`, `standard_sobjects`, `custom_sobjects`, `cdc_channels`, `ballerina_version`, `next_steps`.

---

#### `sf_scaffold_project`
Granular alternative to `sf_quickstart` — scaffolds without the live credential validation step. Accepts the same parameters as `sf_quickstart` except `build`.

```
"Scaffold a Salesforce project — I've already validated my credentials"
"Create the project files for Account, Contact, and Invoice__c"
```

---

### Project management

#### `sf_write_config_toml`
Overwrites `Config.toml` in an existing project with new credentials. Use this after token rotation without re-scaffolding the whole project.

Written with **mode 0600** (owner read/write only). Sandbox is auto-detected from `sf_base_url`.

```
"Update the credentials in my existing project — my token was rotated"
"Rewrite Config.toml with these new values"
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `project_path` | string | Path to the existing Ballerina project |
| *credentials* | — | All 4 credential fields |

---

#### `sf_add_custom_object`
Adds a new SObject to an already-scaffolded project without re-scaffolding everything.

- **Standard SObjects:** creates `<object>.bal` referencing the pre-built type from `ballerinax/salesforce.types` — no `describe` API call needed.
- **Custom (`__c`) objects:** describes the schema live, appends a typed record to `types.bal`, and creates `<object>.bal`.

Returns: `files_updated[]`, `manual_step` (route snippet to paste into `main.bal`).

```
"Add the Product2 object to my existing project"
"Add Invoice__c to the project — here are my credentials"
"I need to support Asset in addition to what's already scaffolded"
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `project_path` | string | Path to the existing project |
| *credentials* | — | Required only for custom (`__c`) objects |
| `object_name` | string | SObject API name, e.g. `Invoice__c` |

---

#### `sf_add_cdc_listener`
Adds an event-driven listener file to an existing project. Generates a `.bal` file with handler stubs using the same OAuth2 credentials already in `main.bal` — no extra Config.toml entries needed.

```
"Add a CDC listener for Account changes to my project"
"Listen for all CDC-enabled object changes"
"Add a platform event listener for OrderConfirmed__e"
"Add an Account listener but only scaffold onCreate and onUpdate"
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `project_path` | string | Path to the existing project |
| `listener.sobject` | string | SObject name → channel `/data/<SObject>ChangeEvent` |
| `listener.all_changes` | boolean | All objects → channel `/data/ChangeEvents` |
| `listener.platform_event` | string (ends `__e`) | Platform event → channel `/event/<Name>__e` |
| `listener.events` | string[] | CDC callbacks to scaffold (default: all four) |

> Specify exactly one of `sobject`, `all_changes`, or `platform_event`.

> ⚠️ **CDC requires a Salesforce admin step:** Setup → Integrations → **Change Data Capture** → enable objects. The MCP server generates the Ballerina code but cannot enable CDC in Salesforce itself.

---

### Build & run

#### `sf_build_project`
Runs `bal build` in the project directory. Takes 30–90s on first build (downloads the connector from Ballerina Central). Reports the full compiler output.

```
"Build my Salesforce project"
"Compile the integration and show me any errors"
"Run bal build and check if everything is OK"
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `project_path` | string | Path to the Ballerina project |

Returns: `success`, `output` (full compiler output), `project_path`.

---

#### `sf_deploy_project`
Starts the Ballerina service in the background via `bal run`. Waits up to **90 seconds** for the HTTP listener banner (a cold `bal run` compiles before serving, which can take 30–120s). Ports are passed as configurable overrides so the reported `service_url` always matches the actual listener. The tool only reports an error if the process actually exits — a slow cold start is not treated as failure.

```
"Start the Salesforce integration service"
"Deploy the project on port 8080"
"Run the Ballerina service and give me the PID"
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `project_path` | string | **required** | Path to the project |
| `port` | integer | `9090` | HTTP listener port |

Returns: `pid` (**save this for `sf_stop_project`**), `started`, `service_url`, `health_check`, `output`, `message`.

**Endpoints once running:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns `{ status: "UP" }` |
| `GET` | `/<object>s` | Query all records (SOQL, LIMIT 200) |
| `GET` | `/<object>/{id}` | Get a single record by Salesforce ID |
| `POST` | `/<object>` | Create a record |
| `PUT` | `/<object>/{id}` | Update a record |
| `DELETE` | `/<object>/{id}` | Delete a record |

---

#### `sf_stop_project`
Stops a service started by `sf_deploy_project`. Only PIDs registered by this MCP server session can be stopped — it will not kill arbitrary system processes.

```
"Stop the Salesforce service"
"Kill the integration process with PID 12345"
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `pid` | integer | PID returned by `sf_deploy_project` |

---

### Postman & password-flow (no browser needed)

#### `sf_generate_postman_collection` ⭐ Generate a credential wallet
Takes your Salesforce credentials **once**, auto-obtains a refresh token via the password flow, and saves a ready-to-import **Postman Collection v2.1** to disk. That single file becomes your reusable credential wallet:

- **Use in Postman** — import and click "Get New Access Token" at any time, no configuration needed.
- **Use with this MCP** — pass the saved file to `sf_import_postman_credentials` in any future session. No copy-pasting, no browser flows, no repeated auth setup.

The generated collection includes three folders:
- 🔐 **Authentication** — Password Flow (no browser), Step 1-2 auth-code flow, and Token Refresh requests with auto-save test scripts
- 🔍 **Salesforce REST API** — Validate Connection, List SObjects, Describe Account, SOQL Query, Create Account
- 🔗 **Ballerina Integration Service** — Health Check, List/Create Accounts via the local Ballerina service

```
"Generate a Postman collection for my Salesforce org"
"Create a Salesforce Postman collection and save my credentials"
"Set up Postman for my Salesforce integration — username is me@myorg.com"
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sf_client_id` | string | **required** | Consumer Key from the Connected App |
| `sf_client_secret` | string | **required** | Consumer Secret |
| `sf_base_url` | string | **required** | e.g. `https://myorg.my.salesforce.com` |
| `username` | string | **required** | Salesforce username (email) |
| `password` | string | **required** | Password (append security token if required: `myPasswordABC123`) |
| `redirect_uri` | string | `https://login.salesforce.com/services/oauth2/success` | Redirect URI registered in your Connected App |
| `collection_name` | string | `Salesforce Integration` | Display name for the Postman collection |
| `output_path` | string | `~/WSO2Integrator/<collection_name>.postman_collection.json` | Where to save the file |

Returns: `collection_saved_to` (file path), `ready_for_quickstart` (use directly with `sf_quickstart`), `refresh_token_obtained` (true/false).

**One-time Salesforce Setup requirement** (same as `sf_get_token_password_flow`):
> Setup → Identity → **OAuth and OpenID Connect Settings** → enable **"Allow OAuth Username-Password Flows"**

---

#### `sf_import_postman_credentials` ⭐ Fastest onboarding
Reads a `.postman_collection.json` file and extracts every Salesforce credential it can find — `clientId`, `clientSecret`, `refreshToken`, `instanceUrl`, `username`, `password` — from the collection-level OAuth2 block and individual request bodies. No copy-pasting required.

Returns a `ready_for_quickstart` block you can pass directly to `sf_quickstart`.
If the refresh token is expired, it tells you exactly which tool to call next (`sf_get_token_password_flow`).

```
"Import credentials from my Postman collection at ~/Documents/MCP-servers/wso2-bi-salesforce-mcp-server/_BalSFConnector.postman_collection.json"
"Read my Postman collection and set up the integration"
"Extract Salesforce credentials from ~/Downloads/MyOrg.postman_collection.json and validate them"
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `postman_file` | string | **required** | Absolute or `~`-relative path to the `.postman_collection.json` file |
| `validate` | boolean | `true` | Make a live Salesforce API call to confirm extracted credentials work |

Returns: `credentials_found` (secrets masked), `ready_for_quickstart` block, `password_flow_args` (if username+password present but no refresh token), `next_action` guidance.

**What it extracts from the Postman file:**

| Postman location | Fields extracted |
|-----------------|-----------------|
| Collection `auth.oauth2` | `clientId`, `clientSecret`, `username`, `password`, `instanceUrl`, `redirectUri` |
| Request body (urlencoded) | `refresh_token`, `client_id`, `client_secret` |
| Request URL (query params) | `client_id`, `client_secret`, `redirect_uri` |

---

#### `sf_get_token_password_flow`
Gets a Salesforce OAuth2 refresh token using **username + password only — no browser, no auth code redirect**.

```
"Get a Salesforce refresh token using my username and password — no browser"
"Use the username/password from my Postman collection to get a refresh token"
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sf_client_id` | string | Consumer Key from the Connected App |
| `sf_client_secret` | string | Consumer Secret |
| `username` | string | Salesforce username (email) |
| `password` | string | Password. If your org uses a security token, append it directly: `myPassword` + `ABC123` → `myPasswordABC123` |
| `sf_base_url` | string | e.g. `https://myorg.my.salesforce.com` |

Returns: `refresh_token`, `instance_url`, `ready_for_quickstart` block.

**One-time Salesforce Setup requirement** (30 seconds):
> Setup → Identity → **OAuth and OpenID Connect Settings** → enable **"Allow OAuth Username-Password Flows"**

**Common errors:**

| Error | Cause | Fix |
|-------|-------|-----|
| `authentication failure` | Wrong password or missing security token | Append security token to password |
| `invalid_client_credentials` | Wrong `client_id` or `client_secret` | Check the Connected App's Consumer Key/Secret |
| `unsupported_grant_type` | Username-password flow not enabled | Enable it in Setup → Identity → OAuth and OpenID Connect Settings |
| No `refresh_token` returned | Connected App missing `offline_access` scope | Add "Perform requests at any time (refresh_token, offline_access)" scope |

---

## Generated project structure

```
~/WSO2Integrator/salesforce_integration/
├── Ballerina.toml          # Package: ballerinax/salesforce@8.7.0, dist 2201.12.0
├── Config.toml             # Mode 0600, gitignored — credentials + port
├── .gitignore              # Excludes Config.toml, target/, .ballerina/, Dependencies.toml
├── main.bal                # HTTP service + salesforce:Client + configurable vars
├── types.bal               # Custom __c typed records (empty if no custom objects)
├── account.bal             # Account CRUD: query, getById, create, update, delete
├── contact.bal             # Contact CRUD
├── lead.bal                # Lead CRUD
├── opportunity.bal         # Opportunity CRUD
├── cdc_account.bal         # (if requested) CDC listener for Account changes
├── event_order__e.bal      # (if requested) Platform event listener for Order__e
└── README.md               # Auto-generated project usage docs
```

### Standard vs custom SObjects

| SObject type | Record type source | Describe API call? | Entry in types.bal? |
|---|---|---|---|
| Standard (`Account`, `Contact`, …) | `ballerinax/salesforce.types` pre-built | ❌ No | ❌ No |
| Custom (`My_Object__c`) | Generated from live describe | ✅ Yes | ✅ Yes |

Using pre-built types means standard SObjects need zero describe calls during scaffolding — the project generates in seconds regardless of how many standard objects you include.

> **Credentials & environment variables** for the generated project are documented in detail in the [Configuration](#configuration) section below.

---

## Sample project

A complete, runnable reference project is included at `examples/sample_salesforce_integration/`. It demonstrates both integration flows with production-quality error handling:

```
examples/sample_salesforce_integration/
├── Ballerina.toml             # connector v8.7.0, dist 2201.12.0
├── Config.toml.example        # copy to Config.toml and fill in your credentials
├── .gitignore
├── main.bal                   # HTTP service + shared salesforce:Client
├── account.bal                # Account CRUD with error classification + retry
├── cdc_account.bal            # CDC consumer flow (/data/AccountChangeEvent)
├── event_sample.bal           # Platform event consumer flow (/event/Sample_Event__e)
├── errors.bal                 # Typed errors, retry helper, HTTP status mapping
└── README.md                  # Run instructions, curl examples, troubleshooting
```

**Publishing flow** — `POST /accounts` → `sfClient->create()`, `GET /accounts/{id}` → `sfClient->getById()`, etc.

**Consuming flow** — `salesforce:Listener` on `/data/AccountChangeEvent` with `onCreate`, `onUpdate`, `onDelete`, `onRestore` stubs, and a separate listener on `/event/Sample_Event__e` with `onMessage`.

**Error handling** — typed errors (`RecordNotFound`, `ValidationFailed`, `DuplicateRecord`, `AuthFailed`), HTTP status mapping (404/400/409/502/500), `withRetry` with exponential back-off for transient Salesforce errors (`REQUEST_LIMIT_EXCEEDED`, etc.).

```bash
cd examples/sample_salesforce_integration
cp Config.toml.example Config.toml
# fill in credentials
bal run
```

---

## MCP server project structure

```
wso2-bi-salesforce-mcp-server/
├── src/
│   ├── index.ts                   # Entry point — server factory, stdio + HTTP transports
│   ├── types.ts                   # Shared TypeScript types, ToolError, error codes, maskSecret
│   ├── constants.ts               # SF constants, URL validation, sandbox detection, versions
│   ├── schemas/
│   │   └── tools.ts               # Zod schemas for all 20 tool inputs
│   ├── services/
│   │   ├── salesforce.ts          # Token management, SObject describe/list, validateConnection
│   │   ├── filesystem.ts          # writeFile, balBuild, balRun, checkBalCli, expandPath
│   │   └── generator.ts           # Ballerina code generators (main.bal, types.bal, CDC listeners)
│   └── tools/
│       ├── oauth.ts               # sf_get_oauth_auth_url, sf_exchange_oauth_code
│       ├── salesforce.ts          # sf_setup_guide, sf_check_prerequisites, sf_validate_connection,
│       │                          #   sf_list_sobjects, sf_describe_sobject
│       ├── ballerina.ts           # sf_quickstart, sf_scaffold_project, sf_write_config_toml,
│       │                          #   sf_add_custom_object, sf_add_cdc_listener,
│       │                          #   sf_build_project, sf_deploy_project, sf_stop_project
│       └── postman.ts             # sf_generate_postman_collection, sf_import_postman_credentials, sf_get_token_password_flow
├── examples/
│   └── sample_salesforce_integration/   # Complete runnable reference project
├── dist/                          # Compiled JavaScript (git-ignored)
├── package.json
├── tsconfig.json
└── README.md
```

---

## Configuration

There are two distinct layers of configuration: **(1) the MCP server itself** (how the Node process runs) and **(2) the generated Ballerina project** (how the integration authenticates to Salesforce at runtime). They're separate — you rarely touch the server config, while the project config is written for you by the tools.

### 1. MCP server — environment variables

Set these on the `node dist/index.js` process (e.g. in your MCP client config's `env` block, or your shell). All are optional.

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSPORT` | `stdio` | Transport mode: `stdio` (local clients) or `http` (remote/containers). |
| `PORT` | `3001` | HTTP listener port — **HTTP mode only**. |
| `SF_MCP_HTTP_TOKEN` | — | Bearer token required on all `/mcp` requests in HTTP mode. The server warns on startup if unset. **Strongly recommended** for any non-localhost use. |
| `BAL_BIN` | `bal` | Absolute path to the `bal` binary — useful when Ballerina is installed but not on `PATH` (e.g. via bvm). |
| `SF_MCP_ALLOWED_ROOTS` | `$HOME`, `$TMPDIR` | Colon-separated extra directories that `project_path` / `bi_path` are permitted to resolve under. Add a path here to scaffold outside your home directory. |

Example — pinning a `bal` binary and an extra project root in a Claude Desktop config:

```json
{
  "mcpServers": {
    "ballerina-salesforce": {
      "command": "node",
      "args": ["/absolute/path/to/wso2-bi-salesforce-mcp-server/dist/index.js"],
      "env": {
        "BAL_BIN": "/Users/me/.ballerina/bin/bal",
        "SF_MCP_ALLOWED_ROOTS": "/data/projects"
      }
    }
  }
}
```

### 2. Generated project — `Config.toml`

Every scaffolded project gets a `Config.toml` in its root, written with **mode `0600`** (owner read/write only) and git-ignored. The MCP tools populate it for you — this reference is for when you want to edit or rotate it by hand. Each key maps to a `configurable` variable in `main.bal`.

| Key | Type | Example | Description |
|-----|------|---------|-------------|
| `clientId` | string | `"3MVG9..."` | Connected App Consumer Key. |
| `clientSecret` | string | `"ABCD..."` | Connected App Consumer Secret. |
| `refreshToken` | string | `"5Aep861..."` | Long-lived OAuth2 refresh token. The connector mints short-lived access tokens from this at runtime. |
| `refreshUrl` | string | `"https://login.salesforce.com/services/oauth2/token"` | Token endpoint. Auto-set to `login.` (production) or `test.` (sandbox) based on `sf_base_url`. |
| `baseUrl` | string | `"https://myorg.my.salesforce.com"` | Your org instance URL. |
| `apiVersion` | string | `"62.0"` | Salesforce REST API version the connector targets. |
| `servicePort` | int | `9090` | HTTP listener port for the generated service. |

> To rotate credentials without re-scaffolding, prefer the `sf_write_config_toml` tool — it re-writes the file with mode `0600` and re-detects sandbox vs. production for you.

#### Runtime credential sources (precedence)

`main.bal` reads each credential from `Config.toml` first, falling back to an environment variable if the file value is absent. The same project therefore runs unchanged across environments:

| Environment | How credentials are supplied |
|-------------|------------------------------|
| Local dev | `Config.toml` in the project root |
| Docker / WSO2 BI runtime | Env vars: `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_REFRESH_TOKEN`, `SF_REFRESH_URL`, `SF_BASE_URL` |
| CI | Either — `Config.toml` takes precedence when present |

> The port can also be overridden at launch without editing the file: `bal run -CservicePort=8080` (this is exactly what `sf_deploy_project` does with its `port` parameter).

---

## Development

```bash
# Rebuild after changes
npm run build

# Watch mode (recompiles on save)
npm run dev

# Clean and rebuild
rm -rf dist && npm run build
```

To add a new tool:
1. Add the Zod schema to `src/schemas/tools.ts`
2. Add the handler in the appropriate file under `src/tools/`
3. Register it with `server.registerTool(...)` in that file's register function
4. Run `npm run build`

---

## Security

### Credential protection
- **Hostname allow-list:** `sf_base_url` is validated against `*.salesforce.com`, `*.force.com`, `*.cloudforce.com`, and `*.salesforce-setup.com` before any credential is sent. Arbitrary URLs are rejected — prevents SSRF and credential exfiltration.
- **`Config.toml` written with mode `0600`:** Only the owning user can read it. Enforced on every write including credential rotation.
- **Token masking:** `sf_exchange_oauth_code` masks the short-lived `access_token` in its output. Only the `refresh_token` is shown (it's the one you need to save).

### Path safety
- All user-supplied paths (`project_path`, `bi_path`) are resolved and verified to lie under `$HOME` or `$TMPDIR`. Path traversal attempts (`../../etc/passwd`) throw `PATH_TRAVERSAL` immediately.

### Process safety
- `sf_deploy_project` registers spawned PIDs in-process. `sf_stop_project` only terminates PIDs it started — it refuses to kill arbitrary system processes.

### HTTP transport
- Binds to `127.0.0.1` only — no external exposure by default.
- Set `SF_MCP_HTTP_TOKEN` to require `Authorization: Bearer <token>` on every `/mcp` request.
- `/healthz` is always unauthenticated (returns server name and version only).

### Structured error codes

Every tool error returns a machine-readable `code` field so agents can handle failures precisely:

| Code | Meaning |
|------|---------|
| `AUTH_INVALID_GRANT` | Refresh token revoked or wrong endpoint (production vs sandbox) |
| `AUTH_CONNECTED_APP_NOT_READY` | New Connected App still activating — wait 2–10 min |
| `AUTH_INVALID_CLIENT` | Wrong Consumer Key or Secret |
| `INVALID_URL` | `sf_base_url` failed hostname allow-list check |
| `PATH_TRAVERSAL` | Path resolves outside allowed roots |
| `NOT_FOUND` | Project directory or file not found |
| `ALREADY_EXISTS` | Project or module file already exists |
| `BAL_CLI_MISSING` | `bal` not on PATH — check `BAL_BIN` env var |
| `BAL_BUILD_FAILED` | Compilation failed — see `output` field |
| `PRECONDITION_FAILED` | Required file missing (e.g. `Config.toml` before deploy) |
| `TRANSIENT` | Network error — check connectivity and retry |
| `INVALID_INPUT` | Validation error (e.g. invalid SObject name format) |
| `UNKNOWN` | Unexpected error |

---

## Troubleshooting

### `AUTH_CONNECTED_APP_NOT_READY` on first use
Salesforce Connected Apps take **2–10 minutes to activate** after creation. Wait and retry `sf_exchange_oauth_code` or `sf_validate_connection`.

### `bal` not found
```bash
which bal      # should print a path like /usr/local/bin/bal
bal version    # should print Ballerina 2201.12.0 (Swan Lake)
```
If missing, install from [ballerina.io/downloads](https://ballerina.io/downloads/). If `bal` is installed but not on `PATH`:
```bash
BAL_BIN=/path/to/bal node dist/index.js
```

### First `bal build` is slow
The first build downloads `ballerinax/salesforce@8.7.0` from Ballerina Central. Ensure you have internet access and allow up to 3 minutes. Subsequent builds use the local cache.

### CDC events not arriving
1. Enable CDC for the object: Salesforce Setup → Integrations → **Change Data Capture** → select your object → Save.
2. CDC requires Enterprise, Unlimited, Performance, or Developer Edition.
3. Ensure OAuth scopes include `api` and `refresh_token`.

### Platform event listener fails to start
The channel `/event/YourEvent__e` must exist in your org before the listener can attach. Create the Platform Event in Salesforce Setup → Platform Events.

### Service starts but `/health` returns connection refused
The 90-second startup window elapsed before the listener banner was detected — a cold `bal run` compiles before serving. The service may still be starting; wait a few more seconds and retry. Check the `output` field in the `sf_deploy_project` result for compiler or bind errors.

### `PATH_TRAVERSAL` error
Your `project_path` or `bi_path` resolves outside `$HOME` or `$TMPDIR`. Use a path inside your home directory, or run with extra roots:
```bash
SF_MCP_ALLOWED_ROOTS=/data/projects node dist/index.js
```

### Token expired mid-session
Access tokens are short-lived (~2 hours). The connector refreshes them automatically using the stored `refresh_token`. If you see `INVALID_SESSION_ID` errors, the refresh token itself may have been revoked — re-run `sf_get_oauth_auth_url` and `sf_exchange_oauth_code` to get a new one, then call `sf_write_config_toml` to update the project without re-scaffolding.
