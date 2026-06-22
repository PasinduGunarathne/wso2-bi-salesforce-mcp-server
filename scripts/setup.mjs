#!/usr/bin/env node
/**
 * One-shot setup: read all Salesforce + project config from .env, then drive the
 * MCP server (as a programmatic stdio client) through the full pipeline —
 *
 *   [sf_get_token_password_flow]  → only if no SF_REFRESH_TOKEN, but username+password given
 *   sf_quickstart                 → validate creds + scaffold + (optional) build
 *   sf_deploy_project             → start the service (unless --no-deploy)
 *
 * This reuses 100% of the real tool logic (validation, 0600 Config.toml, the
 * generator, build, deploy) — no duplicated business logic.
 *
 * Usage:
 *   cp .env.example .env   # fill it in
 *   npm run setup          # or: node scripts/setup.mjs [flags]
 *
 * Flags:
 *   --no-deploy            scaffold + build only; don't start the service
 *   --no-build             skip `bal build` during setup
 *   --no-rest-api          CDC-only project (no HTTP REST API); requires a CDC listener
 *   --cdc-only             alias for --no-rest-api
 *   --cdc-objects=A,B      add CDC listeners for the given SObjects (or =ALL)
 *   --all-cdc-changes      subscribe to /data/ChangeEvents (every CDC-enabled object)
 *   --no-cdc               skip the CDC consumer flow entirely
 *   --browser              force interactive browser OAuth (skip token/password)
 *   --yes / -y             auto-confirm prompts (CI / non-interactive)
 *   --refresh-only [--project=PATH]   mint a fresh token + rewrite Config.toml, then exit
 *
 * By default the script generates an HTTP REST API project and launches it via
 * sf_deploy_project (which mints a rotation-safe token immediately before run).
 * sf_quickstart is always called with run:false so there is exactly one launch.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVER = join(ROOT, "dist", "index.js");
const ENV_FILE = join(ROOT, ".env");

// Long timeout: a cold `bal build` downloads the connector (can take minutes),
// and sf_deploy_project waits up to 90s for the listener banner.
const LONG_TIMEOUT_MS = 600_000;
// Mirrors DEFAULT_SERVICE_PORT in src/constants.ts — used only for the URL we
// print and the -CservicePort override when PORT isn't set in .env.
const DEFAULT_PORT = 9090;

const argv = process.argv.slice(2);
const args = new Set(argv);
const NO_DEPLOY = args.has("--no-deploy");
const NO_BUILD = args.has("--no-build");
const FORCE_BROWSER = args.has("--browser");
// Auto-confirm the "run the project now?" gate (for CI / non-interactive runs).
const AUTO_YES = args.has("--yes") || args.has("-y");
// `--refresh-only [--project=<path>]`: mint a fresh refresh token and rewrite an
// existing project's Config.toml, then exit (no scaffold/build/deploy). Use this
// right before a manual `bal run` so rotation doesn't leave a dead token behind.
const REFRESH_ONLY = args.has("--refresh-only");
const projectArg = (argv.find((a) => a.startsWith("--project=")) || "").split("=")[1];
// CDC consumer flow flags.
// --cdc-objects=Account,Contact  listen to specific SObjects
// --all-cdc-changes              subscribe to /data/ChangeEvents (every CDC-enabled object)
// --no-cdc                       skip consumer flow entirely (also the default in --yes / non-TTY)
const cdcArg = (argv.find((a) => a.startsWith("--cdc-objects=")) || "").split("=")[1];
const ALL_CDC_CHANGES = args.has("--all-cdc-changes");
const NO_CDC = args.has("--no-cdc");

// ── tiny dependency-free .env parser ────────────────────────────────────────
function loadEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

const fileEnv = loadEnvFile(ENV_FILE);
// Real process env wins over the file, so `SF_X=… npm run setup` can override.
const cfg = (k) => {
  const v = process.env[k] ?? fileEnv[k];
  return v === undefined || v === "" ? undefined : v;
};
const bool = (k, dflt) => {
  const v = cfg(k);
  if (v === undefined) return dflt;
  return /^(1|true|yes|on)$/i.test(v);
};

// ── helpers ─────────────────────────────────────────────────────────────────
const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};
const ok = (msg) => console.log(`✓ ${msg}`);
const step = (msg) => console.log(`\n▶ ${msg}`);

function textOf(res) {
  const t = res?.content?.find?.((c) => c.type === "text")?.text;
  return t ?? "";
}
function structured(res) {
  if (res?.structuredContent) return res.structuredContent;
  try {
    return JSON.parse(textOf(res));
  } catch {
    return {};
  }
}

async function call(client, name, toolArgs) {
  const res = await client.callTool({ name, arguments: toolArgs }, undefined, {
    timeout: LONG_TIMEOUT_MS,
  });
  const sc = structured(res);
  if (res.isError) {
    const e = sc?.error ?? {};
    const detail = e.message ?? textOf(res) ?? "unknown error";
    const hint = e.hint ? `\n  hint: ${e.hint}` : "";
    throw new Error(`${name} → ${e.code ?? "ERROR"}: ${detail}${hint}`);
  }
  return sc;
}

// Return true when an error is a recoverable Salesforce auth-grant failure —
// i.e. the stored refresh token is dead (rotated, revoked, or expired).
// We only retry AUTH_INVALID_GRANT; other AUTH_ codes (invalid client, access
// denied) indicate configuration problems that re-minting can't fix.
function isAuthGrantError(err) {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("auth_invalid_grant") ||
    msg.includes("invalid_grant") ||
    msg.includes("expired access/refresh token")
  );
}

// Open a URL in the user's default browser (best-effort, cross-platform).
function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

// Accept a full redirect URL, a bare ?code= value, a URL-encoded value, or even
// a base64-wrapped form — and recover the raw authorization code from any of them.
function extractCode(input) {
  let s = (input ?? "").trim();
  if (!s) return "";

  const fromCodeParam = (str) => {
    if (!str.includes("code=")) return null;
    try {
      const c = new URL(str).searchParams.get("code");
      if (c) return c; // URL parsing already decodes %XX
    } catch {
      /* not a full URL */
    }
    const m = str.match(/code=([^&\s]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };

  // 1) Full redirect URL or a "code=…" fragment.
  const direct = fromCodeParam(s);
  if (direct) return direct;

  // 2) A pure-base64 blob (no dots — real codes contain '.') may wrap the code
  //    or the whole redirect URL. Decode once and retry.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0) {
    try {
      const decoded = Buffer.from(s, "base64").toString("utf8").trim();
      if (decoded && decoded !== s && /code=|^aPrx|%[0-9A-Fa-f]{2}/i.test(decoded)) {
        const inner = fromCodeParam(decoded);
        if (inner) return inner;
        s = decoded; // fall through to URL-decode step
      }
    } catch {
      /* not valid base64 */
    }
  }

  // 3) A bare but URL-encoded value (e.g. ends with %3D) → decode it.
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try {
      return decodeURIComponent(s);
    } catch {
      /* leave as-is */
    }
  }

  return s;
}

