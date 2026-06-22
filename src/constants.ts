// ─── Platform Detection ───────────────────────────────────────────────────────

export const PLATFORM = process.platform;

// ─── WSO2 Integrator BI Paths ─────────────────────────────────────────────────

export const BI_PATH_DEFAULTS: Record<string, string> = {
  win32: "%USERPROFILE%\\WSO2Integrator",
  darwin: "~/WSO2Integrator",
  linux: "~/WSO2Integrator",
};

export function getDefaultBIPath(): string {
  return BI_PATH_DEFAULTS[PLATFORM] ?? "~/WSO2Integrator";
}

// ─── Salesforce Constants ─────────────────────────────────────────────────────

export const SF_LOGIN_URL = "https://login.salesforce.com";
export const SF_SANDBOX_LOGIN_URL = "https://test.salesforce.com";
export const SF_TOKEN_PATH = "/services/oauth2/token";
export const SF_AUTHORIZE_PATH = "/services/oauth2/authorize";
// REST API version (without leading 'v'). Matches the connector's default apiVersion.
// Bumped from 59.0 (2024) → 62.0 (current). Update when the connector ships a new default.
export const SF_API_VERSION = "62.0";

export const SF_STANDARD_OBJECTS = [
  "Account",
  "Contact",
  "Lead",
  "Opportunity",
  "Case",
  "Task",
  "Event",
] as const;

/**
 * Allow-list of hostname suffixes we will OAuth against / talk REST to.
 * Anything outside this set is rejected before a credential ever leaves the
 * process — guards against SSRF / credential exfiltration via attacker-supplied
 * `sf_base_url`.
 *
 * `*.force.com` covers Experience-cloud / community URLs; `*.salesforce.com`
 * covers `*.my.salesforce.com`, `*.lightning.force.com`, `*.sandbox.my.salesforce.com`,
 * and the canonical `login`/`test` hosts.
 */
const SF_ALLOWED_HOST_SUFFIXES = [
  ".salesforce.com",
  ".force.com",
  ".cloudforce.com",
  ".salesforce-setup.com",
] as const;

export interface ValidatedSfUrl {
  href: string;       // normalized https URL (no path/query)
  hostname: string;
  isSandbox: boolean;
}

/**
 * Validates and normalizes a user-supplied Salesforce URL.
 * Throws with a clear, user-actionable message on failure.
 */
export function validateSalesforceUrl(input: string): ValidatedSfUrl {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(
      `Invalid sf_base_url: '${input}'. Expected https://<your-org>.my.salesforce.com`
    );
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `Invalid sf_base_url: must use https://. Got '${parsed.protocol}'.`
    );
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = SF_ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix)
  );
  if (!allowed) {
    throw new Error(
      `Refusing to use sf_base_url '${input}': hostname '${host}' is not a Salesforce domain. ` +
        `Allowed: ${SF_ALLOWED_HOST_SUFFIXES.join(", ")}`
    );
  }

  return {
    href: `${parsed.protocol}//${host}`,
    hostname: host,
    isSandbox: isSandboxHost(host),
  };
}

/**
 * Hostname-based sandbox detection. More reliable than the identity-endpoint
 * `is_sandbox` field (which isn't returned by all org editions).
 *
 * Sandbox shapes we recognize:
 *   - test.salesforce.com
 *   - <org>--<sb>.sandbox.my.salesforce.com
 *   - <org>--<sb>.sandbox.lightning.force.com
 *   - <org>--<sb>.my.salesforce-setup.com  (sandbox Setup-only host)
 */
export function isSandboxHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "test.salesforce.com" ||
    h.includes(".sandbox.") ||
    h.includes("--") // sandbox names always contain the org--sb separator
  );
}

/**
 * @deprecated use `validateSalesforceUrl(url).isSandbox`. Kept for callers
 * that already validated the URL elsewhere.
 */
export function isSandboxUrl(baseUrl: string): boolean {
  const u = baseUrl.toLowerCase();
  return u.includes(".sandbox.") || u.includes("test.salesforce.com") || /https?:\/\/[^/]+--[^/]+\./.test(u);
}

export function loginUrlFor(baseUrl: string): string {
  return isSandboxUrl(baseUrl) ? SF_SANDBOX_LOGIN_URL : SF_LOGIN_URL;
}

export function tokenUrlFor(baseUrl: string): string {
  // Tokens must be refreshed at the host that issued them. For My Domain orgs
  // (now the default), that's the org's own instance host — refreshing at
  // login.salesforce.com can return invalid_grant, and it needlessly depends on
  // login.salesforce.com resolving. Derive from baseUrl; fall back to login/test
  // only if it can't be parsed.
  try {
    return `${new URL(baseUrl).origin}${SF_TOKEN_PATH}`;
  } catch {
    return `${loginUrlFor(baseUrl)}${SF_TOKEN_PATH}`;
  }
}

export function authorizeUrlFor(baseUrl?: string): string {
  return `${baseUrl ? loginUrlFor(baseUrl) : SF_LOGIN_URL}${SF_AUTHORIZE_PATH}`;
}

// ─── Ballerina Connector Versions ─────────────────────────────────────────────

// Latest stable connector + distribution as of 2026-05.
export const BAL_SALESFORCE_CONNECTOR_VERSION = "8.7.0";
export const BAL_DISTRIBUTION = "2201.12.0";
export const BAL_CONNECTOR_PKG = "ballerinax/salesforce";
export const BAL_CONNECTOR_TYPES_PKG = "ballerinax/salesforce.types";

// Max generated fields per SObject record (only used for custom objects now).
export const MAX_FIELDS_PER_TYPE = 200;

// Default HTTP listener port for generated services.
export const DEFAULT_SERVICE_PORT = 9090;

// ─── Misc ─────────────────────────────────────────────────────────────────────

export const CHARACTER_LIMIT = 8000;

/**
 * Whether an SObject API name represents a custom object. The "__c" suffix
 * is the authoritative marker — including for managed-package namespaced
 * custom objects like "MyPkg__Foo__c".
 */
export function isCustomObject(name: string): boolean {
  return /__c$/i.test(name);
}

// ─── Server metadata ──────────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

/**
 * Reads version from package.json so `McpServer` reports the real version
 * instead of a hard-coded constant that drifts.
 */
export function getServerVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/constants.js → ../package.json
    const pkgPath = path.resolve(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
