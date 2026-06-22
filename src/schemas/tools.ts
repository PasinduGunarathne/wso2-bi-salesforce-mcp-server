import { z } from "zod";
import { getDefaultBIPath, validateSalesforceUrl, DEFAULT_SERVICE_PORT } from "../constants.js";

// ─── Shared ───────────────────────────────────────────────────────────────────

const credentialFields = {
  sf_client_id: z
    .string()
    .min(1)
    .describe("Salesforce Connected App Consumer Key (Client ID)"),
  sf_client_secret: z
    .string()
    .min(1)
    .describe("Salesforce Connected App Consumer Secret (Client Secret)"),
  sf_refresh_token: z
    .string()
    .min(1)
    .describe("Salesforce OAuth2 Refresh Token obtained after authorization"),
  sf_base_url: z
    .string()
    .url()
    .refine(
      (u) => {
        try {
          validateSalesforceUrl(u);
          return true;
        } catch {
          return false;
        }
      },
      {
        message:
          "sf_base_url must be a Salesforce-owned host (*.salesforce.com / *.force.com / *.cloudforce.com). " +
          "Example: https://myorg.my.salesforce.com",
      }
    )
    .describe(
      "Salesforce org instance URL, e.g. https://myorg.my.salesforce.com (sandbox auto-detected from hostname)"
    ),
};

const sandboxField = z
  .boolean()
  .optional()
  .describe(
    "Force sandbox mode (test.salesforce.com). Usually inferred from sf_base_url, set this only to override detection."
  );

const sobjectNameSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*$/,
    "SObject API names must be alphanumeric/underscore and start with a letter (e.g. 'Account', 'My_Custom__c')"
  );

const projectNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Must be lowercase alphanumeric with underscores, starting with a letter"
  );

const orgNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "Must be lowercase alphanumeric with underscores");

// ─── OAuth ────────────────────────────────────────────────────────────────────

export const GetOAuthAuthUrlSchema = z
  .object({
    sf_client_id: credentialFields.sf_client_id,
    sf_base_url: credentialFields.sf_base_url
      .optional()
      .describe(
        "Your org instance / My Domain URL, e.g. https://myorg.my.salesforce.com. " +
          "Recommended: when set, the authorize URL is built against your org's own host " +
          "(required for My Domain orgs). When omitted, falls back to login/test.salesforce.com."
      ),
    redirect_uri: z
      .string()
      .url()
      .default("https://login.salesforce.com/services/oauth2/success")
      .describe(
        "Redirect URI registered in your Connected App. If you pass sf_base_url and leave this " +
          "at the default, it is automatically aligned to your org host's /services/oauth2/success."
      ),
    sandbox: z
      .boolean()
      .default(false)
      .describe(
        "Use sandbox login server (test.salesforce.com) instead of login.salesforce.com. Ignored when sf_base_url is set."
      ),
  })
  .strict();

export const ExchangeOAuthCodeSchema = z
  .object({
    sf_client_id: credentialFields.sf_client_id,
    sf_client_secret: credentialFields.sf_client_secret,
    code: z.string().min(1).describe("Authorization code from the OAuth redirect"),
    sf_base_url: credentialFields.sf_base_url
      .optional()
      .describe(
        "Your org instance / My Domain URL. Recommended: a code issued by a My Domain " +
          "authorize endpoint must be exchanged at the same host. Pass the same value used " +
          "in sf_get_oauth_auth_url. When omitted, falls back to login/test.salesforce.com."
      ),
    redirect_uri: z
      .string()
      .url()
      .default("https://login.salesforce.com/services/oauth2/success")
      .describe("Same redirect URI returned by sf_get_oauth_auth_url"),
    sandbox: z
      .boolean()
      .default(false)
      .describe(
        "Exchange against test.salesforce.com (sandbox) instead of login.salesforce.com. Ignored when sf_base_url is set."
      ),
  })
  .strict();

// ─── Validate / Inspect ───────────────────────────────────────────────────────

export const ValidateSalesforceConnectionSchema = z
  .object({ ...credentialFields })
  .strict();

export const ListSObjectsSchema = z
  .object({
    ...credentialFields,
    include_custom: z.boolean().default(true).describe("Include custom (__c) objects"),
    filter: z.string().optional().describe("Substring filter on object name/label"),
    limit: z.number().int().min(1).max(200).default(50).describe("Max objects to return"),
    offset: z.number().int().min(0).default(0).describe("Pagination offset"),
  })
  .strict();

