import { readFile } from "fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildAuthUrl, exchangeAuthCode } from "../services/salesforce.js";
import {
  GetOAuthAuthUrlSchema,
  ExchangeOAuthCodeSchema,
  ReauthProjectSchema,
  GetOAuthAuthUrlInput,
  ExchangeOAuthCodeInput,
  ReauthProjectInput,
} from "../schemas/tools.js";
import { asStructured, errorResult, maskSecret, ToolError } from "../types.js";
import type { ToolResult } from "../types.js";
import {
  safeResolve,
  safeJoin,
  directoryExists,
  writeSecretFile,
} from "../services/filesystem.js";
import { generateConfigToml } from "../services/generator.js";
import { validateSalesforceUrl, DEFAULT_SERVICE_PORT } from "../constants.js";

export function registerOAuthTools(server: McpServer): void {

  server.registerTool(
    "sf_get_oauth_auth_url",
    {
      title: "Get Salesforce OAuth2 Authorization URL",
      description: `Generates the Salesforce OAuth2 authorization URL for a Connected App.
Open the returned URL in a browser to approve access. After approving, Salesforce
redirects to the redirect_uri with a 'code' query parameter — pass that code to
sf_exchange_oauth_code to obtain your refresh token.

Recommended: pass sf_base_url (your org / My Domain URL). The authorize URL is then
built against your org's own host (e.g. https://myorg.my.salesforce.com/services/oauth2/authorize),
which is the correct host for My Domain orgs. When sf_base_url is omitted, set sandbox=true
to use test.salesforce.com instead of login.salesforce.com.`,
      inputSchema: GetOAuthAuthUrlSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: GetOAuthAuthUrlInput): Promise<ToolResult> => {
      try {
        // When the caller supplies their org host and left redirect_uri at the
        // default login.* success URL, align the redirect to the same host so
        // the authorize host and the callback are consistent.
        const DEFAULT_REDIRECT = "https://login.salesforce.com/services/oauth2/success";
        let redirectUri = params.redirect_uri;
        if (params.sf_base_url && redirectUri === DEFAULT_REDIRECT) {
          try {
            redirectUri = `${new URL(params.sf_base_url).origin}/services/oauth2/success`;
          } catch {
            /* keep the default if the base URL can't be parsed */
          }
        }
        const authUrl = buildAuthUrl(
          params.sf_client_id,
          redirectUri,
          params.sandbox,
          params.sf_base_url
        );
        const result = {
          auth_url: authUrl,
          redirect_uri: redirectUri,
          sandbox: params.sandbox,
          next_step:
            "1. Open the auth_url in a browser.\n" +
            "2. Log in and approve access.\n" +
            "3. Salesforce will redirect with ?code=XXXX in the URL.\n" +
            "4. Pass that code to sf_exchange_oauth_code (with the same redirect_uri).",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "sf_exchange_oauth_code",
    {
      title: "Exchange Salesforce OAuth2 Authorization Code for Tokens",
      description: `Exchanges an OAuth2 authorization code for tokens.
Set sandbox=true if the code was obtained from test.salesforce.com.

Returns the refresh_token (save this — it's long-lived!) and instance_url.
The short-lived access_token is intentionally masked in the output to keep it
out of MCP transcripts; you don't need it directly — pass refresh_token to the
other tools and they obtain fresh access tokens on demand.

Error Handling:
  - "invalid_grant": code expired or already used — re-run sf_get_oauth_auth_url
  - "invalid_client": wrong client_id / client_secret (or Connected App still
    activating; wait 2-10 min after creating it)`,
      inputSchema: ExchangeOAuthCodeSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: ExchangeOAuthCodeInput): Promise<ToolResult> => {
      try {
        const tokens = await exchangeAuthCode(
          params.sf_client_id,
          params.sf_client_secret,
          params.code,
          params.redirect_uri,
          params.sandbox,
          params.sf_base_url
        );
        // Echo the refresh_token (long-lived, the user needs it) but mask the
        // short-lived access_token so it doesn't end up in transcripts.
        const result = {
          access_token_preview: maskSecret(tokens.access_token),
          refresh_token: tokens.refresh_token,
          instance_url: tokens.instance_url,
          sandbox: params.sandbox,
          note:
            "Save refresh_token securely (don't paste it into shared logs). " +
            "Use instance_url as sf_base_url in subsequent tools " +
            "(sf_validate_connection, sf_scaffold_project, sf_quickstart).",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: asStructured(result),
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "sf_reauth_project",
    {
      title: "Re-authenticate a Ballerina Project with a Fresh Authorization Code",
      description: `Exchanges a Salesforce OAuth2 authorization code for a new refresh token
and immediately patches Config.toml in the target project — fixing an
expired/revoked token in a single step.

Use this when a running Ballerina project logs:
  "Token refresh failed" / "invalid_grant" / "expired access/refresh token"

Workflow:
  1. Run sf_get_oauth_auth_url (or open the Connected App's auth URL manually).
  2. Log in and approve — copy the 'code' value from the redirect URL.
  3. Call sf_reauth_project with that code and the project path.
     The tool exchanges the code, extracts orgName/packageName from Ballerina.toml,
     preserves the existing servicePort, and overwrites Config.toml (mode 0600).
  4. Restart the project (sf_deploy_project or bal run) to apply the new token.

Error hints:
  - "invalid_grant": code expired (codes are single-use, ~10 min TTL) — re-run step 1.
  - "invalid_client": wrong client_id/secret, or Connected App still activating.`,
      inputSchema: ReauthProjectSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: ReauthProjectInput): Promise<ToolResult> => {
      try {
        // ── 1. Exchange the authorization code for fresh tokens ────────────────
        const tokens = await exchangeAuthCode(
          params.sf_client_id,
          params.sf_client_secret,
          params.code,
          params.redirect_uri,
          false,          // sandbox auto-detected from sf_base_url below
          params.sf_base_url
        );

        // ── 2. Resolve and validate the project directory ──────────────────────
        const projectPath = safeResolve(params.project_path);
        if (!(await directoryExists(projectPath))) {
          throw new ToolError("NOT_FOUND", `Project directory not found: ${projectPath}`);
        }

        // ── 3. Extract org/package name from Ballerina.toml ───────────────────
        const ballerinaToml = await readFile(
          safeJoin(projectPath, "Ballerina.toml"),
          "utf-8"
        ).catch(() => "");
        const orgName =
          ballerinaToml.match(/^org\s*=\s*"([^"]+)"/m)?.[1] ?? "wso2bi";
        const packageName =
          ballerinaToml.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? "salesforce_integration";

        // ── 4. Preserve servicePort from existing Config.toml ─────────────────
        const configPath = safeJoin(projectPath, "Config.toml");
        const existingConfig = await readFile(configPath, "utf-8").catch(() => "");
        const portMatch = existingConfig.match(/^\s*servicePort\s*=\s*(\d+)/m);
        const port = portMatch ? parseInt(portMatch[1], 10) : DEFAULT_SERVICE_PORT;

        // ── 5. Detect sandbox from the token endpoint's instance_url ──────────
        const validated = validateSalesforceUrl(params.sf_base_url);

        // ── 6. Write Config.toml with the new refresh token ───────────────────
        await writeSecretFile(
          configPath,
          generateConfigToml(
            params.sf_client_id,
            params.sf_client_secret,
            tokens.refresh_token,
            tokens.instance_url,   // use the authoritative instance_url from the token response
            port,
            validated.isSandbox,
            orgName,
            packageName
          )
        );

        const result = {
          config_path: configPath,
          refresh_token: tokens.refresh_token,
          access_token_preview: maskSecret(tokens.access_token),
          instance_url: tokens.instance_url,
          sandbox: validated.isSandbox,
          org_name: orgName,
          package_name: packageName,
          service_port: port,
          next_steps: [
            "1. Restart the project to pick up the new token: use sf_deploy_project or run 'bal run' in a terminal.",
            "2. Verify the CDC listeners reconnect: check logs for 'Acquired leadership for Salesforce CDC channel'.",
            "3. Store the refresh_token securely — it is the long-lived credential for this project.",
          ].join("\n"),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: asStructured(result),
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
