import axios, { AxiosError } from "axios";
import { createHash } from "crypto";
import {
  SalesforceCredentials,
  SalesforceTokenResponse,
  SalesforceOAuthCodeResponse,
  SObjectDescribeResult,
  SObjectListItem,
  ToolError,
} from "../types.js";
import {
  SF_API_VERSION,
  tokenUrlFor,
  authorizeUrlFor,
  SF_LOGIN_URL,
  SF_SANDBOX_LOGIN_URL,
  validateSalesforceUrl,
} from "../constants.js";

// ─── HTTP client (shared, with timeout) ───────────────────────────────────────

const http = axios.create({
  timeout: 30_000,
  // Don't follow redirects on token endpoints — Salesforce never redirects there
  // and a redirect would be a strong signal of misconfiguration / MITM.
  maxRedirects: 0,
});

// ─── Token Management ─────────────────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  instanceUrl: string;
  identityUrl: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, CachedToken>();

// Salesforce session tokens last ~2h by default; refresh 5min early to be safe.
const TOKEN_TTL_MS = 110 * 60 * 1000;

function credKey(creds: SalesforceCredentials): string {
  return createHash("sha256")
    .update(
      [
        creds.clientId,
        creds.clientSecret,
        creds.refreshToken,
        creds.baseUrl,
      ].join("\x1f")
    )
    .digest("hex");
}

export async function getAccessToken(
  creds: SalesforceCredentials
): Promise<{ accessToken: string; instanceUrl: string; identityUrl: string }> {
  // Validate hostname before any network IO — never leak secrets to unknown hosts.
  validateSalesforceUrl(creds.baseUrl);

  const key = credKey(creds);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      accessToken: cached.accessToken,
      instanceUrl: cached.instanceUrl,
      identityUrl: cached.identityUrl,
    };
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
  });

  try {
    const resp = await http.post<SalesforceTokenResponse>(
      tokenUrlFor(creds.baseUrl),
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const fresh: CachedToken = {
      accessToken: resp.data.access_token,
      instanceUrl: resp.data.instance_url,
      identityUrl: resp.data.id,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    tokenCache.set(key, fresh);
    return {
      accessToken: fresh.accessToken,
      instanceUrl: fresh.instanceUrl,
      identityUrl: fresh.identityUrl,
    };
  } catch (err) {
    throw wrapSfError(err, "Failed to obtain Salesforce access token");
  }
}

/**
 * Drop a cached token (e.g. on 401 from a downstream call). Test-only export.
 */
export function invalidateToken(creds: SalesforceCredentials): void {
  tokenCache.delete(credKey(creds));
}

export async function exchangeAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  sandbox = false,
  baseUrl?: string
): Promise<SalesforceOAuthCodeResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  // A code issued by a My Domain authorize endpoint must be redeemed at the
  // same host. Use the org's instance host when a base URL is supplied;
  // otherwise fall back to the generic login/test token endpoint.
  let origin: string;
  if (baseUrl) {
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      origin = sandbox ? SF_SANDBOX_LOGIN_URL : SF_LOGIN_URL;
    }
  } else {
    origin = sandbox ? SF_SANDBOX_LOGIN_URL : SF_LOGIN_URL;
  }
  const tokenUrl = `${origin}/services/oauth2/token`;

  try {
    const resp = await http.post<SalesforceOAuthCodeResponse>(
      tokenUrl,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    return resp.data;
  } catch (err) {
    throw wrapSfError(err, "Failed to exchange authorization code");
  }
}

export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  sandbox = false,
  baseUrl?: string
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "api refresh_token offline_access",
  });
  // Prefer the org's own instance / My Domain host as the authorize endpoint
  // when a base URL is supplied — this is the correct host for My Domain orgs
  // and avoids "log in via your My Domain" redirects. Falls back to the generic
  // login/test host when no base URL is given.
  let origin: string;
  if (baseUrl) {
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      origin = sandbox ? SF_SANDBOX_LOGIN_URL : SF_LOGIN_URL;
    }
  } else {
    origin = sandbox ? SF_SANDBOX_LOGIN_URL : SF_LOGIN_URL;
  }
  return `${origin}/services/oauth2/authorize?${params.toString()}`;
}

// ─── SObject Metadata ─────────────────────────────────────────────────────────