export const DescribeSObjectSchema = z
  .object({
    ...credentialFields,
    object_name: sobjectNameSchema.describe(
      "SObject API name to describe, e.g. 'Account' or 'My_Custom__c'"
    ),
  })
  .strict();

// ─── CDC / Platform Events ────────────────────────────────────────────────────

const cdcEventTypes = z.enum(["onCreate", "onUpdate", "onDelete", "onRestore"]);

/**
 * Listener spec. Exactly one of `sobject`, `all_changes`, or `platform_event`
 * must be set. Enforced via .refine() so the model gets a clear error.
 */
const cdcListenerSpec = z
  .object({
    sobject: sobjectNameSchema.optional().describe(
      "SObject API name for object-scoped CDC (e.g. 'Account'). Generates channel /data/AccountChangeEvent."
    ),
    all_changes: z
      .boolean()
      .optional()
      .describe(
        "Listen on /data/ChangeEvents for all CDC-enabled objects in the org."
      ),
    platform_event: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*__e$/, "Platform event names must end with __e")
      .optional()
      .describe("Platform event API name ending in __e (e.g. 'MyEvent__e')."),
    events: z
      .array(cdcEventTypes)
      .optional()
      .describe(
        "CDC callbacks to scaffold (default: all four). Ignored for platform events."
      ),
  })
  .refine(
    (v) =>
      [v.sobject, v.all_changes, v.platform_event].filter(Boolean).length === 1,
    {
      message:
        "Specify exactly one of: sobject, all_changes, or platform_event.",
    }
  );

// ─── Scaffold ─────────────────────────────────────────────────────────────────

const defaultBiPath = getDefaultBIPath();

export const ScaffoldProjectSchema = z
  .object({
    project_name: projectNameSchema
      .default("salesforce_integration")
      .describe("Ballerina package name (default: salesforce_integration)"),
    org_name: orgNameSchema
      .default("wso2bi")
      .describe("Ballerina org name written to Ballerina.toml (default: wso2bi)"),
    bi_path: z
      .string()
      .min(1)
      .default(defaultBiPath)
      .describe(
        `Path to your WSO2 Integrator (BI) workspace. Defaults to ${defaultBiPath}.`
      ),
    ...credentialFields,
    target_objects: z
      .array(sobjectNameSchema)
      .min(1)
      .default(["Account", "Contact", "Lead", "Opportunity"])
      .describe(
        "SObject API names to scaffold (default: Account, Contact, Lead, Opportunity). " +
          "Standard SObjects use pre-built types from ballerinax/salesforce.types — no describe call required."
      ),
    cdc_listeners: z
      .array(cdcListenerSpec)
      .optional()
      .describe(
        "Optional CDC / Platform Event listeners to scaffold alongside the REST service. " +
          "Each entry generates a salesforce:Listener bound to a channel, with onCreate/onUpdate/onDelete/onRestore stubs for CDC or onMessage for platform events."
      ),
    port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .default(DEFAULT_SERVICE_PORT)
      .describe(`HTTP listener port baked into the generated service (default: ${DEFAULT_SERVICE_PORT})`),
    rest_api: z
      .boolean()
      .default(false)
      .describe(
        "Generate an HTTP REST API (health + CRUD routes) bound to `port` (default: FALSE). " +
          "Default false = CDC-only project: no http:Listener is created, so NO port is bound " +
          "and the 'Address already in use' failure mode is impossible (requires at least one cdc_listener). " +
          "Set true ONLY if you want HTTP CRUD/health endpoints in addition to (or instead of) CDC. " +
          "CometD/CDC is an outbound connection and needs no inbound port — ask the user whether they " +
          "actually need the REST API before enabling it."
      ),
    sandbox: sandboxField,
  })
  .strict();

// ─── Quickstart (one-shot setup) ──────────────────────────────────────────────

