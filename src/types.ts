// ─── Salesforce Auth ──────────────────────────────────────────────────────────

export interface SalesforceCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  baseUrl: string;
}

export interface SalesforceTokenResponse {
  access_token: string;
  instance_url: string;
  id: string;
  token_type: string;
  issued_at: string;
  signature: string;
}

export interface SalesforceOAuthCodeResponse {
  access_token: string;
  refresh_token: string;
  instance_url: string;
  id: string;
  token_type: string;
  issued_at: string;
  signature: string;
}

// ─── SObject Metadata ─────────────────────────────────────────────────────────

export interface SObjectField {
  name: string;
  label: string;
  type: string;
  length: number;
  nillable: boolean;
  custom: boolean;
  referenceTo: string[];
}

export interface SObjectDescribeResult {
  name: string;
  label: string;
  labelPlural: string;
  custom: boolean;
  fields: SObjectField[];
  urls: Record<string, string>;
}

export interface SObjectListItem {
  name: string;
  label: string;
  labelPlural: string;
  custom: boolean;
  urls: Record<string, string>;
}

// ─── Ballerina Project ────────────────────────────────────────────────────────

export interface BallerinaSalesforceProjectConfig {
  projectName: string;
  orgName: string;
  version: string;
  biPath: string;
  sfCredentials: SalesforceCredentials;
  targetObjects: string[];
  includeCustomObjects: boolean;
}

export interface ScaffoldResult {
  projectPath: string;
  filesCreated: string[];
  nextSteps: string[];
}

export interface DeployResult {
  success: boolean;
  output: string;
  projectPath: string;
}

// ─── MCP Tool Results ─────────────────────────────────────────────────────────

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// ─── Shared Credential Param Shape (for tools) ────────────────────────────────

export interface SfCredentialParams {
  sf_client_id: string;
  sf_client_secret: string;
  sf_refresh_token: string;
  sf_base_url: string;
}

export function credentialsFromParams(params: SfCredentialParams): SalesforceCredentials {
  return {
    clientId: params.sf_client_id,
    clientSecret: params.sf_client_secret,
    refreshToken: params.sf_refresh_token,
    baseUrl: params.sf_base_url,
  };
}

/**
 * Structured error envelope. Carrying a stable `code` lets calling LLMs branch
 * on failure mode (e.g. retry on TRANSIENT, prompt the user on AUTH).
 */
export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  hint?: string;
}

export type ErrorCode =
  | "AUTH_INVALID_GRANT"
  | "AUTH_INVALID_CLIENT"
  | "AUTH_CONNECTED_APP_NOT_READY"
  | "INVALID_URL"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "PATH_TRAVERSAL"
  | "PRECONDITION_FAILED"
  | "BAL_CLI_MISSING"
  | "BAL_BUILD_FAILED"
  | "BAL_RUN_FAILED"
  | "TRANSIENT"
  | "UNKNOWN";

/**
 * Thrown by service-layer code so tool handlers can wrap it in a structured
 * tool result without losing the error code.
 */
export class ToolError extends Error {
  code: ErrorCode;
  hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.hint = hint;
  }
}

export function errorResult(err: unknown): ToolResult {
  const env = toErrorEnvelope(err);
  const text = env.hint
    ? `Error [${env.code}]: ${env.message}\nHint: ${env.hint}`
    : `Error [${env.code}]: ${env.message}`;
  return {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: { error: env } as Record<string, unknown>,
  };
}

export function toErrorEnvelope(err: unknown): ErrorEnvelope {
  if (err instanceof ToolError) {
    return { code: err.code, message: err.message, hint: err.hint };
  }
  if (err instanceof Error) {
    return { code: "UNKNOWN", message: err.message };
  }
  return { code: "UNKNOWN", message: String(err) };
}

/**
 * Mask a token-like string for log/echo. Shows the first 4 and last 4 chars,
 * with the middle replaced — enough for users to verify they pasted the right
 * one without leaking the full secret into MCP transcripts.
 */
export function maskSecret(secret: string | undefined | null): string {
  if (!secret) return "";
  if (secret.length <= 12) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
}

/**
 * Type-safe converter for arbitrary objects to `structuredContent`. Centralizes
 * the previously-scattered `as unknown as Record<string, unknown>` casts.
 */
export function asStructured<T extends Record<string, unknown>>(
  obj: T
): Record<string, unknown> {
  return obj as Record<string, unknown>;
}