export async function listSObjects(
  creds: SalesforceCredentials,
  includeCustom: boolean,
  filter?: string
): Promise<SObjectListItem[]> {
  const { accessToken, instanceUrl } = await getAccessToken(creds);
  const url = `${instanceUrl}/services/data/v${SF_API_VERSION}/sobjects`;

  try {
    const resp = await http.get<{ sobjects: SObjectListItem[] }>(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    let objects = resp.data.sobjects;
    if (!includeCustom) objects = objects.filter((o) => !o.custom);

    if (filter) {
      const lower = filter.toLowerCase();
      objects = objects.filter(
        (o) =>
          o.name.toLowerCase().includes(lower) ||
          o.label.toLowerCase().includes(lower)
      );
    }
    return objects;
  } catch (err) {
    throw wrapSfError(err, "Failed to list SObjects");
  }
}

export async function describeSObject(
  creds: SalesforceCredentials,
  objectName: string
): Promise<SObjectDescribeResult> {
  const { accessToken, instanceUrl } = await getAccessToken(creds);
  const url = `${instanceUrl}/services/data/v${SF_API_VERSION}/sobjects/${encodeURIComponent(objectName)}/describe`;

  try {
    const resp = await http.get<SObjectDescribeResult>(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return resp.data;
  } catch (err) {
    throw wrapSfError(err, `Failed to describe SObject '${objectName}'`);
  }
}

/**
 * Salesforce Username-Password OAuth2 flow.
 * Does NOT require a browser — trades username+password for tokens directly.
 *
 * Prerequisites on the Connected App:
 *   - "Perform requests at any time (refresh_token, offline_access)" scope
 *   - "Allow OAuth Username-Password Flows" enabled (Setup → OAuth and OpenID Connect Settings)
 *
 * Returns `refresh_token` when the Connected App has offline_access scope; otherwise
 * only `access_token` is returned. The caller should persist refresh_token if present.
 */
export async function getTokenPasswordFlow(
  clientId: string,
  clientSecret: string,
  username: string,
  password: string,
  baseUrl: string
): Promise<{ accessToken: string; refreshToken: string | null; instanceUrl: string }> {
  validateSalesforceUrl(baseUrl);

  const params = new URLSearchParams({
    grant_type: "password",
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password,
  });

  const tokenUrl = tokenUrlFor(baseUrl);

  try {
    const resp = await http.post<{
      access_token: string;
      refresh_token?: string;
      instance_url: string;
    }>(tokenUrl, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    return {
      accessToken: resp.data.access_token,
      refreshToken: resp.data.refresh_token ?? null,
      instanceUrl: resp.data.instance_url,
    };
  } catch (err) {
    throw wrapSfError(err, "Password-flow token request failed");
  }
}

export async function validateConnection(
  creds: SalesforceCredentials
): Promise<{
  orgId: string;
  username: string;
  instanceUrl: string;
  isSandbox: boolean;
}> {
  const validated = validateSalesforceUrl(creds.baseUrl);
  const { accessToken, instanceUrl, identityUrl } = await getAccessToken(creds);

  try {
    const idResp = await http.get<{
      organization_id: string;
      username: string;
      user_id: string;
      is_sandbox?: boolean;
    }>(identityUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Prefer hostname-based detection over the identity field, which isn't
    // always populated. If they disagree, we trust the URL the user is
    // actually pointing at.
    const instanceValidated = validateSalesforceUrl(instanceUrl);
    const isSandbox =
      instanceValidated.isSandbox ||
      validated.isSandbox ||
      Boolean(idResp.data.is_sandbox);

    return {
      orgId: idResp.data.organization_id,
      username: idResp.data.username,
      instanceUrl,
      isSandbox,
    };
  } catch (err) {
    throw wrapSfError(err, "Failed to validate Salesforce connection");
  }
}

// ─── Error Helpers ────────────────────────────────────────────────────────────

function wrapSfError(err: unknown, context: string): ToolError {
  if (err instanceof AxiosError) {
    const data = err.response?.data as
      | { error_description?: string; error?: string; message?: string }
      | undefined;
    const code = data?.error;
    const detail =
      data?.error_description ?? data?.message ?? data?.error ?? err.message;

    if (code === "invalid_client") {
      return new ToolError(
        "AUTH_CONNECTED_APP_NOT_READY",
        `${context}: ${detail}`,
        "Newly created Connected Apps take 2-10 minutes to activate — retry shortly. " +
          "If it persists, double-check the Consumer Key/Secret in your Connected App."
      );
    }
    if (code === "invalid_grant") {
      return new ToolError(
        "AUTH_INVALID_GRANT",
        `${context}: ${detail}`,
        "The refresh token may be revoked, the auth code expired/reused, " +
          "or you may be using the wrong endpoint (production vs. sandbox)."
      );
    }
    // Network-level failures (DNS, timeout, connection refused)
    if (!err.response) {
      return new ToolError(
        "TRANSIENT",
        `${context}: ${err.message}`,
        "Check network connectivity and that the Salesforce hostname resolves."
      );
    }
    return new ToolError("UNKNOWN", `${context}: ${detail}`);
  }
  if (err instanceof ToolError) return err;
  if (err instanceof Error) return new ToolError("UNKNOWN", `${context}: ${err.message}`);
  return new ToolError("UNKNOWN", `${context}: Unknown error`);
}

// Re-exports for tool layer (avoids broader imports of constants).
export { authorizeUrlFor };
