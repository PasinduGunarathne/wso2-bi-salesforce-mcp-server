/**
 * Postman-integration tools.
 *
 * sf_generate_postman_collection  — given Salesforce credentials, auto-obtains a
 *   refresh token (password flow) and generates a ready-to-import Postman
 *   collection saved to disk. The same file can later be fed to
 *   sf_import_postman_credentials for zero-input project setup.
 *
 * sf_import_postman_credentials   — reads a .postman_collection.json and extracts
 *   credentials ready for sf_quickstart.
 *
 * sf_get_token_password_flow      — username+password → refresh_token, no browser.
 */
import fs from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GeneratePostmanCollectionSchema,
  ImportPostmanCredentialsSchema,
  GetTokenPasswordFlowSchema,
  GeneratePostmanCollectionInput,
  ImportPostmanCredentialsInput,
  GetTokenPasswordFlowInput,
} from "../schemas/tools.js";
import { safeResolve, writeFile } from "../services/filesystem.js";
import {
  getTokenPasswordFlow,
  validateConnection,
} from "../services/salesforce.js";
import {
  validateSalesforceUrl,
  SF_LOGIN_URL,
  SF_SANDBOX_LOGIN_URL,
  SF_API_VERSION,
} from "../constants.js";
import { asStructured, errorResult, maskSecret, ToolError } from "../types.js";
import type { ToolResult } from "../types.js";

// ─── Postman collection v2.1 builder ─────────────────────────────────────────

interface PostmanKV {
  key: string;
  value: string | boolean;
  type: string;
  disabled?: boolean;
  description?: string;
}

interface PostmanBodyKV {
  key: string;
  value: string;
  type: "text";
  description?: string;
}

function urlParts(fullUrl: string): {
  protocol: string;
  host: string[];
  path: string[];
} {
  try {
    const u = new URL(fullUrl);
    return {
      protocol: u.protocol.replace(":", ""),
      host: u.hostname.split("."),
      path: u.pathname.split("/").filter(Boolean),
    };
  } catch {
    return { protocol: "https", host: [], path: [] };
  }
}

/** Postman test-script that auto-saves tokens to collection variables. */
const TOKEN_SAVE_SCRIPT = `
const res = pm.response.json();
if (res.access_token) {
    pm.collectionVariables.set("access_token", res.access_token);
    console.log("✓ access_token saved to collection variable");
}
if (res.refresh_token) {
    pm.collectionVariables.set("refresh_token", res.refresh_token);
    console.log("✓ refresh_token saved to collection variable");
}
if (res.instance_url) {
    pm.collectionVariables.set("instance_url", res.instance_url);
    console.log("✓ instance_url saved to collection variable");
}
if (res.error) {
    console.error("✗ Error:", res.error, res.error_description ?? "");
}
`.trim();

const AUTH_URL_SCRIPT = `
// Open the auth URL in a browser — after approving, copy the ?code= parameter
// and paste it into Step 2's 'code' field, then send that request.
console.log("Open this URL in a browser:\\n" + pm.request.url.toString());
`.trim();

/**
 * Build a complete Postman Collection v2.1 object from Salesforce credentials.
 */