// Set or replace a single KEY=value line in .env, preserving everything else.
function upsertEnv(file, key, value) {
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, "")}\n${line}\n`;
  writeFileSync(file, text);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

// Interactive browser OAuth: build URL → open browser → read code → exchange.
// Returns { refreshToken, instanceUrl }.
async function browserOAuth(client) {
  step("Starting browser OAuth (no password flow needed)…");
  const urlRes = await call(client, "sf_get_oauth_auth_url", {
    sf_client_id: clientId,
    sf_base_url: baseUrl, // builds the authorize URL against your My Domain host
  });
  const authUrl = urlRes.auth_url;
  const redirectUri = urlRes.redirect_uri;

  console.log("\nOpen this URL in your browser, log in, and approve access:\n");
  console.log(`  ${authUrl}\n`);
  if (openBrowser(authUrl)) ok("Opened your default browser");
  else console.log("(Couldn't auto-open a browser — copy the URL above manually.)");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let code = "";
  try {
    while (!code) {
      const answer = await rl.question(
        "\nAfter approving, paste the ?code= value (or the full redirect URL) here:\n> "
      );
      code = extractCode(answer);
      if (!code) console.log("  Didn't find a code — try pasting the full redirect URL.");
    }
  } finally {
    rl.close();
  }

  step("Exchanging the code for a refresh token…");
  const tok = await call(client, "sf_exchange_oauth_code", {
    sf_client_id: clientId,
    sf_client_secret: clientSecret,
    code,
    sf_base_url: baseUrl, // exchange at the same My Domain host the code came from
    redirect_uri: redirectUri,
  });
  if (!tok.refresh_token) {
    die(
      "Exchange returned no refresh_token. Ensure the Connected App has the " +
        "'Perform requests at any time (refresh_token, offline_access)' scope."
    );
  }
  return { refreshToken: tok.refresh_token, instanceUrl: tok.instance_url };
}

// Yes/no confirmation. Auto-yes with --yes/-y; in a non-interactive shell
// (no TTY) we can't prompt, so fall back to the given default.
async function confirm(question, defaultYes) {
  if (AUTO_YES) return true;
  if (!process.stdin.isTTY) return defaultYes;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    const answer = (await rl.question(`${question} ${hint} `)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// Mint a BRAND-NEW refresh token right before launch. Salesforce rotates the
// refresh token on every successful refresh (Refresh Token Rotation), so the
// token saved from a previous run — or even the one consumed by this run's own
// credential validation — is very likely dead by the time `bal run` starts.
// The password (ROPC) flow needs no browser and does not depend on any prior
// refresh token, so it mints a fresh token family regardless of rotation state.
// Falls back to interactive browser OAuth when password creds aren't configured.
async function mintFreshToken(client) {
  if (!FORCE_BROWSER && username && password) {
    try {
      const tok = await call(client, "sf_get_token_password_flow", {
        sf_client_id: clientId,
        sf_client_secret: clientSecret,
        username,
        password,
        sf_base_url: baseUrl,
      });
      if (tok.refresh_token) {
        return { refreshToken: tok.refresh_token, instanceUrl: tok.instance_url };
      }
      console.warn("⚠️  Password flow returned no refresh_token — falling back to browser OAuth…");
    } catch (e) {
      const first = (e instanceof Error ? e.message : String(e)).split("\n")[0];
      console.warn(`⚠️  Password flow failed — ${first}\n   Falling back to browser OAuth…`);
    }
  }
  return browserOAuth(client);
}

// Resolve the WSO2 BI workspace dir the same way the MCP tool does, so the
// existence check below points at the directory sf_quickstart will scaffold.
function resolveBiPath(p) {
  const raw = p ?? join(homedir(), "WSO2Integrator");
  return raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
}

// Parse a CDC_OBJECTS value ("Account,Contact" or "ALL") into the cdc_listeners
// array shape that sf_quickstart / sf_add_cdc_listener expect.
function parseCdcObjects(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.toUpperCase() === "ALL") return [{ all_changes: true }];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((sobject) => ({ sobject }));
}

// Interactively ask whether to set up CDC listeners and, if so, which SObjects.
async function promptCdcConfig(suggestedObjects) {
  const wantCdc = await confirm(
    "\nSet up CDC event listeners (consumer flow — receive Salesforce change events)?",
    false
  );
  if (!wantCdc) return [];
  const dflt = (suggestedObjects ?? ["Account", "Contact", "Lead", "Opportunity"]).join(",");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\nSObjects to listen for changes (comma-separated), or ALL for every CDC-enabled object:\n[${dflt}]\n> `
    );
    const listeners = parseCdcObjects(answer.trim() || dflt);
    if (!listeners.length) console.log("  No listeners configured — skipping CDC.");
    return listeners;
  } finally {
    rl.close();
  }
}

