import path from "path";
import { readFile, appendFile } from "fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ScaffoldProjectSchema,
  QuickstartSchema,
  WriteConfigTomlSchema,
  BuildProjectSchema,
  DeployProjectSchema,
  AddCustomObjectSchema,
  AddCdcListenerSchema,
  StopProjectSchema,
  CheckPrerequisitesSchema,
  SetupGuideSchema,
  GetProjectLogsSchema,
  ScaffoldProjectInput,
  QuickstartInput,
  WriteConfigTomlInput,
  BuildProjectInput,
  DeployProjectInput,
  AddCustomObjectInput,
  AddCdcListenerInput,
  StopProjectInput,
  SetupGuideInput,
  CdcListenerSpec,
  GetProjectLogsInput,
} from "../schemas/tools.js";
import {
  expandPath,
  safeResolve,
  safeJoin,
  writeFile,
  writeSecretFile,
  directoryExists,
  fileExists,
  balBuild,
  balRun,
  ensurePortAvailable,
  checkBalCli,
  stopBalRun,
  listLiveBalRuns,
  getBalRunLog,
} from "../services/filesystem.js";
import { describeSObject, validateConnection } from "../services/salesforce.js";
import {
  generateBallerinaToml,
  generateConfigToml,
  generateGitignore,
  generateTypesFile,
  generateMainBal,
  generateObjectModule,
  generateReadme,
  generateCdcListener,
  generateAuthRecovery,
  snakeCase,
  safeId,
} from "../services/generator.js";
import {
  isCustomObject,
  validateSalesforceUrl,
  DEFAULT_SERVICE_PORT,
  BAL_DISTRIBUTION,
  BAL_SALESFORCE_CONNECTOR_VERSION,
} from "../constants.js";
import {
  asStructured,
  credentialsFromParams,
  errorResult,
  toErrorEnvelope,
  ToolError,
} from "../types.js";
import type { SalesforceCredentials, ToolResult } from "../types.js";

// ─── Shared scaffold implementation ──────────────────────────────────────────

interface ScaffoldOptions {
  projectName: string;
  orgName: string;
  biPath: string;
  creds: SalesforceCredentials;
  targetObjects: string[];
  sandbox: boolean;
  port: number;
  restApi: boolean;
  cdcListeners?: CdcListenerSpec[];
}

interface ScaffoldOutcome {
  projectPath: string;
  filesCreated: string[];
  truncationWarnings: Array<{ object: string; total: number; emitted: number }>;
  standardObjects: string[];
  customObjects: string[];
  cdcChannels: string[];
  restApi: boolean;
  ballerinaVersion: string;
  ballerinaVersionMatch: boolean;
  ballerinaVersionWarning: string | null;
}

