import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildAuthUrl, exchangeAuthCode } from "../services/salesforce.js";
import {
  GetOAuthAuthUrlSchema,
  ExchangeOAuthCodeSchema,
  GetOAuthAuthUrlInput,
  ExchangeOAuthCodeInput,
} from "../schemas/tools.js";
import { asStructured, errorResult, maskSecret } from "../types.js";
import type { ToolResult } from "../types.js";

export function registerOAuthTools(server: McpServer): void {

  server.registerTool(
    "sf_get_oauth_auth_url",
    {
      title: "Get Salesforce OAuth2 Authorization URL",
      description: `Generates the Salesforce OAuth2 authorization URL for a Connected App.
Open the returned URL in a browser to approve access. After approving, Salesforce
redirects to the redirect_uri with a 'code' query parameter — pass that code to
sf_exchange_oauth_code to obtain your refresh token.

Set sandbox=true to use test.salesforce.com instead of login.salesforce.com.`,
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
        const authUrl = buildAuthUrl(
          params.sf_client_id,
          params.redirect_uri,
          params.sandbox
        );
        const result = {
          auth_url: authUrl,
          sandbox: params.sandbox,
          next_step:
            "1. Open the auth_url in a browser.\n" +
            "2. Log in and approve access.\n" +
            "3. Salesforce will redirect with ?code=XXXX in the URL.\n" +
            "4. Pass that code to sf_exchange_oauth_code (using the same sandbox flag).",
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
          params.sandbox
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
}