// sf_quickstart requires a package name matching ^[a-z][a-z0-9_]*$ and refuses
// to overwrite an existing directory. Ask the user up front (defaulting to
// salesforce_integration), validating the name and re-prompting if the target
// already exists — far friendlier than the ALREADY_EXISTS error after auth.
const PKG_RE = /^[a-z][a-z0-9_]*$/;

// Non-interactive name resolver: derive a valid, free package name from `base`
// by sanitising it and appending _2, _3, … until the directory doesn't exist.
// Used in --yes / no-TTY runs where prompting would block forever — keeps the
// "no user involvement" promise even when the default name is already taken.
function uniqueProjectName(base, workspace) {
  let root = (base || "salesforce_integration")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^[^a-z]+/, "");
  if (!PKG_RE.test(root)) root = "salesforce_integration";
  if (!existsSync(join(workspace, root))) return root;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${root}_${i}`;
    if (!existsSync(join(workspace, candidate))) return candidate;
  }
  // Astronomically unlikely; fail loudly rather than loop forever.
  die(`Couldn't find a free project name under ${workspace} (tried ${root}_2…_999).`);
}

async function promptProjectName(envName, workspace) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let name = envName; // PROJECT_NAME from .env, if any, is the first candidate
    for (;;) {
      if (!name) {
        const answer = await rl.question(
          "\nBallerina project name to create in WSO2 Integrator " +
            "[salesforce_integration]:\n> "
        );
        name = answer.trim() || "salesforce_integration";
      }
      if (!PKG_RE.test(name)) {
        console.log(
          "  Invalid name — use lowercase letters/digits/underscore, " +
            "starting with a letter (e.g. salesforce_integration)."
        );
        name = "";
        continue;
      }
      if (existsSync(join(workspace, name))) {
        console.log(
          `  A project named "${name}" already exists in ${workspace} — pick another.`
        );
        name = "";
        continue;
      }
      return name;
    }
  } finally {
    rl.close();
  }
}