async function scaffoldProject(opts: ScaffoldOptions): Promise<ScaffoldOutcome> {
  const balCheck = await checkBalCli(BAL_DISTRIBUTION);
  if (!balCheck.available) {
    throw new ToolError(
      "BAL_CLI_MISSING",
      "'bal' CLI not found in PATH.",
      "Install Ballerina from https://ballerina.io/downloads/, or set the BAL_BIN env var to the absolute path of your bal binary."
    );
  }

  // Path containment: project_path / bi_path are user-supplied free-form strings;
  // safeResolve ensures the result lives under home, tmp, or SF_MCP_ALLOWED_ROOTS.
  const biAbsPath = safeResolve(opts.biPath);
  const projectPath = safeJoin(biAbsPath, opts.projectName);

  if (await directoryExists(projectPath)) {
    throw new ToolError(
      "ALREADY_EXISTS",
      `Project already exists at ${projectPath}.`,
      "Choose a different project_name or delete the existing directory."
    );
  }

  // Detect naming collisions early — two SObjects that collapse to the same
  // safeId (e.g. 'My_Object__c' and 'My__Object__c') would produce duplicate
  // functions in generated code and a confusing 'bal build' failure.
  const seen = new Map<string, string>();
  for (const o of opts.targetObjects) {
    const id = safeId(o);
    if (seen.has(id)) {
      throw new ToolError(
        "INVALID_INPUT",
        `Naming collision: '${o}' and '${seen.get(id)}' both map to identifier '${id}'.`,
        "Rename one of the SObjects in your org or omit one from target_objects."
      );
    }
    seen.set(id, o);
  }

  // A portless (rest_api=false) project has no http:Listener, so the CDC
  // listeners are the only thing keeping the runtime alive. Without at least
  // one, `bal run` would init and immediately exit — refuse early.
  if (!opts.restApi && (opts.cdcListeners?.length ?? 0) === 0) {
    throw new ToolError(
      "INVALID_INPUT",
      "rest_api=false produces a CDC-only project, but no cdc_listeners were provided.",
      "Add at least one cdc_listener (e.g. { sobject: 'Account' }), or set rest_api=true to generate the REST API."
    );
  }

  const standardObjects = opts.targetObjects.filter((o) => !isCustomObject(o));
  const customObjects = opts.targetObjects.filter(isCustomObject);

  // Only describe custom objects — standard SObjects use pre-built types
  // from ballerinax/salesforce.types, skipping a network round-trip per
  // standard object. Token cache means describes share one access token.
  const customDescribes = await Promise.all(
    customObjects.map((name) => describeSObject(opts.creds, name))
  );

  const filesCreated: string[] = [];
  const version = "1.0.0";

  const write = async (relativePath: string, content: string, secret = false) => {
    const abs = safeJoin(projectPath, relativePath);
    if (secret) {
      await writeSecretFile(abs, content);
    } else {
      await writeFile(abs, content);
    }
    filesCreated.push(abs);
  };

  await write(
    "Ballerina.toml",
    generateBallerinaToml(opts.orgName, opts.projectName, version)
  );
  // Config.toml contains client_secret and refresh_token — write with mode 0600.
  await write(
    "Config.toml",
    generateConfigToml(
      opts.creds.clientId,
      opts.creds.clientSecret,
      opts.creds.refreshToken,
      opts.creds.baseUrl,
      opts.port,
      opts.sandbox,
      opts.orgName,
      opts.projectName,
      /* includePort */ opts.restApi
    ),
    /* secret */ true
  );
  await write(".gitignore", generateGitignore());

  // types.bal carries custom-object record types. CDC callbacks may reference
  // them, so write it regardless of the REST API toggle.
  const types = generateTypesFile(customDescribes);
  await write("types.bal", types.content);

  await write(
    "main.bal",
    generateMainBal(opts.orgName, opts.projectName, opts.targetObjects, opts.port, opts.restApi)
  );

  // CRUD helper modules (account.bal, …) exist only to back the REST routes.
  // A portless CDC-only project doesn't need them.
  if (opts.restApi) {
    for (const objName of opts.targetObjects) {
      await write(`${snakeCase(objName)}.bal`, generateObjectModule(objName));
    }
  }

  const cdcChannels: string[] = [];
  const cdcListenerNames: string[] = [];
  for (const spec of opts.cdcListeners ?? []) {
    const gen = generateCdcListener({
      sobject: spec.sobject,
      allChanges: spec.all_changes,
      platformEvent: spec.platform_event,
      events: spec.events,
    });
    await write(gen.filename, gen.content);
    cdcChannels.push(channelLabel(spec));
    // Collect the listener-variable label so auth_recovery.bal can reconnect it
    // (matches cdcListenerVar(label) in the generator: object CDC → sobject,
    // all-changes → "AllChangeEvents"). Platform events use a different variable
    // name and aren't reconnected by the recovery flow, so skip them here.
    if (spec.platform_event) {
      // not reconnected via auth_recovery
    } else if (spec.all_changes) {
      cdcListenerNames.push("AllChangeEvents");
    } else if (spec.sobject) {
      cdcListenerNames.push(spec.sobject);
    }
  }

  // auth_recovery.bal: a browser self-reauth service (GET /auth/reauth +
  // /auth/callback) that exchanges a new auth code, rewrites Config.toml, and
  // hot-swaps the fresh refresh token into every CDC listener (and sfClient, for
  // REST) with no restart. Emitted for both project shapes:
  //   - REST:     reuses main.bal's http:Listener + sfClient.
  //   - CDC-only: binds its own dedicated listener (the one port a CDC-only
  //               project binds) so the reauth endpoints are reachable.
  await write(
    "auth_recovery.bal",
    generateAuthRecovery(cdcListenerNames, { restApi: opts.restApi, port: opts.port })
  );

  await write(
    "README.md",
    generateReadme(opts.orgName, opts.projectName, biAbsPath, opts.targetObjects, {
      restApi: opts.restApi,
      port: opts.port,
      cdcChannels,
    })
  );

  return {
    projectPath,
    filesCreated,
    truncationWarnings: types.truncated,
    standardObjects,
    customObjects,
    cdcChannels,
    restApi: opts.restApi,
    ballerinaVersion: balCheck.version,
    ballerinaVersionMatch: balCheck.versionMatch,
    ballerinaVersionWarning: balCheck.versionWarning,
  };
}