export const QuickstartSchema = z
  .object({
    ...credentialFields,
    project_name: projectNameSchema
      .default("salesforce_integration")
      .describe("Ballerina package name (default: salesforce_integration)"),
    org_name: orgNameSchema
      .default("wso2bi")
      .describe("Ballerina org name (default: wso2bi)"),
    bi_path: z
      .string()
      .min(1)
      .default(defaultBiPath)
      .describe(`WSO2 BI workspace path (default: ${defaultBiPath})`),
    target_objects: z
      .array(sobjectNameSchema)
      .min(1)
      .default(["Account", "Contact", "Lead", "Opportunity"])
      .describe("SObject API names (default: Account, Contact, Lead, Opportunity)"),
    build: z
      .boolean()
      .default(false)
      .describe(
        "Run 'bal build' after scaffolding to verify the project compiles. " +
          "Adds 30-90s but catches credential or version mismatches early."
      ),
    run: z
      .boolean()
      .default(true)
      .describe(
        "Start 'bal run' in the background after scaffolding (default: true). " +
          "No new terminal window is opened — the service runs as a tracked child process. " +
          "Tail logs with sf_get_project_logs and stop it with sf_stop_project (both take the returned PID)."
      ),
    cdc_listeners: z
      .array(cdcListenerSpec)
      .optional()
      .describe(
        "Optional CDC / Platform Event listeners to scaffold alongside the REST service."
      ),
    port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .default(DEFAULT_SERVICE_PORT)
      .describe(`HTTP listener port (default: ${DEFAULT_SERVICE_PORT})`),
    rest_api: z
      .boolean()
      .default(false)
      .describe(
        "Generate an HTTP REST API (health + CRUD routes) bound to `port` (default: FALSE = CDC-only, " +
          "no port bound, no port-collision failure mode; requires at least one cdc_listener). " +
          "Set true ONLY if you need HTTP CRUD/health endpoints — ask the user first."
      ),
    sandbox: sandboxField,
  })
  .strict();

// ─── Add CDC Listener ─────────────────────────────────────────────────────────

export const AddCdcListenerSchema = z
  .object({
    project_path: z.string().min(1).describe("Path to the existing Ballerina project"),
    listener: cdcListenerSpec,
  })
  .strict();

// ─── Config / Build / Deploy / Add object ─────────────────────────────────────

export const WriteConfigTomlSchema = z
  .object({
    project_path: z.string().min(1).describe("Path to the Ballerina project directory"),
    ...credentialFields,
  })
  .strict();

export const BuildProjectSchema = z
  .object({
    project_path: z.string().min(1).describe("Path to the Ballerina project to build"),
  })
  .strict();

const servicePortField = z
  .number()
  .int()
  .min(1024)
  .max(65535)
  .default(DEFAULT_SERVICE_PORT)
  .describe(`HTTP listener port (default: ${DEFAULT_SERVICE_PORT})`);

export const DeployProjectSchema = z
  .object({
    project_path: z.string().min(1).describe("Path to the Ballerina project to deploy"),
    port: servicePortField,
  })
  .strict();

export const StopProjectSchema = z
  .object({
    pid: z
      .number()
      .int()
      .positive()
      .describe("PID returned by sf_deploy_project. Only processes started by this server can be stopped."),
  })
  .strict();

export const CheckPrerequisitesSchema = z.object({}).strict();

// ─── Postman import ───────────────────────────────────────────────────────────

export const GeneratePostmanCollectionSchema = z
  .object({
    sf_client_id: credentialFields.sf_client_id,
    sf_client_secret: credentialFields.sf_client_secret,
    sf_base_url: credentialFields.sf_base_url,
    username: z
      .string()
      .min(1)
      .describe("Salesforce username (email). Used to auto-obtain a refresh token via the password flow."),
    password: z
      .string()
      .min(1)
      .describe(
        "Salesforce password. Append your security token if required: myPassword + ABC123 → myPasswordABC123"
      ),
    redirect_uri: z
      .string()
      .url()
      .default("https://login.salesforce.com/services/oauth2/success")
      .describe("Redirect URI registered in your Connected App (also written into the collection)."),
    collection_name: z
      .string()
      .min(1)
      .default("Salesforce Integration")
      .describe("Display name for the Postman collection (default: 'Salesforce Integration')."),
    output_path: z
      .string()
      .optional()
      .describe(
        "Where to save the .postman_collection.json. " +
          "Defaults to ~/WSO2Integrator/<collection_name>.postman_collection.json"
      ),
  })
  .strict();

export const ImportPostmanCredentialsSchema = z
  .object({
    postman_file: z
      .string()
      .min(1)
      .describe(
        "Absolute or ~-relative path to a .postman_collection.json file. " +
          "The tool extracts Salesforce credentials and returns them ready for sf_quickstart."
      ),
    validate: z
      .boolean()
      .default(true)
      .describe(
          "Make a live Salesforce API call to confirm the extracted credentials work (default: true)."
      ),
  })
  .strict();