// Launch `bal run` in the FOREGROUND with inherited stdio, so the project's
// logs stream directly into the terminal where `npm run setup` was invoked and
// Ctrl+C stops the service. Resolves with the child's exit code. Uses BAL_BIN
// when set (Ballerina installed off-PATH, e.g. via bvm).
function runForeground(projectPath, servicePort) {
  return new Promise((resolve) => {
    const bin = process.env.BAL_BIN || "bal";
    const runArgs = ["run"];
    // Configurable overrides must follow a `--` separator: `bal run -- -Ckey=val`.
    // Without it, bal treats `-CservicePort=…` as a (nonexistent) package path
    // and aborts with "provided file path does not exist".
    if (servicePort) runArgs.push("--", `-CservicePort=${servicePort}`);
    const child = spawn(bin, runArgs, { cwd: projectPath, stdio: "inherit" });
    // Forward Ctrl+C to the child so it shuts the listeners down cleanly.
    const onSig = () => {
      try {
        child.kill("SIGINT");
      } catch {
        /* already gone */
      }
    };
    process.on("SIGINT", onSig);
    child.on("error", (err) => {
      process.off("SIGINT", onSig);
      console.error(
        `\n✗ Failed to start 'bal run': ${err.message}\n` +
          "  Is the 'bal' CLI installed and on PATH? Set BAL_BIN to override."
      );
      resolve(1);
    });
    child.on("exit", (code) => {
      process.off("SIGINT", onSig);
      resolve(code ?? 0);
    });
  });
}

// ── validate inputs ─────────────────────────────────────────────────────────
if (!existsSync(SERVER)) {
  die(`Server build not found at ${SERVER}\n  Run: npm run build`);
}
if (!existsSync(ENV_FILE)) {
  die(
    `No .env found at ${ENV_FILE}\n  Copy the template and fill it in:\n    cp .env.example .env`
  );
}
// Warn (don't fail) if the secrets file is readable by group/other.
try {
  if (statSync(ENV_FILE).mode & 0o077) {
    console.warn("⚠️  .env is readable by group/other — tighten it:  chmod 600 .env");
  }
} catch {
  /* best-effort */
}

const clientId = cfg("SF_CLIENT_ID") ?? die("SF_CLIENT_ID is required in .env");
const clientSecret = cfg("SF_CLIENT_SECRET") ?? die("SF_CLIENT_SECRET is required in .env");
let baseUrl = cfg("SF_BASE_URL") ?? die("SF_BASE_URL is required in .env");
let refreshToken = cfg("SF_REFRESH_TOKEN");
const username = cfg("SF_USERNAME");
const password = cfg("SF_PASSWORD");

// No hard auth requirement: if neither a token nor username/password is given
// (or --browser is passed), the script falls back to interactive browser OAuth.

let projectName = cfg("PROJECT_NAME"); // may be prompted for below if it collides
const orgName = cfg("ORG_NAME");
const biPath = cfg("BI_PATH");
const port = cfg("PORT") ? Number(cfg("PORT")) : undefined;
const targetObjects = cfg("TARGET_OBJECTS")
  ? cfg("TARGET_OBJECTS").split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;
const sandbox = cfg("SANDBOX") !== undefined ? bool("SANDBOX", false) : undefined;
const build = NO_BUILD ? false : bool("BUILD", true);
// REST_API controls whether the scaffolded project exposes an HTTP REST API
// (health + CRUD routes bound to PORT). Defaults to true so `npm run setup`
// produces the documented /accounts-style endpoints out of the box. Set
// REST_API=false (or pass --no-rest-api / --cdc-only) for a CDC-only project —
// which then REQUIRES at least one CDC listener (see the validation below).
const NO_REST_API = args.has("--no-rest-api") || args.has("--cdc-only");
const restApi = NO_REST_API ? false : bool("REST_API", true);

