import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  validateConnection,
  listSObjects,
  describeSObject,
} from "../services/salesforce.js";
import {
  ValidateSalesforceConnectionSchema,
  ListSObjectsSchema,
  DescribeSObjectSchema,
  ValidateSalesforceConnectionInput,
  ListSObjectsInput,
  DescribeSObjectInput,
} from "../schemas/tools.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { asStructured, credentialsFromParams, errorResult } from "../types.js";
import type { ToolResult } from "../types.js";

export function registerSalesforceTools(server: McpServer): void {

  // ── Validate Connection ───────────────────────────────────────────────────

  server.registerTool(
    "sf_validate_connection",
    {
      title: "Validate Salesforce Connection",
      description: `Tests that the provided Salesforce credentials are valid by making a
live API call to the org. Use this before scaffolding a project to confirm
credentials work.

Returns:
  - connected: boolean
  - org_id: Salesforce Org ID
  - username: Authenticated username
  - instance_url: Confirmed org URL`,
      inputSchema: ValidateSalesforceConnectionSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ValidateSalesforceConnectionInput): Promise<ToolResult> => {
      try {
        const creds = credentialsFromParams(params);
        const info = await validateConnection(creds);
        const result = {
          connected: true,
          org_id: info.orgId,
          username: info.username,
          instance_url: info.instanceUrl,
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

  // ── List SObjects ─────────────────────────────────────────────────────────

  server.registerTool(
    "sf_list_sobjects",
    {
      title: "List Salesforce SObjects",
      description: `Lists SObjects (standard and/or custom) available in the org.
Supports filtering and pagination.

Returns JSON with: total, count, offset, has_more, next_offset (when more), sobjects[].`,
      inputSchema: ListSObjectsSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListSObjectsInput): Promise<ToolResult> => {
      try {
        const creds = credentialsFromParams(params);
        const allObjects = await listSObjects(
          creds,
          params.include_custom,
          params.filter
        );

        const total = allObjects.length;
        const page = allObjects.slice(params.offset, params.offset + params.limit);
        const hasMore = total > params.offset + params.limit;

        const result = {
          total,
          count: page.length,
          offset: params.offset,
          has_more: hasMore,
          ...(hasMore ? { next_offset: params.offset + params.limit } : {}),
          sobjects: page.map((o) => ({
            name: o.name,
            label: o.label,
            label_plural: o.labelPlural,
            custom: o.custom,
          })),
        };

        let text = JSON.stringify(result, null, 2);
        if (text.length > CHARACTER_LIMIT) {
          text =
            text.slice(0, CHARACTER_LIMIT) +
            "\n... (truncated — use limit/offset to paginate)";
        }

        return {
          content: [{ type: "text", text }],
          structuredContent: asStructured(result),
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Describe SObject ──────────────────────────────────────────────────────

  server.registerTool(
    "sf_describe_sobject",
    {
      title: "Describe a Salesforce SObject",
      description: `Returns full field-level metadata for a specific SObject.
Use this to inspect available fields, their types, and relationships before
generating typed Ballerina record definitions.

Errors:
  - "NOT_FOUND": Object does not exist or is not accessible to this user`,
      inputSchema: DescribeSObjectSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: DescribeSObjectInput): Promise<ToolResult> => {
      try {
        const creds = credentialsFromParams(params);
        const describe = await describeSObject(creds, params.object_name);

        const result = {
          name: describe.name,
          label: describe.label,
          label_plural: describe.labelPlural,
          custom: describe.custom,
          field_count: describe.fields.length,
          fields: describe.fields.map((f) => ({
            name: f.name,
            label: f.label,
            type: f.type,
            nillable: f.nillable,
            custom: f.custom,
            reference_to: f.referenceTo ?? [],
          })),
        };

        let text = JSON.stringify(result, null, 2);
        if (text.length > CHARACTER_LIMIT) {
          text =
            text.slice(0, CHARACTER_LIMIT) +
            "\n... (truncated — the object has many fields)";
        }

        return {
          content: [{ type: "text", text }],
          structuredContent: asStructured(result),
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