// ─── Password-flow OAuth (no browser needed) ──────────────────────────────────

export const GetTokenPasswordFlowSchema = z
  .object({
    sf_client_id: credentialFields.sf_client_id,
    sf_client_secret: credentialFields.sf_client_secret,
    username: z
      .string()
      .min(1)
      .describe("Salesforce username (email), e.g. me@myorg.com"),
    password: z
      .string()
      .min(1)
      .describe(
        "Salesforce password. If your org uses a security token, append it directly: password+securitytoken"
      ),
    sf_base_url: credentialFields.sf_base_url,
  })
  .strict();

export const ReauthProjectSchema = z
  .object({
    project_path: z
      .string()
      .min(1)
      .describe("Absolute or ~-relative path to the existing Ballerina project to update"),
    sf_client_id: credentialFields.sf_client_id,
    sf_client_secret: credentialFields.sf_client_secret,
    sf_base_url: credentialFields.sf_base_url.describe(
      "Your Salesforce org instance URL, e.g. https://myorg.my.salesforce.com. " +
        "The token exchange POST is sent to this host's /services/oauth2/token endpoint."
    ),
    code: z
      .string()
      .min(1)
      .describe(
        "Authorization code from the OAuth redirect — the 'code' query parameter in the browser's redirect URL"
      ),
    redirect_uri: z
      .string()
      .url()
      .default("https://login.salesforce.com/services/oauth2/success")
      .describe(
        "Redirect URI registered in your Connected App. Must exactly match the value used when the auth URL was generated."
      ),
  })
  .strict();

export const SetupGuideSchema = z
  .object({
    sandbox: z
      .boolean()
      .default(false)
      .describe("Generate the sandbox (test.salesforce.com) variant of the guide."),
  })
  .strict();

export const AddCustomObjectSchema = z
  .object({
    project_path: z.string().min(1).describe("Path to the existing Ballerina project"),
    ...credentialFields,
    object_name: sobjectNameSchema.describe(
      "SObject API name to add, e.g. 'My_Custom__c'"
    ),
  })
  .strict();

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type GetOAuthAuthUrlInput = z.infer<typeof GetOAuthAuthUrlSchema>;
export type ExchangeOAuthCodeInput = z.infer<typeof ExchangeOAuthCodeSchema>;
export type ValidateSalesforceConnectionInput = z.infer<typeof ValidateSalesforceConnectionSchema>;
export type ListSObjectsInput = z.infer<typeof ListSObjectsSchema>;
export type DescribeSObjectInput = z.infer<typeof DescribeSObjectSchema>;
export type ScaffoldProjectInput = z.infer<typeof ScaffoldProjectSchema>;
export type QuickstartInput = z.infer<typeof QuickstartSchema>;
export type WriteConfigTomlInput = z.infer<typeof WriteConfigTomlSchema>;
export type BuildProjectInput = z.infer<typeof BuildProjectSchema>;
export type DeployProjectInput = z.infer<typeof DeployProjectSchema>;
export type AddCustomObjectInput = z.infer<typeof AddCustomObjectSchema>;
export type AddCdcListenerInput = z.infer<typeof AddCdcListenerSchema>;
export type CdcListenerSpec = z.infer<typeof cdcListenerSpec>;
export type StopProjectInput = z.infer<typeof StopProjectSchema>;
export type CheckPrerequisitesInput = z.infer<typeof CheckPrerequisitesSchema>;
export type SetupGuideInput = z.infer<typeof SetupGuideSchema>;
export type ImportPostmanCredentialsInput = z.infer<typeof ImportPostmanCredentialsSchema>;
export type GetTokenPasswordFlowInput = z.infer<typeof GetTokenPasswordFlowSchema>;
export type GeneratePostmanCollectionInput = z.infer<typeof GeneratePostmanCollectionSchema>;

export const GetProjectLogsSchema = z
  .object({
    pid: z.number().int().positive().describe("PID returned by sf_deploy_project."),
    lines: z.number().int().positive().optional().default(100).describe("Number of tail lines to return (default 100)."),
  })
  .strict();

export type GetProjectLogsInput = z.infer<typeof GetProjectLogsSchema>;
export type ReauthProjectInput = z.infer<typeof ReauthProjectSchema>;
