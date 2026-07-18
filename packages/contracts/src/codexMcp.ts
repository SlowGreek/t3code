import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const NullableString = Schema.NullOr(Schema.String);

export const CodexMcpResource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  title: Schema.optional(NullableString),
  description: Schema.optional(NullableString),
  mimeType: Schema.optional(NullableString),
});
export type CodexMcpResource = typeof CodexMcpResource.Type;

export const CodexMcpResourceTemplate = Schema.Struct({
  name: Schema.String,
  uriTemplate: Schema.String,
  title: Schema.optional(NullableString),
  description: Schema.optional(NullableString),
  mimeType: Schema.optional(NullableString),
});
export type CodexMcpResourceTemplate = typeof CodexMcpResourceTemplate.Type;

export const CodexMcpTool = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(NullableString),
  description: Schema.optional(NullableString),
  inputSchema: Schema.Unknown,
});
export type CodexMcpTool = typeof CodexMcpTool.Type;

export const CodexMcpServerStatus = Schema.Struct({
  name: Schema.String,
  authStatus: Schema.Literals(["unsupported", "notLoggedIn", "bearerToken", "oAuth"]),
  serverInfo: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.String,
        version: Schema.String,
        title: Schema.optional(NullableString),
        description: Schema.optional(NullableString),
        websiteUrl: Schema.optional(NullableString),
      }),
    ),
  ),
  tools: Schema.Array(CodexMcpTool),
  resources: Schema.Array(CodexMcpResource),
  resourceTemplates: Schema.Array(CodexMcpResourceTemplate),
});
export type CodexMcpServerStatus = typeof CodexMcpServerStatus.Type;

export const CodexMcpOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("status") }),
  Schema.Struct({ type: Schema.Literal("oauth"), server: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("resourceRead"),
    server: Schema.String,
    uri: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    server: Schema.String,
    tool: Schema.String,
    arguments: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("reload") }),
  Schema.Struct({
    type: Schema.Literal("setEnabled"),
    server: Schema.String,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("threadFork") }),
]);
export type CodexMcpOperation = typeof CodexMcpOperation.Type;

export const CodexMcpResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("status"),
    servers: Schema.Array(CodexMcpServerStatus),
  }),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    server: Schema.String,
    authorizationUrl: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("resourceRead"),
    server: Schema.String,
    uri: Schema.String,
    contents: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    server: Schema.String,
    tool: Schema.String,
    content: Schema.Array(Schema.Unknown),
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("reload") }),
  Schema.Struct({
    type: Schema.Literal("setEnabled"),
    server: Schema.String,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("threadFork"),
    providerThreadId: Schema.String,
    name: Schema.optional(NullableString),
    preview: Schema.String,
  }),
]);
export type CodexMcpResult = typeof CodexMcpResult.Type;

export const CodexMcpRequestInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
  operation: CodexMcpOperation,
});
export type CodexMcpRequestInput = typeof CodexMcpRequestInput.Type;

export class CodexMcpRequestError extends Schema.TaggedErrorClass<CodexMcpRequestError>()(
  "CodexMcpRequestError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {}