// ── run ───────────────────────────────────────────────────────────────────
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { ...process.env }, // pass HOME/PATH/TMPDIR/BAL_BIN through to the server
  stderr: "inherit",
});
const client = new Client({ name: "ballerina-salesforce-setup", version: "1.0.0" });

try {
  await client.connect(transport);
  ok("Connected to the MCP server");

  // 0 — refresh-only mode: mint a fresh token, rewrite the project's Config.toml,
  //     and exit so the user can run `bal run` themselves with a live token.
  if (REFRESH_ONLY) {
    const target = projectArg ?? cfg("PROJECT_PATH");
    if (!target) {
      die(
        "--refresh-only needs the project directory:\n" +
          "  npm run refresh-token -- --project=/path/to/your/ballerina/project"
      );
    }
    step("Minting a fresh refresh token (rotation-safe)…");
    const fresh = await mintFreshToken(client);
    refreshToken = fresh.refreshToken;
    if (fresh.instanceUrl) baseUrl = fresh.instanceUrl;
    upsertEnv(ENV_FILE, "SF_REFRESH_TOKEN", refreshToken);
    await call(client, "sf_write_config_toml", {
      project_path: target,
      sf_client_id: clientId,
      sf_client_secret: clientSecret,
      sf_refresh_token: refreshToken,
      sf_base_url: baseUrl,
    });
    ok(`Config.toml in ${target} updated with a fresh token (also saved to .env).`);
    console.log(`\n▶ Now run:  cd "${target}" && bal run\n`);
    await client.close().catch(() => {});
    process.exit(0);
  }

  // 1 — ensure we have a refresh token: token → password (→ browser) → browser
  let obtainedToken = false;
  if (FORCE_BROWSER) {
    const r = await browserOAuth(client);
    refreshToken = r.refreshToken;
    if (r.instanceUrl) baseUrl = r.instanceUrl;
    obtainedToken = true;
  } else if (refreshToken) {
    ok("Using SF_REFRESH_TOKEN from .env");
  } else if (username && password) {
    step("Obtaining a refresh token via the password flow…");
    try {
      const tok = await call(client, "sf_get_token_password_flow", {
        sf_client_id: clientId,
        sf_client_secret: clientSecret,
        username,
        password,
        sf_base_url: baseUrl,
      });
      if (!tok.refresh_token) throw new Error("password flow returned no refresh_token");
      refreshToken = tok.refresh_token;
      if (tok.instance_url) baseUrl = tok.instance_url;
      obtainedToken = true;
      ok("Refresh token obtained via password flow (no browser needed)");
    } catch (e) {
      const first = (e instanceof Error ? e.message : String(e)).split("\n")[0];
      console.warn(`\n⚠️  Password flow failed — ${first}`);
      console.warn("   Falling back to browser OAuth…");
      const r = await browserOAuth(client);
      refreshToken = r.refreshToken;
      if (r.instanceUrl) baseUrl = r.instanceUrl;
      obtainedToken = true;
    }
  } else {
    const r = await browserOAuth(client);
    refreshToken = r.refreshToken;
    if (r.instanceUrl) baseUrl = r.instanceUrl;
    obtainedToken = true;
  }

  // Persist a freshly obtained token so subsequent runs are fully non-interactive.
  if (obtainedToken && refreshToken) {
    upsertEnv(ENV_FILE, "SF_REFRESH_TOKEN", refreshToken);
    ok("Saved SF_REFRESH_TOKEN to .env — future `npm run setup` runs skip auth");
  }

  // 2 — choose a project name (prompt unless a free PROJECT_NAME was given)
  const workspace = resolveBiPath(biPath);
  const envNameFree =
    projectName && PKG_RE.test(projectName) && !existsSync(join(workspace, projectName));
  if (!envNameFree) {
    if (projectName) {
      console.warn(
        `\n⚠️  PROJECT_NAME "${projectName}" is invalid or already exists in ${workspace}.`
      );
    }
    // Non-interactive (--yes or no TTY): auto-derive a free name instead of
    // prompting, which would block an unattended run indefinitely.
    if (AUTO_YES || !process.stdin.isTTY) {
      projectName = uniqueProjectName(projectName, workspace);
      ok(`Auto-selected free project name "${projectName}" (non-interactive)`);
    } else {
      projectName = await promptProjectName(undefined, workspace);
    }
    ok(`Will create project "${projectName}" in ${workspace}`);
  }

  // 2.5 — consumer flow: resolve CDC listener configuration.
  //   Priority: CLI flag > .env CDC_OBJECTS > interactive prompt (TTY only)
  //   --no-cdc / AUTO_YES without explicit config → skip silently (no prompt).
  let cdcListeners = [];
  if (!NO_CDC) {
    if (ALL_CDC_CHANGES) {
      cdcListeners = [{ all_changes: true }];
      ok("Consumer flow: /data/ChangeEvents (all CDC-enabled objects)");
    } else if (cdcArg) {
      cdcListeners = parseCdcObjects(cdcArg);
      ok(`Consumer flow: ${cdcListeners.map((l) => l.sobject).join(", ")}`);
    } else {
      const cdcEnv = cfg("CDC_OBJECTS");
      if (cdcEnv) {
        cdcListeners = parseCdcObjects(cdcEnv);
        ok(`Consumer flow: ${cdcListeners.map((l) => l.all_changes ? "ALL changes" : l.sobject).join(", ")} (from CDC_OBJECTS)`);
      } else if (process.stdin.isTTY && !AUTO_YES) {
        cdcListeners = await promptCdcConfig(targetObjects);
        if (cdcListeners.length) {
          ok(`Consumer flow: ${cdcListeners.map((l) => l.all_changes ? "ALL changes" : l.sobject).join(", ")}`);
        }
      }
    }
    // Platform events (additive — can combine with object CDC listeners)
    const peEnv = cfg("CDC_PLATFORM_EVENTS");
    if (peEnv) {
      const platformEvents = peEnv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((platform_event) => ({ platform_event }));
      cdcListeners = [...cdcListeners, ...platformEvents];
      ok(`Platform events: ${platformEvents.map((l) => l.platform_event).join(", ")}`);
    }
  }

  // 2.6 — guard the CDC-only combination before we touch Salesforce.
  //   sf_quickstart rejects rest_api=false with no listeners (a portless project
  //   with nothing to keep the runtime alive would init and immediately exit).
  //   Catch it here with an actionable message rather than the raw INVALID_INPUT.
  if (!restApi && cdcListeners.length === 0) {
    die(
      "REST_API=false produces a CDC-only project, but no CDC listeners are configured.\n" +
        "  Either set CDC_OBJECTS in .env (e.g. CDC_OBJECTS=Account,Contact),\n" +
        "  pass --cdc-objects=Account, or leave REST_API=true (the default) to\n" +
        "  generate the HTTP REST API instead."
    );
  }

  // 3 — validate + scaffold (+ optional build). We pass run:false so quickstart
  //   only validates + scaffolds + (optionally) builds. The actual `bal run` is
  //   deferred to step 4 (sf_deploy_project), which mints a fresh, rotation-safe
  //   token immediately before launch — letting quickstart auto-run here would
  //   start the service with a token that Salesforce rotates out from under it.
  //
  // If the stored refresh token has been rotated or revoked since it was saved
  // to .env (very common with Refresh Token Rotation enabled), sf_quickstart
  // returns AUTH_INVALID_GRANT at the validation stage — before any files are
  // written, so a retry is always safe. We mint a fresh token automatically
  // (password flow = no user interaction; browser OAuth only if necessary) and
  // retry once. Anything that isn't an auth-grant error propagates immediately.
  step(
    `Running sf_quickstart (${restApi ? "REST API" : "CDC-only"}` +
      `${build ? ", with bal build" : ""})…`
  );

  const quickstartArgs = () => ({
    sf_client_id: clientId,
    sf_client_secret: clientSecret,
    sf_refresh_token: refreshToken,
    sf_base_url: baseUrl,
    ...(projectName ? { project_name: projectName } : {}),
    ...(orgName ? { org_name: orgName } : {}),
    ...(biPath ? { bi_path: biPath } : {}),
    ...(targetObjects ? { target_objects: targetObjects } : {}),
    ...(port ? { port } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(cdcListeners.length ? { cdc_listeners: cdcListeners } : {}),
    rest_api: restApi,
    run: false, // step 4 owns the launch (rotation-safe token minted just-in-time)
    build,
  });

  let quick;
  try {
    quick = await call(client, "sf_quickstart", quickstartArgs());
  } catch (firstErr) {
    if (!isAuthGrantError(firstErr)) throw firstErr;

    // The stored token is dead. Mint silently (password flow first) and retry.
    console.warn(
      "\n⚠️  Stored refresh token rejected by Salesforce — minting a fresh one automatically…"
    );
    const fresh = await mintFreshToken(client);
    refreshToken = fresh.refreshToken;
    if (fresh.instanceUrl) baseUrl = fresh.instanceUrl;
    upsertEnv(ENV_FILE, "SF_REFRESH_TOKEN", refreshToken);
    ok("Fresh token obtained and saved to .env — retrying sf_quickstart…");

    quick = await call(client, "sf_quickstart", quickstartArgs());
  }
  const projectPath = quick.project_path;
  ok(`Project scaffolded at ${projectPath}`);
  if (quick.connection?.username) {
    ok(`Connected as ${quick.connection.username} (org ${quick.connection.org_id})`);
  }
  if (quick.ballerina_version_warning) {
    console.warn(`⚠️  ${quick.ballerina_version_warning}`);
  }
  if (quick.build) {
    quick.build.success
      ? ok("bal build succeeded")
      : die(`bal build failed:\n${quick.build.output}`);
  }
  if (quick.cdc_channels?.length) {
    ok(`CDC listeners scaffolded: ${quick.cdc_channels.join(", ")}`);
  }

  // 4 — deploy. Setup (scaffold + build) is now complete. Running the project
  //     actually starts `bal run`, and each start triggers a Salesforce
  //     refresh-token rotation when Refresh Token Rotation is enabled — so we
  //     stop here and ask before consuming the token, unless told otherwise.
  console.log("\n✅ Setup complete (project scaffolded and built).");
  const runNow =
    !NO_DEPLOY &&
    (await confirm(
      "\nStart the project now (bal run)?\n" +
        "  Note: each run rotates the Salesforce refresh token if Refresh Token\n" +
        "  Rotation is enabled — the launcher mints a fresh one each time.",
      true
    ));

  if (!runNow) {
    step(NO_DEPLOY ? "Skipping deploy (--no-deploy)." : "Not starting the project (your choice).");
    console.log(
      `\nWhen you're ready, refresh the rotated token then run:\n` +
        `  npm run refresh-token -- --project="${projectPath}"\n` +
        `  cd "${projectPath}" && bal run`
    );
  } else {
    // Refresh-Token Rotation: mint a brand-new token immediately before launch
    // and rewrite Config.toml. The token validation/build used above may already
    // have been rotated by Salesforce, so we never trust it for the actual run.
    step("Minting a fresh refresh token for launch (rotation-safe)…");
    const fresh = await mintFreshToken(client);
    refreshToken = fresh.refreshToken;
    if (fresh.instanceUrl) baseUrl = fresh.instanceUrl;
    upsertEnv(ENV_FILE, "SF_REFRESH_TOKEN", refreshToken);
    await call(client, "sf_write_config_toml", {
      project_path: projectPath,
      sf_client_id: clientId,
      sf_client_secret: clientSecret,
      sf_refresh_token: refreshToken,
      sf_base_url: baseUrl,
    });
    ok("Config.toml refreshed with a fresh token (also saved to .env)");

    // Hand the terminal to `bal run` in the FOREGROUND so the project's logs
    // stream right here. The MCP client/server have done their job (scaffold,
    // build, token write), so close them first to free the spawned server.
    await client.close().catch(() => {});

    const launchPort = port ?? DEFAULT_PORT;
    console.log("");
    if (quick.rest_api) {
      ok(`Starting the service on http://localhost:${launchPort}`);
      console.log(`   Health: http://localhost:${launchPort}/health`);
      if (quick.cdc_channels?.length) {
        console.log(
          `   CDC:    ${quick.cdc_channels.join(", ")} — if they log invalid_grant,\n` +
            `           visit http://localhost:${launchPort}/auth/reauth to reauthorize (no restart).`
        );
      }
    } else {
      ok("Starting the CDC integration (no HTTP port bound)");
    }
    console.log("   Logs stream below — press Ctrl+C to stop.\n");

    // REST projects bind a port; pass the override so it matches what we printed.
    // CDC-only projects bind nothing — launch without -CservicePort.
    const exitCode = await runForeground(
      projectPath,
      quick.rest_api ? launchPort : undefined
    );
    process.exit(exitCode);
  }

  console.log("");
} catch (err) {
  die(err instanceof Error ? err.message : String(err));
} finally {
  await client.close().catch(() => {});
}