function buildPostmanCollection(opts: {
  name: string;
  clientId: string;
  clientSecret: string;
  instanceUrl: string;
  refreshToken: string | null;
  username: string;
  password: string;
  redirectUri: string;
  sandbox: boolean;
  apiVersion?: string;
}): Record<string, unknown> {
  const loginHost = opts.sandbox ? SF_SANDBOX_LOGIN_URL : SF_LOGIN_URL;
  const tokenUrl = `${loginHost}/services/oauth2/token`;
  const authUrl = `${loginHost}/services/oauth2/authorize`;
  const instanceTokenUrl = `${opts.instanceUrl}/services/oauth2/token`;
  const apiBase = `${opts.instanceUrl}/services/data/v${opts.apiVersion ?? SF_API_VERSION}`;

  // ── Collection variables (populated at generation time if tokens available) ─
  const variables: Array<{ key: string; value: string; type: string; description?: string }> = [
    {
      key: "instance_url",
      value: opts.instanceUrl,
      type: "string",
      description: "Your Salesforce org instance URL — auto-updated by token requests.",
    },
    {
      key: "access_token",
      value: "",
      type: "string",
      description: "Short-lived access token — auto-updated by the token requests below.",
    },
    {
      key: "refresh_token",
      value: opts.refreshToken ?? "",
      type: "string",
      description:
        "Long-lived refresh token. Auto-updated by token requests. " +
        (opts.refreshToken
          ? "Pre-filled from auto-obtained token during collection generation."
          : "Run 'Step 2' or 'Password Flow' to populate this."),
    },
    {
      key: "client_id",
      value: opts.clientId,
      type: "string",
      description: "Connected App Consumer Key.",
    },
    {
      key: "client_secret",
      value: opts.clientSecret,
      type: "string",
      description: "Connected App Consumer Secret.",
    },
    {
      key: "username",
      value: opts.username,
      type: "string",
      description: "Salesforce username (email).",
    },
  ];

  // ── Helper to build a urlencoded POST body ─────────────────────────────────
  const urlencodedBody = (fields: PostmanBodyKV[]) => ({
    mode: "urlencoded",
    urlencoded: fields,
  });

  // ── Requests ───────────────────────────────────────────────────────────────
  const items: unknown[] = [
    // ── FOLDER: Authentication ───────────────────────────────────────────────
    {
      name: "🔐 Authentication",
      description:
        "OAuth2 flows to obtain and refresh Salesforce access tokens.\n\n" +
        "Run 'Password Flow' first (no browser needed) to populate {{refresh_token}}.\n" +
        "Use 'Step 1 → Step 2' if the password flow is disabled on your org.",
      item: [
        // Password flow — fastest, no browser
        {
          name: "Password Flow — Get Tokens (No Browser)",
          event: [
            { listen: "test", script: { type: "text/javascript", exec: TOKEN_SAVE_SCRIPT.split("\n") } },
          ],
          request: {
            method: "POST",
            header: [{ key: "Content-Type", value: "application/x-www-form-urlencoded" }],
            body: urlencodedBody([
              { key: "grant_type", value: "password", type: "text", description: "Use password grant" },
              { key: "client_id", value: "{{client_id}}", type: "text" },
              { key: "client_secret", value: "{{client_secret}}", type: "text" },
              { key: "username", value: "{{username}}", type: "text" },
              {
                key: "password",
                value: opts.password,
                type: "text",
                description: "If your org requires a security token, append it: myPassword+securityToken",
              },
            ]),
            url: { raw: instanceTokenUrl, ...urlParts(instanceTokenUrl) },
            description:
              "Gets access_token + refresh_token using username+password — no browser needed.\n\n" +
              "Requires: Setup → Identity → OAuth and OpenID Connect Settings → " +
              "'Allow OAuth Username-Password Flows' = ON.\n\n" +
              "Tokens are auto-saved to {{access_token}}, {{refresh_token}}, {{instance_url}}.",
          },
          response: [],
        },

        // Step 1 — Auth URL (open in browser)
        {
          name: "Step 1 — Open Auth URL in Browser",
          event: [
            { listen: "prerequest", script: { type: "text/javascript", exec: AUTH_URL_SCRIPT.split("\n") } },
          ],
          request: {
            method: "GET",
            header: [],
            url: {
              raw: `${authUrl}?response_type=code&client_id={{client_id}}&redirect_uri=${encodeURIComponent(opts.redirectUri)}&scope=api%20refresh_token%20offline_access`,
              ...urlParts(authUrl),
              query: [
                { key: "response_type", value: "code" },
                { key: "client_id", value: "{{client_id}}" },
                { key: "redirect_uri", value: opts.redirectUri },
                { key: "scope", value: "api refresh_token offline_access" },
              ],
            },
            description:
              "Copy the full URL from Postman and open it in a browser.\n" +
              "After logging in and approving, Salesforce redirects to your redirect_uri with ?code=XXXX.\n" +
              "Copy that code and paste it into Step 2.",
          },
          response: [],
        },

        // Step 2 — Exchange auth code
        {
          name: "Step 2 — Exchange Auth Code for Tokens",
          event: [
            { listen: "test", script: { type: "text/javascript", exec: TOKEN_SAVE_SCRIPT.split("\n") } },
          ],
          request: {
            method: "POST",
            header: [{ key: "Content-Type", value: "application/x-www-form-urlencoded" }],
            body: urlencodedBody([
              { key: "grant_type", value: "authorization_code", type: "text" },
              { key: "client_id", value: "{{client_id}}", type: "text" },
              { key: "client_secret", value: "{{client_secret}}", type: "text" },
              { key: "code", value: "PASTE_AUTH_CODE_FROM_STEP_1_HERE", type: "text", description: "Replace with the ?code= value from the Step 1 redirect URL" },
              { key: "redirect_uri", value: opts.redirectUri, type: "text" },
            ]),
            url: { raw: tokenUrl, ...urlParts(tokenUrl) },
            description:
              "Replace PASTE_AUTH_CODE_FROM_STEP_1_HERE with the code from Step 1.\n" +
              "Tokens are auto-saved to collection variables on success.",
          },
          response: [],
        },

        // Step 3 — Refresh access token
        {
          name: "Step 3 — Refresh Access Token",
          event: [
            { listen: "test", script: { type: "text/javascript", exec: TOKEN_SAVE_SCRIPT.split("\n") } },
          ],
          request: {
            method: "POST",
            header: [{ key: "Content-Type", value: "application/x-www-form-urlencoded" }],
            body: urlencodedBody([
              { key: "grant_type", value: "refresh_token", type: "text" },
              { key: "client_id", value: "{{client_id}}", type: "text" },
              { key: "client_secret", value: "{{client_secret}}", type: "text" },
              { key: "refresh_token", value: "{{refresh_token}}", type: "text", description: "Auto-populated from collection variable" },
            ]),
            url: { raw: instanceTokenUrl, ...urlParts(instanceTokenUrl) },
            description:
              "Refreshes {{access_token}} using {{refresh_token}}.\n" +
              "Run this whenever you get a 401 from the API requests below.\n" +
              "New access_token is auto-saved to {{access_token}}.",
          },
          response: [],
        },
      ],
    },

    // ── FOLDER: Salesforce REST API ──────────────────────────────────────────
    {
      name: "🔍 Salesforce REST API",
      description: "Direct Salesforce REST API calls. All use {{access_token}} — run a token request first.",
      item: [
        // Validate connection
        {
          name: "Validate Connection (Identity)",
          request: {
            method: "GET",
            header: [{ key: "Authorization", value: "Bearer {{access_token}}" }],
            url: {
              raw: `${opts.instanceUrl}/services/oauth2/userinfo`,
              ...urlParts(`${opts.instanceUrl}/services/oauth2/userinfo`),
            },
            description: "Returns org_id, username, and instance_url. Use this to confirm {{access_token}} is valid.",
          },
          response: [],
        },

        // List SObjects
        {
          name: "List SObjects",
          request: {
            method: "GET",
            header: [{ key: "Authorization", value: "Bearer {{access_token}}" }],
            url: {
              raw: `${apiBase}/sobjects`,
              ...urlParts(`${apiBase}/sobjects`),
            },
            description: "Lists all SObjects available in the org.",
          },
          response: [],
        },

        // Describe Account
        {
          name: "Describe Account",
          request: {
            method: "GET",
            header: [{ key: "Authorization", value: "Bearer {{access_token}}" }],
            url: {
              raw: `${apiBase}/sobjects/Account/describe`,
              ...urlParts(`${apiBase}/sobjects/Account/describe`),
            },
            description: "Returns full field metadata for the Account object.",
          },
          response: [],
        },

        // SOQL query
        {
          name: "SOQL — Query Accounts",
          request: {
            method: "GET",
            header: [{ key: "Authorization", value: "Bearer {{access_token}}" }],
            url: {
              raw: `${apiBase}/query?q=SELECT+Id,Name+FROM+Account+LIMIT+10`,
              ...urlParts(`${apiBase}/query`),
              query: [{ key: "q", value: "SELECT Id,Name FROM Account LIMIT 10" }],
            },
            description: "Sample SOQL query. Edit the 'q' parameter for your use case.",
          },
          response: [],
        },

        // Create Account
        {
          name: "Create Account",
          request: {
            method: "POST",
            header: [
              { key: "Authorization", value: "Bearer {{access_token}}" },
              { key: "Content-Type", value: "application/json" },
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({ Name: "Test Account from Ballerina Integration" }, null, 2),
              options: { raw: { language: "json" } },
            },
            url: {
              raw: `${apiBase}/sobjects/Account`,
              ...urlParts(`${apiBase}/sobjects/Account`),
            },
            description: "Creates a new Account record.",
          },
          response: [],
        },
      ],
    },

    // ── FOLDER: Ballerina Service ────────────────────────────────────────────
    {
      name: "🔗 Ballerina Integration Service",
      description:
        "Calls to the locally-running Ballerina service started by sf_deploy_project.\n" +
        "Default base URL: http://localhost:9090",
      item: [
        {
          name: "Health Check",
          request: {
            method: "GET",
            header: [],
            url: { raw: "http://localhost:9090/health", ...urlParts("http://localhost:9090/health") },
            description: "Verify the Ballerina service is running.",
          },
          response: [],
        },
        {
          name: "List Accounts (via Ballerina)",
          request: {
            method: "GET",
            header: [],
            url: { raw: "http://localhost:9090/accounts", ...urlParts("http://localhost:9090/accounts") },
            description: "Calls the Ballerina REST service to query Account records.",
          },
          response: [],
        },
        {
          name: "Create Account (via Ballerina)",
          request: {
            method: "POST",
            header: [{ key: "Content-Type", value: "application/json" }],
            body: {
              mode: "raw",
              raw: JSON.stringify({ Name: "Created via Ballerina Integration" }, null, 2),
              options: { raw: { language: "json" } },
            },
            url: { raw: "http://localhost:9090/account", ...urlParts("http://localhost:9090/account") },
            description: "Creates an Account via the Ballerina service.",
          },
          response: [],
        },
      ],
    },
  ];

  // ── Collection-level OAuth2 (enables "Get New Access Token" in Postman GUI) ─
  const oauth2: PostmanKV[] = [
    { key: "tokenName", value: "SalesforceToken", type: "string" },
    { key: "challengeAlgorithm", value: "S256", type: "string" },
    { key: "grant_type", value: "authorization_code", type: "string" },
    { key: "authUrl", value: authUrl, type: "string" },
    { key: "accessTokenUrl", value: instanceTokenUrl, type: "string" },
    { key: "clientId", value: opts.clientId, type: "string" },
    { key: "clientSecret", value: opts.clientSecret, type: "string" },
    { key: "redirect_uri", value: opts.redirectUri, type: "string" },
    { key: "username", value: opts.username, type: "string" },
    { key: "password", value: opts.password, type: "string" },
    { key: "refreshRequestParams", value: [] as unknown as string, type: "any" },
    { key: "tokenRequestParams", value: [] as unknown as string, type: "any" },
    { key: "authRequestParams", value: [] as unknown as string, type: "any" },
    { key: "useBrowser", value: true, type: "boolean" },
    { key: "addTokenTo", value: "header", type: "string" },
    { key: "client_authentication", value: "header", type: "string" },
    ...(opts.refreshToken
      ? [
          {
            key: "accessToken",
            value: "",
            type: "string",
            description: "Short-lived — refreshed automatically.",
          } as PostmanKV,
        ]
      : []),
  ];

  return {
    info: {
      _postman_id: randomUUID(),
      name: opts.name,
      description:
        `Salesforce OAuth2 + REST API collection for ${opts.instanceUrl}.\n\n` +
        `Generated by ballerina-salesforce-mcp-server.\n\n` +
        `## Quick Start\n` +
        `1. Run "Password Flow — Get Tokens" to populate {{access_token}} and {{refresh_token}}.\n` +
        `2. Run any request in "Salesforce REST API" — tokens are applied automatically.\n` +
        `3. When access_token expires, run "Step 3 — Refresh Access Token".\n\n` +
        `## Re-using with MCP\n` +
        `Point sf_import_postman_credentials at this file to auto-configure a new Ballerina project:\n` +
        `  sf_import_postman_credentials { postman_file: "<path_to_this_file>" }`,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    auth: {
      type: "oauth2",
      oauth2,
    },
    variable: variables,
    item: items,
    event: [
      {
        listen: "prerequest",
        script: { type: "text/javascript", packages: {}, exec: [""] },
      },
      {
        listen: "test",
        script: { type: "text/javascript", packages: {}, exec: [""] },
      },
    ],
  };
}

// ─── Postman collection types for import parsing ──────────────────────────────

interface PostmanKeyValue {
  key: string;
  value: string;
  type?: string;
  disabled?: boolean;
}
interface PostmanUrl {
  raw?: string;
  query?: PostmanKeyValue[];
}
interface PostmanBody {
  mode?: string;
  urlencoded?: PostmanKeyValue[];
}
interface PostmanRequest {
  url?: PostmanUrl | string;
  body?: PostmanBody;
}
interface PostmanItem {
  name?: string;
  request?: PostmanRequest;
  item?: PostmanItem[];
}
interface PostmanCollection {
  auth?: { type?: string; oauth2?: PostmanKeyValue[] };
  item?: PostmanItem[];
  variable?: PostmanKeyValue[];
}

function kvVal(pairs: PostmanKeyValue[], key: string): string | null {
  return pairs.find((p) => p.key === key && !p.disabled)?.value?.trim() || null;
}

function instanceUrlFrom(tokenUrl: string | null): string | null {
  if (!tokenUrl) return null;
  try {
    const u = new URL(tokenUrl);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return null;
  }
}

function extractFromItems(items: PostmanItem[]): Array<{
  clientId?: string | null;
  clientSecret?: string | null;
  refreshToken?: string | null;
  instanceUrl?: string | null;
  redirectUri?: string | null;
  source?: string;
}> {
  const results: ReturnType<typeof extractFromItems> = [];
  const walk = (item: PostmanItem) => {
    if (item.item) { item.item.forEach(walk); return; }
    const req = item.request;
    if (!req) return;
    const urlenc = req.body?.urlencoded ?? [];
    const query = (typeof req.url === "object" ? req.url?.query : []) ?? [];
    const allPairs = [...urlenc, ...query];
    const cId = kvVal(allPairs, "client_id");
    const cSec = kvVal(allPairs, "client_secret");
    const rt = kvVal(allPairs, "refresh_token");
    const rawUrl = typeof req.url === "string" ? req.url : req.url?.raw ?? "";
    const instUrl = instanceUrlFrom(rawUrl.startsWith("http") ? rawUrl.split("?")[0] : null);
    if (cId || cSec || rt) results.push({ clientId: cId, clientSecret: cSec, refreshToken: rt, instanceUrl: instUrl, redirectUri: kvVal(allPairs, "redirect_uri"), source: item.name });
  };
  items.forEach(walk);
  return results;
}

// ─── Tool registrations ───────────────────────────────────────────────────────

export function registerPostmanTools(server: McpServer): void {

  // ── Generate Postman Collection ───────────────────────────────────────────

  server.registerTool(
    "sf_generate_postman_collection",
    {
      title: "Generate Salesforce Postman Collection (with auto-obtained refresh token)",
      description: `Creates a complete, import-ready Postman collection for your Salesforce org:

  1. Auto-obtains a refresh token using the username+password flow (no browser).
  2. Bakes ALL credentials into the collection (collection variables + OAuth2 config).
  3. Saves the .postman_collection.json to disk.
  4. Returns a ready_for_quickstart block — call sf_quickstart immediately after,
     or save the file path and use sf_import_postman_credentials any time later.

The generated collection includes:
  • Password flow, auth-code flow (Steps 1–3), and refresh-token requests
  • Test scripts that auto-save tokens to collection variables on every response
  • Salesforce REST API folder (validate, list SObjects, SOQL, create Account)
  • Ballerina service folder (health check, Account CRUD via local service)

This is the recommended first step — run it once, reuse the collection forever.`,
      inputSchema: GeneratePostmanCollectionSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: GeneratePostmanCollectionInput): Promise<ToolResult> => {
      try {
        const validated = validateSalesforceUrl(params.sf_base_url);

        // Step 1 — Auto-obtain refresh token via password flow.
        let refreshToken: string | null = null;
        let instanceUrl = validated.href;
        let tokenError: string | null = null;

        try {
          const tokens = await getTokenPasswordFlow(
            params.sf_client_id,
            params.sf_client_secret,
            params.username,
            params.password,
            params.sf_base_url
          );
          refreshToken = tokens.refreshToken;
          instanceUrl = tokens.instanceUrl;
        } catch (e) {
          // Don't abort — still generate the collection, just without a token.
          tokenError =
            e instanceof Error ? e.message : String(e);
        }

        // Step 2 — Build the Postman collection.
        const safeName = params.collection_name
          .replace(/[^a-zA-Z0-9_\- ]/g, "_")
          .replace(/\s+/g, "_");
        const filename = `${safeName}.postman_collection.json`;

        const defaultDir = safeResolve("~/WSO2Integrator");
        const outputPath = params.output_path
          ? safeResolve(params.output_path)
          : path.join(defaultDir, filename);

        const collection = buildPostmanCollection({
          name: params.collection_name,
          clientId: params.sf_client_id,
          clientSecret: params.sf_client_secret,
          instanceUrl,
          refreshToken,
          username: params.username,
          password: params.password,
          redirectUri: params.redirect_uri,
          sandbox: validated.isSandbox,
        });

        // Step 3 — Write to disk (regular mode — secrets already in Config.toml).
        await writeFile(outputPath, JSON.stringify(collection, null, 2));

        // Step 4 — Build ready_for_quickstart if we have a refresh token.
        const readyForQuickstart = refreshToken
          ? {
              sf_client_id: params.sf_client_id,
              sf_client_secret: params.sf_client_secret,
              sf_refresh_token: refreshToken,
              sf_base_url: instanceUrl,
            }
          : null;

        const result = {
          collection_file: outputPath,
          collection_name: params.collection_name,
          instance_url: instanceUrl,
          sandbox: validated.isSandbox,
          refresh_token_obtained: Boolean(refreshToken),
          refresh_token_preview: refreshToken ? maskSecret(refreshToken) : null,
          ...(tokenError
            ? {
                token_warning:
                  `Could not auto-obtain refresh token: ${tokenError} ` +
                  `— collection saved with placeholder. Run 'Password Flow' inside Postman to populate it, ` +
                  `or enable the password flow in Setup → Identity → OAuth and OpenID Connect Settings.`,
              }
            : {}),
          ready_for_quickstart: readyForQuickstart,
          next_steps: [
            refreshToken
              ? "✓ Refresh token obtained and baked into the collection."
              : "⚠ Open the collection in Postman and run 'Password Flow' to populate the refresh token.",
            `Import ${outputPath} into Postman — all credentials are pre-configured.`,
            refreshToken
              ? "Call sf_quickstart with the ready_for_quickstart block to scaffold your Ballerina project now."
              : "Or fix the password-flow error, then call sf_generate_postman_collection again.",
            `Future sessions: sf_import_postman_credentials { postman_file: "${outputPath}" }`,
          ],
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: asStructured(result as Record<string, unknown>),
          isError: false,
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Import Postman credentials ────────────────────────────────────────────

  server.registerTool(
    "sf_import_postman_credentials",
    {
      title: "Import Salesforce Credentials from Postman Collection",
      description: `Reads a Postman collection (.postman_collection.json) — including ones generated
by sf_generate_postman_collection — and extracts Salesforce OAuth2 credentials
(clientId, clientSecret, refreshToken, instanceUrl, username, password) so you
don't have to type them out manually.

If a refresh_token is found it is returned immediately (no browser auth needed).
If only username + password are found, tells you to call sf_get_token_password_flow.

Returns a ready_for_quickstart block to pass directly to sf_quickstart.`,
      inputSchema: ImportPostmanCredentialsSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: ImportPostmanCredentialsInput): Promise<ToolResult> => {
      try {
        const filePath = safeResolve(params.postman_file);
        let raw: string;
        try {
          raw = await fs.readFile(filePath, "utf-8");
        } catch {
          throw new ToolError("NOT_FOUND", `Cannot read file: ${filePath}`, "Check the path is correct.");
        }

        let collection: PostmanCollection;
        try {
          collection = JSON.parse(raw) as PostmanCollection;
        } catch {
          throw new ToolError("INVALID_INPUT", `File is not valid JSON: ${filePath}`);
        }

        // Extract from collection-level auth.oauth2 and collection variables.
        const oauth2 = collection.auth?.oauth2 ?? [];
        const vars = collection.variable ?? [];

        const colClientId = kvVal(oauth2, "clientId") ?? kvVal(vars, "client_id");
        const colClientSecret = kvVal(oauth2, "clientSecret") ?? kvVal(vars, "client_secret");
        const colUsername = kvVal(oauth2, "username") ?? kvVal(vars, "username");
        const colPassword = kvVal(oauth2, "password");
        const colAccessTokenUrl = kvVal(oauth2, "accessTokenUrl");
        const colRedirectUri = kvVal(oauth2, "redirect_uri");
        const colInstanceUrl =
          kvVal(vars, "instance_url") ?? instanceUrlFrom(colAccessTokenUrl);

        // Collection variable refresh_token wins (it's auto-updated by test scripts).
        const varRefreshToken = kvVal(vars, "refresh_token");

        // Scan request bodies.
        const itemCreds = extractFromItems(collection.item ?? []);
        const withRefresh = itemCreds.find((c) => c.refreshToken);
        const withCreds = itemCreds.find((c) => c.clientId && c.clientSecret);
        const best = withRefresh ?? withCreds ?? {};

        const clientId = colClientId ?? best.clientId ?? null;
        const clientSecret = colClientSecret ?? best.clientSecret ?? null;
        // Prefer collection variable (auto-updated) → request body
        const refreshToken = (varRefreshToken && varRefreshToken !== "") ? varRefreshToken : (best.refreshToken ?? null);
        const instanceUrl = colInstanceUrl ?? best.instanceUrl ?? null;
        const redirectUri = colRedirectUri ?? best.redirectUri ?? null;

        const hasRefreshToken = Boolean(refreshToken);
        const hasPasswordCreds = Boolean(clientId && clientSecret && colUsername && colPassword);
        const hasMinForValidation = Boolean(clientId && clientSecret && refreshToken && instanceUrl);

        let validation: { connected: boolean; org_id?: string; username?: string; error?: string } | null = null;
        if (params.validate && hasMinForValidation) {
          try {
            const conn = await validateConnection({
              clientId: clientId!,
              clientSecret: clientSecret!,
              refreshToken: refreshToken!,
              baseUrl: instanceUrl!,
            });
            validation = { connected: true, org_id: conn.orgId, username: conn.username };
          } catch (e) {
            validation = { connected: false, error: e instanceof Error ? e.message : String(e) };
          }
        }

        const readyForQuickstart =
          clientId && clientSecret && refreshToken && instanceUrl
            ? { sf_client_id: clientId, sf_client_secret: clientSecret, sf_refresh_token: refreshToken, sf_base_url: instanceUrl }
            : null;

        const missingFields = [
          !clientId && "sf_client_id",
          !clientSecret && "sf_client_secret",
          !instanceUrl && "sf_base_url",
          !refreshToken && "sf_refresh_token",
        ].filter(Boolean);

        let next_action: string;
        if (hasRefreshToken && hasMinForValidation) {
          next_action = validation?.connected
            ? "Credentials validated ✓ — call sf_quickstart with the ready_for_quickstart block."
            : "Refresh token found but validation failed — token may be expired. " +
              (hasPasswordCreds
                ? "Call sf_get_token_password_flow to get a fresh one, or run 'Step 3 — Refresh Access Token' in Postman."
                : "Run 'Step 3 — Refresh Access Token' in Postman, then call sf_import_postman_credentials again.");
        } else if (!hasRefreshToken && hasPasswordCreds) {
          next_action =
            "No refresh token found — call sf_get_token_password_flow with the password_flow_args below.";
        } else {
          next_action = "Missing fields — see missing_fields. Consider running sf_generate_postman_collection to create a complete collection.";
        }

        const result = {
          file: filePath,
          credentials_found: {
            sf_client_id: clientId ? maskSecret(clientId) : null,
            sf_client_secret: clientSecret ? maskSecret(clientSecret) : null,
            sf_refresh_token: refreshToken ? maskSecret(refreshToken) : null,
            sf_base_url: instanceUrl,
            redirect_uri: redirectUri,
            username: colUsername,
            password_found: Boolean(colPassword),
          },
          ...(missingFields.length > 0 ? { missing_fields: missingFields } : {}),
          ...(validation ? { validation } : {}),
          ready_for_quickstart: readyForQuickstart,
          ...(hasPasswordCreds && !hasRefreshToken
            ? { password_flow_args: { sf_client_id: clientId, sf_client_secret: clientSecret, username: colUsername, password: colPassword, sf_base_url: instanceUrl } }
            : {}),
          next_action,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: asStructured(result as Record<string, unknown>),
          isError: !hasRefreshToken && !hasPasswordCreds,
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Password-flow token ───────────────────────────────────────────────────

  server.registerTool(
    "sf_get_token_password_flow",
    {
      title: "Get Salesforce Tokens via Username-Password Flow (No Browser)",
      description: `Obtains Salesforce OAuth2 tokens using the username+password grant —
no browser, no auth-code redirect required.

Requirements on the Connected App (one-time Salesforce Setup):
  1. Scope: "Perform requests at any time (refresh_token, offline_access)"
  2. Setup → Identity → OAuth and OpenID Connect Settings →
     "Allow OAuth Username-Password Flows" = ON

Append security token to password if required: myPasswordABC123

Returns refresh_token and a ready_for_quickstart block for sf_quickstart.`,
      inputSchema: GetTokenPasswordFlowSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: GetTokenPasswordFlowInput): Promise<ToolResult> => {
      try {
        const tokens = await getTokenPasswordFlow(
          params.sf_client_id,
          params.sf_client_secret,
          params.username,
          params.password,
          params.sf_base_url
        );
        const hasRefreshToken = Boolean(tokens.refreshToken);
        const result = {
          access_token_preview: maskSecret(tokens.accessToken),
          refresh_token: tokens.refreshToken,
          instance_url: tokens.instanceUrl,
          note: hasRefreshToken
            ? "Save refresh_token — it's long-lived. Use instance_url as sf_base_url in sf_quickstart."
            : "No refresh_token returned. Add 'offline_access' scope to the Connected App and retry.",
          ready_for_quickstart: hasRefreshToken
            ? { sf_client_id: params.sf_client_id, sf_client_secret: params.sf_client_secret, sf_refresh_token: tokens.refreshToken, sf_base_url: tokens.instanceUrl }
            : null,
          next_action: hasRefreshToken
            ? "Call sf_quickstart with the ready_for_quickstart block, or sf_generate_postman_collection to also create a reusable Postman collection."
            : "Add offline_access scope to the Connected App and retry.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: asStructured(result as Record<string, unknown>),
          isError: !hasRefreshToken,
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