function channelLabel(spec: CdcListenerSpec): string {
  if (spec.platform_event) return `/event/${spec.platform_event}`;
  if (spec.all_changes) return "/data/ChangeEvents";
  return `/data/${spec.sobject}ChangeEvent`;
}

// ─── Tool registrations ───────────────────────────────────────────────────────

export function registerBallerinaTools(server: McpServer): void {

  // ── Setup Guide (no inputs needed) ────────────────────────────────────────

  server.registerTool(
    "sf_setup_guide",
    {
      title: "Show Salesforce + WSO2 BI Setup Guide",
      description: `Returns a step-by-step guide for first-time users:
how to create a Salesforce Connected App, where to find the Consumer Key/Secret,
how to get a refresh token via sf_get_oauth_auth_url + sf_exchange_oauth_code,
and which tool to call next. Call this when the user says "I'm new" / "where do
I start" / "how do I get credentials".`,
      inputSchema: SetupGuideSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: SetupGuideInput): Promise<ToolResult> => {
      const loginHost = params.sandbox
        ? "https://test.salesforce.com"
        : "https://login.salesforce.com";
      const guide = `
# Salesforce + WSO2 Integrator (BI) Setup Guide

## 1. Create a Salesforce Connected App (one-time)

a. Log in to ${loginHost}.
b. Setup → App Manager → "New Connected App".
c. Enable OAuth Settings:
   - Callback URL: ${loginHost}/services/oauth2/success
   - Selected OAuth Scopes:  api, refresh_token (offline_access)
d. Save. Wait 2-10 minutes for the app to activate.
e. Copy the **Consumer Key** (sf_client_id) and **Consumer Secret** (sf_client_secret).

## 2. Get a refresh token (one-time per user)

Call \`sf_get_oauth_auth_url\` with your sf_client_id. Open the returned URL,
approve access, copy the \`?code=...\` from the redirect URL, then call
\`sf_exchange_oauth_code\` with that code. Save the returned **refresh_token**.

## 3. Find your instance URL

Your sf_base_url looks like \`https://<your-org>.my.salesforce.com\` (or
\`...sandbox.my.salesforce.com\` for sandboxes). It's also returned as
\`instance_url\` by sf_exchange_oauth_code.

## 4. Verify (optional but recommended)

Call \`sf_validate_connection\` to confirm credentials work before scaffolding.

## 5. Scaffold a project

Call \`sf_quickstart\` with the 4 credentials. Defaults cover the rest:
- project_name: \`salesforce_integration\`
- target_objects: \`["Account", "Contact", "Lead", "Opportunity"]\`
- bi_path: \`~/WSO2Integrator\`

Pass \`build: true\` if you want to verify the project compiles.

## 6. Run

\`sf_deploy_project\` starts the service via \`bal run\` in the background.
Stop it later with \`sf_stop_project\`.

## Prerequisites

Call \`sf_check_prerequisites\` to verify Ballerina ${BAL_DISTRIBUTION} is installed.
Connector version: ballerinax/salesforce@${BAL_SALESFORCE_CONNECTOR_VERSION}.
`.trim();

      return {
        content: [{ type: "text", text: guide }],
        structuredContent: {
          login_host: loginHost,
          ballerina_distribution: BAL_DISTRIBUTION,
          connector_version: BAL_SALESFORCE_CONNECTOR_VERSION,
          next_tools: [
            "sf_check_prerequisites",
            "sf_get_oauth_auth_url",
            "sf_exchange_oauth_code",
            "sf_validate_connection",
            "sf_quickstart",
          ],
        },
      };
    }
  );

  // ── Check Prerequisites ───────────────────────────────────────────────────

  server.registerTool(
    "sf_check_prerequisites",
    {
      title: "Check Prerequisites (Ballerina CLI)",
      description: `Verifies that the 'bal' CLI is installed and reports its version.
Run this first to catch missing prerequisites before scaffolding.`,
      inputSchema: CheckPrerequisitesSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (): Promise<ToolResult> => {
      const bal = await checkBalCli(BAL_DISTRIBUTION);
      const result = {
        bal_cli: {
          available: bal.available,
          version: bal.version || null,
          expected_distribution: BAL_DISTRIBUTION,
          version_match: bal.versionMatch,
          ...(bal.versionWarning ? { version_warning: bal.versionWarning } : {}),
        },
        node_version: process.version,
        platform: process.platform,
        recommended_action: !bal.available
          ? "Install Ballerina from https://ballerina.io/downloads/, " +
            "or set BAL_BIN env var to the absolute path of your bal binary."
          : !bal.versionMatch
          ? `Version mismatch — download Ballerina ${BAL_DISTRIBUTION} from https://ballerina.io/downloads/.`
          : "All set. Proceed with sf_get_oauth_auth_url or sf_quickstart.",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: asStructured(result),
        isError: !bal.available,
      };
    }
  );

  // ── Quickstart (one-shot setup) ───────────────────────────────────────────

  server.registerTool(
    "sf_quickstart",
    {
      title: "Salesforce + Ballerina Quickstart (One-Shot Setup)",
      description: `End-to-end setup in a single call:
  1. Validates your Salesforce credentials.
  2. Auto-detects sandbox vs. production from sf_base_url hostname.
  3. Scaffolds a Ballerina project in your WSO2 BI workspace.
     - Standard SObjects use pre-built types from ballerinax/salesforce.types
       (no describe API calls, no generated boilerplate).
     - Custom (__c) objects are described and typed automatically.
  4. Optionally runs 'bal build' to verify compilation.

This is the recommended entry point — most users only need to call this tool.

If you don't yet have credentials, call \`sf_setup_guide\` first.

All inputs except the 4 credential fields have sensible defaults:
  - project_name: salesforce_integration
  - org_name:     wso2bi
  - bi_path:      ~/WSO2Integrator (mac/linux) or %USERPROFILE%\\WSO2Integrator
  - target_objects: ["Account", "Contact", "Lead", "Opportunity"]
  - port:         9090
  - build:        false (set true to compile after scaffolding)`,
      inputSchema: QuickstartSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: QuickstartInput): Promise<ToolResult> => {
      try {
        const creds = credentialsFromParams(params);
        const validated = validateSalesforceUrl(params.sf_base_url);
        const sandbox = params.sandbox ?? validated.isSandbox;

        // Step 1: validate creds before writing anything to disk.
        const conn = await validateConnection(creds);

        // Step 2: scaffold.
        const outcome = await scaffoldProject({
          projectName: params.project_name,
          orgName: params.org_name,
          biPath: params.bi_path,
          creds,
          targetObjects: params.target_objects,
          sandbox: sandbox || conn.isSandbox,
          port: params.port,
          restApi: params.rest_api,
          cdcListeners: params.cdc_listeners,
        });

        // Step 3: optional build.
        let build: { success: boolean; output: string } | undefined;
        if (params.build) {
          build = await balBuild(outcome.projectPath);
        }

        // Step 4: optional background launch (detached 'bal run', no new window).
        // Scaffolding has already succeeded here, so a busy port must NOT throw
        // away the scaffold result — degrade to a warning and let the user free
        // the port (or pick another) before deploying.
        let run:
          | { pid: number | undefined; output: string; started: boolean; logFile: string }
          | undefined;
        let runWarning: string | undefined;
        if (params.run) {
          try {
            if (outcome.restApi) {
              // REST project binds a port — pre-flight it, then pass the override.
              await ensurePortAvailable(params.port);
              run = await balRun(outcome.projectPath, params.port);
            } else {
              // CDC-only project binds no port; launch without a -CservicePort override.
              run = await balRun(outcome.projectPath);
            }
          } catch (err) {
            runWarning = toErrorEnvelope(err).message;
          }
        }

        const status = build
          ? build.success ? "ready" : "scaffold_ok_build_failed"
          : runWarning
          ? "scaffold_ok_port_in_use"
          : run
          ? run.started ? "running" : "scaffold_ok_run_unconfirmed"
          : "scaffold_ok";

        const result = {
          status,
          connection: {
            org_id: conn.orgId,
            username: conn.username,
            instance_url: conn.instanceUrl,
            sandbox: conn.isSandbox,
          },
          project_path: outcome.projectPath,
          files_created: outcome.filesCreated,
          standard_sobjects: outcome.standardObjects,
          custom_sobjects: outcome.customObjects,
          cdc_channels: outcome.cdcChannels,
          ballerina_version: outcome.ballerinaVersion,
          ballerina_version_match: outcome.ballerinaVersionMatch,
          rest_api: outcome.restApi,
          ...(outcome.restApi ? { service_port: params.port } : { mode: "cdc_only" }),
          ...(outcome.ballerinaVersionWarning
            ? { ballerina_version_warning: outcome.ballerinaVersionWarning }
            : {}),
          ...(outcome.truncationWarnings.length > 0
            ? { field_truncation_warnings: outcome.truncationWarnings }
            : {}),
          ...(build ? { build: { success: build.success, output: build.output } } : {}),
          ...(run
            ? { run: { started: run.started, pid: run.pid, log_file: run.logFile, output: run.output } }
            : {}),
          ...(runWarning ? { run_warning: runWarning } : {}),
          next_steps: runWarning
            ? [
                `1. Port ${params.port} is in use, so the service was NOT started. ${runWarning}`,
                `2. Free the port (or stop the other process) and run sf_deploy_project for "${outcome.projectPath}".`,
                `3. Or re-scaffold/deploy on a different port.`,
              ]
            : run
            ? [
                outcome.restApi
                  ? `1. Service is running in the background (PID ${run.pid}) on port ${params.port}.`
                  : `1. CDC integration is running in the background (PID ${run.pid}) — no HTTP port bound.`,
                `2. Tail live logs: sf_get_project_logs with pid=${run.pid}; stop it: sf_stop_project with pid=${run.pid}.`,
                `3. Open the project in VS Code with the Ballerina Integrator extension: ${outcome.projectPath}`,
              ]
            : [
                `1. cd "${outcome.projectPath}"`,
                outcome.restApi
                  ? `2. bal run   # compiles and starts the HTTP service on port ${params.port}`
                  : `2. bal run   # compiles and starts the CDC listeners (no HTTP port)`,
                `3. Open the folder in VS Code with the Ballerina Integrator extension for the BI low-code designer.`,
              ],
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: asStructured(result),
          isError: build ? !build.success : false,
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Scaffold Project (granular) ───────────────────────────────────────────

  server.registerTool(
    "sf_scaffold_project",
    {
      title: "Scaffold Ballerina + Salesforce Project in WSO2 Integrator",
      description: `Creates a Ballerina integration project in your WSO2 Integrator (BI) workspace.

For most users, prefer 'sf_quickstart' — it wraps this plus credential
validation and an optional build step.

Standard SObjects use pre-built types from ballerinax/salesforce.types (no
describe call needed). Custom (__c) objects are described from your org and
typed in types.bal.

Pre-conditions:
  - 'bal' CLI installed (sf_check_prerequisites)
  - target_objects exist in your org (custom objects fail loudly if missing)`,
      inputSchema: ScaffoldProjectSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: ScaffoldProjectInput): Promise<ToolResult> => {
      try {
        const creds = credentialsFromParams(params);
        const validated = validateSalesforceUrl(params.sf_base_url);

        // Validate credentials before writing any files — mirrors sf_quickstart
        // behaviour and prevents generating a project with credentials that
        // will fail at runtime.
        const conn = await validateConnection(creds);
        const sandbox = params.sandbox ?? validated.isSandbox ?? conn.isSandbox;

        const outcome = await scaffoldProject({
          projectName: params.project_name,
          orgName: params.org_name,
          biPath: params.bi_path,
          creds,
          targetObjects: params.target_objects,
          sandbox,
          port: params.port,
          restApi: params.rest_api,
          cdcListeners: params.cdc_listeners,
        });

        const result = {
          project_path: outcome.projectPath,
          files_created: outcome.filesCreated,
          standard_sobjects: outcome.standardObjects,
          custom_sobjects: outcome.customObjects,
          cdc_channels: outcome.cdcChannels,
          ballerina_version: outcome.ballerinaVersion,
          rest_api: outcome.restApi,
          ...(outcome.restApi ? { service_port: params.port } : { mode: "cdc_only" }),
          ...(outcome.truncationWarnings.length > 0
            ? { field_truncation_warnings: outcome.truncationWarnings }
            : {}),
          next_steps: [
            `1. cd "${outcome.projectPath}" && bal run`,
            outcome.restApi
              ? `2. REST API + CDC listeners start on port ${params.port}; or use sf_build_project + sf_deploy_project.`
              : "2. CDC listeners start (no HTTP port); or use sf_build_project + sf_deploy_project.",
            "3. Open the folder in VS Code with the Ballerina Integrator extension.",
          ],
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

  // ── Write / Update Config.toml ────────────────────────────────────────────

  server.registerTool(
    "sf_write_config_toml",
    {
      title: "Write or Update Config.toml with Salesforce Credentials",
      description: `Overwrites Config.toml in an existing Ballerina project with fresh
Salesforce OAuth2 credentials. Useful for rotation. Sandbox is auto-detected
from sf_base_url. File is written with mode 0600 (owner read/write only).`,
      inputSchema: WriteConfigTomlSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: WriteConfigTomlInput): Promise<ToolResult> => {
      try {
        const projectPath = safeResolve(params.project_path);
        if (!(await directoryExists(projectPath))) {
          throw new ToolError("NOT_FOUND", `Project directory not found: ${projectPath}`);
        }

        const validated = validateSalesforceUrl(params.sf_base_url);
        const configPath = safeJoin(projectPath, "Config.toml");
        const ballerinaToml = await readFile(safeJoin(projectPath, "Ballerina.toml"), "utf-8").catch(() => "");
        const orgName = ballerinaToml.match(/^org\s*=\s*"([^"]+)"/m)?.[1] ?? "wso2bi";
        const packageName = ballerinaToml.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? "salesforce_integration";
        await writeSecretFile(
          configPath,
          generateConfigToml(
            params.sf_client_id,
            params.sf_client_secret,
            params.sf_refresh_token,
            params.sf_base_url,
            DEFAULT_SERVICE_PORT,
            validated.isSandbox,
            orgName,
            packageName
          )
        );

        const result = {
          config_path: configPath,
          mode: "0600",
          sandbox: validated.isSandbox,
          message: "Config.toml written with mode 0600 (owner-only read/write).",
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

  // ── Add Custom Object ─────────────────────────────────────────────────────

  server.registerTool(
    "sf_add_custom_object",
    {
      title: "Add a Salesforce SObject to an Existing Ballerina Project",
      description: `Adds a new SObject to an already-scaffolded project.
For standard SObjects: creates a .bal file that uses the pre-built type
from ballerinax/salesforce.types (no types.bal change needed).
For custom (__c) objects: also appends a typed record to types.bal.

Returns the resource-route snippet to paste into main.bal.`,
      inputSchema: AddCustomObjectSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: AddCustomObjectInput): Promise<ToolResult> => {
      try {
        const projectPath = safeResolve(params.project_path);
        if (!(await directoryExists(projectPath))) {
          throw new ToolError("NOT_FOUND", `Project directory not found: ${projectPath}`);
        }

        const snake = snakeCase(params.object_name);
        const moduleFile = safeJoin(projectPath, `${snake}.bal`);
        if (await fileExists(moduleFile)) {
          throw new ToolError(
            "ALREADY_EXISTS",
            `Module file already exists: ${moduleFile}.`,
            "Delete it first if you want to regenerate."
          );
        }

        const filesUpdated: string[] = [];

        if (isCustomObject(params.object_name)) {
          const creds = credentialsFromParams(params);
          const describe = await describeSObject(creds, params.object_name);

          const typesFile = safeJoin(projectPath, "types.bal");
          const existing = await readFile(typesFile, "utf-8").catch(() => "");
          // Match the actual generated declaration, not a substring — avoids
          // false positives like `Foo__c` matching inside `FooBar__c`.
          const safe = safeId(params.object_name);
          const declRegex = new RegExp(
            String.raw`^public\s+type\s+${safe}Record\s+record\b`,
            "m"
          );
          if (!declRegex.test(existing)) {
            const generated = generateTypesFile([describe]);
            await appendFile(typesFile, "\n" + generated.content);
            filesUpdated.push(typesFile);
          }
        }

        await writeFile(moduleFile, generateObjectModule(params.object_name));
        filesUpdated.push(moduleFile);

        const safe = safeId(params.object_name);
        const routeSnippet =
          `    // Paste inside service / on httpListener { ... } in main.bal\n` +
          `    resource function get ${snake}s() returns json|error { return check query${safe}Records(); }\n` +
          `    resource function post ${snake}(...) returns json|error { return check create${safe}Record(body); }\n` +
          `    resource function put ${snake}/[string id](...) returns json|error { return check update${safe}Record(id, body); }\n` +
          `    resource function delete ${snake}/[string id]() returns json|error { return check delete${safe}Record(id); }\n` +
          `    // Replace (...) with the correct parameter type:\n` +
          `    //   standard SObject: sftypes:${params.object_name}SObject body\n` +
          `    //   custom SObject:   ${safe}Record body`;

        const result = {
          files_updated: filesUpdated,
          is_custom_object: isCustomObject(params.object_name),
          manual_step: routeSnippet,
          message: `${params.object_name} module added. Paste the routes snippet into main.bal.`,
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

  // ── Add CDC / Platform-Event Listener ─────────────────────────────────────

  server.registerTool(
    "sf_add_cdc_listener",
    {
      title: "Add a Salesforce CDC or Platform-Event Listener",
      description: `Adds an event-driven listener to an existing scaffolded project.

A Salesforce listener can subscribe to:
  - Object CDC:        /data/<SObjectName>ChangeEvent   (set 'sobject')
  - All CDC events:    /data/ChangeEvents               (set 'all_changes': true)
  - Platform events:   /event/<Name>__e                 (set 'platform_event')

CDC listeners get onCreate/onUpdate/onDelete/onRestore stubs (you can narrow
this via 'events'). Platform-event listeners get onMessage.

The listener reuses the OAuth2 credentials already configured in main.bal —
no extra Config.toml entries required.`,
      inputSchema: AddCdcListenerSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: AddCdcListenerInput): Promise<ToolResult> => {
      try {
        const projectPath = safeResolve(params.project_path);
        if (!(await directoryExists(projectPath))) {
          throw new ToolError("NOT_FOUND", `Project directory not found: ${projectPath}`);
        }

        const gen = generateCdcListener({
          sobject: params.listener.sobject,
          allChanges: params.listener.all_changes,
          platformEvent: params.listener.platform_event,
          events: params.listener.events,
        });

        const targetFile = safeJoin(projectPath, gen.filename);
        if (await fileExists(targetFile)) {
          throw new ToolError(
            "ALREADY_EXISTS",
            `Listener file already exists: ${targetFile}.`,
            "Delete it to regenerate."
          );
        }

        await writeFile(targetFile, gen.content);

        const result = {
          file_created: targetFile,
          channel: channelLabel(params.listener),
          message:
            "Listener added. Run sf_build_project, then sf_deploy_project (or 'bal run' directly) — the listener attaches automatically on startup.",
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

  // ── Build Project ─────────────────────────────────────────────────────────

  server.registerTool(
    "sf_build_project",
    {
      title: "Build Ballerina Project",
      description: `Runs 'bal build' inside the project directory and reports the result.`,
      inputSchema: BuildProjectSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: BuildProjectInput): Promise<ToolResult> => {
      try {
        const projectPath = safeResolve(params.project_path);
        if (!(await directoryExists(projectPath))) {
          throw new ToolError("NOT_FOUND", `Project directory not found: ${projectPath}`);
        }

        const balCheck = await checkBalCli();
        if (!balCheck.available) {
          throw new ToolError("BAL_CLI_MISSING", "'bal' CLI not found in PATH.");
        }

        const buildResult = await balBuild(projectPath);
        const result = {
          success: buildResult.success,
          output: buildResult.output,
          project_path: projectPath,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: !buildResult.success,
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Deploy / Run Project ──────────────────────────────────────────────────

  server.registerTool(
    "sf_deploy_project",
    {
      title: "Deploy and Run Ballerina Project on WSO2 Integrator Runtime",
      description: `Starts the Ballerina service in the background via 'bal run'.
The port is passed through as a Ballerina configurable override so the
reported service_url matches the actual listener.

Returns started=true when the listener has actually come up, plus a PID you
can pass to sf_stop_project to terminate the service later.`,
      inputSchema: DeployProjectSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: DeployProjectInput): Promise<ToolResult> => {
      try {
        const projectPath = safeResolve(params.project_path);
        if (!(await directoryExists(projectPath))) {
          throw new ToolError("NOT_FOUND", `Project directory not found: ${projectPath}`);
        }

        const configPath = path.join(projectPath, "Config.toml");
        if (!(await fileExists(configPath))) {
          throw new ToolError(
            "PRECONDITION_FAILED",
            `Config.toml not found at ${configPath}.`,
            "Run sf_write_config_toml first, or use sf_quickstart to scaffold a new project."
          );
        }

        const balCheck = await checkBalCli();
        if (!balCheck.available) {
          throw new ToolError("BAL_CLI_MISSING", "'bal' CLI not found in PATH.");
        }

        // Detect whether this is a portless CDC-only project (rest_api=false at
        // scaffold time → no http:Listener in main.bal). If so, there is no port
        // to pre-flight and no -CservicePort override to pass.
        const mainBal = await readFile(path.join(projectPath, "main.bal"), "utf-8").catch(() => "");
        const hasHttpService = mainBal.includes("http:Listener");

        if (!hasHttpService) {
          const run = await balRun(projectPath);
          const result = {
            started: run.started,
            pid: run.pid,
            mode: "cdc_only",
            log_file: run.logFile,
            output: run.output,
            message: run.started
              ? `CDC integration started in the background (PID ${run.pid}). No HTTP port is bound.`
              : "bal run was launched but did not confirm startup within the window — check the logs.",
            next_steps: [
              `1. Tail live logs: sf_get_project_logs with pid=${run.pid} (look for 'Acquired leadership for Salesforce CDC channel').`,
              `2. Stop the service: sf_stop_project with pid=${run.pid}.`,
              `3. If you see invalid_grant, run sf_reauth_project then redeploy.`,
            ].join("\n"),
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: asStructured(result),
            isError: !run.started,
          };
        }

        const serviceUrl = `http://localhost:${params.port}`;

        // Pre-flight the port: reclaims a stale 'bal run' WE started, but throws
        // PRECONDITION_FAILED if an unknown process holds it (rather than killing it).
        const { stoppedTracked } = await ensurePortAvailable(params.port);
        const run = await balRun(projectPath, params.port);

        const result = {
          started: run.started,
          pid: run.pid,
          service_url: serviceUrl,
          health_check: `${serviceUrl}/health`,
          log_file: run.logFile,
          output: run.output,
          ...(stoppedTracked.length > 0
            ? { reclaimed_pids: stoppedTracked, reclaimed_note: `Stopped a previous service on port ${params.port} (PID ${stoppedTracked.join(", ")}) before restarting.` }
            : {}),
          message: run.started
            ? `Service started in the background (PID ${run.pid}) on ${serviceUrl}.`
            : "bal run was launched but the listener did not confirm startup within the window — check the logs.",
          next_steps: [
            `1. Tail live logs: sf_get_project_logs with pid=${run.pid}.`,
            `2. Stop the service: sf_stop_project with pid=${run.pid}.`,
            `3. Hit the health check: ${serviceUrl}/health`,
          ].join("\n"),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: asStructured(result),
          isError: !run.started,
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Stop Project ──────────────────────────────────────────────────────────

  server.registerTool(
    "sf_stop_project",
    {
      title: "Stop a Running Ballerina Service",
      description: `Stops a 'bal run' process previously started by sf_deploy_project.
Only PIDs tracked by this server (started via sf_deploy_project during the
current session) can be stopped — for safety we won't kill arbitrary host PIDs.`,
      inputSchema: StopProjectSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: StopProjectInput): Promise<ToolResult> => {
      const before = listLiveBalRuns();
      const res = stopBalRun(params.pid);
      const result = {
        ...res,
        pid: params.pid,
        live_before: before,
        live_after: listLiveBalRuns(),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: asStructured(result),
        isError: !res.stopped,
      };
    }
  );

  // ── sf_get_project_logs ──────────────────────────────────────────────────────
  server.registerTool(
    "sf_get_project_logs",
    {
      title: "Get Live Project Logs",
      description: `Returns the most recent log lines from a running Ballerina project started by sf_deploy_project.
Logs are written to a temp file while the process runs. Pass the PID from sf_deploy_project or sf_list_live_projects.`,
      inputSchema: GetProjectLogsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params: GetProjectLogsInput): Promise<ToolResult> => {
      const runs = listLiveBalRuns();
      const tracked = runs.find((r) => r.pid === params.pid);
      const log = await getBalRunLog(params.pid, params.lines ?? 100);
      const result = {
        pid: params.pid,
        log_file: tracked?.logFile ?? `(pid ${params.pid} not tracked — may have exited)`,
        lines_returned: log.split("\n").length,
        log,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: asStructured(result),
      };
    }
  );
}
