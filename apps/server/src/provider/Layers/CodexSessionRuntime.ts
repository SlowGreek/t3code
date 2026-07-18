import {
  ApprovalRequestId,
  DEFAULT_MODEL,
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderInteractionMode,
  type ProviderRequestKind,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { buildCodexDeveloperInstructions } from "../CodexDeveloperInstructions.ts";
const decodeV2TurnStartResponse = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnStartResponse);
const decodeV2TurnSteerParams = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnSteerParams);

const PROVIDER = ProviderDriverKind.make("codex");

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];

export function hasConfiguredMcpServer(appServerArgs: ReadonlyArray<string> | undefined): boolean {
  return appServerArgs?.some((argument) => argument.includes("mcp_servers.")) === true;
}

export const CodexResumeCursorSchema = Schema.Struct({
  threadId: Schema.String,
});
const CodexUserInputAnswerObject = Schema.Struct({
  answers: Schema.Array(Schema.String),
});
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);
const isCodexUserInputAnswerObject = Schema.is(CodexUserInputAnswerObject);
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

// TODO: Verify `packages/effect-codex-app-server/scripts/generate.ts` so the generated
// `V2TurnStartParams` schema includes `collaborationMode` directly.
const CodexTurnStartParamsWithCollaborationMode = EffectCodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(EffectCodexSchema.V2TurnStartParams__CollaborationMode),
  }),
);
const decodeCodexTurnStartParamsWithCollaborationMode = Schema.decodeUnknownEffect(
  CodexTurnStartParamsWithCollaborationMode,
);

export type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;

export type CodexResumeCursor = typeof CodexResumeCursorSchema.Type;
type CodexServiceTier = NonNullable<EffectCodexSchema.V2ThreadStartParams["serviceTier"]>;
type CodexThreadItem =
  | EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number]["items"][number]
  | EffectCodexSchema.V2ThreadRollbackResponse["thread"]["turns"][number]["items"][number];

export interface CodexSessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly resumeCursor?: CodexResumeCursor;
  readonly appServerArgs?: ReadonlyArray<string>;
  readonly mcpServer?: CodexThreadMcpServerConfig;
  readonly connection?: CodexAppServerConnection;
  readonly clientTools?: ReadonlyMap<string, CodexDynamicClientTool>;
}

export type CodexDynamicClientTool = (
  input: EffectCodexSchema.DynamicToolCallParams,
) => Effect.Effect<EffectCodexSchema.DynamicToolCallResponse, CodexErrors.CodexAppServerError>;

export interface CodexThreadMcpServerConfig {
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

export interface CodexAppServerConnectionOptions {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly appServerArgs?: ReadonlyArray<string>;
}

export interface CodexAppServerConnection {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly exitCode: ChildProcessSpawner.ChildProcessHandle["exitCode"];
}

export interface CodexSessionRuntimeSendTurnInput {
  readonly clientUserMessageId?: string;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort | undefined;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<CodexThreadItem>;
}

export interface CodexThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<CodexThreadTurnSnapshot>;
}

export interface CodexSessionRuntimeShape {
  readonly start: () => Effect.Effect<ProviderSession, CodexSessionRuntimeError>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly sendTurn: (
    input: CodexSessionRuntimeSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly interruptTurn: (turnId?: TurnId) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly readThread: Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly rollbackThread: (
    numTurns: number,
  ) => Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly syncThreadLifecycle: (
    action:
      | { readonly type: "archive" }
      | { readonly type: "unarchive" }
      | { readonly type: "delete" }
      | { readonly type: "name"; readonly name: string }
      | { readonly type: "compact" },
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly respondToRequest: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly respondToUserInput: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly events: Stream.Stream<ProviderEvent, never>;
  readonly close: Effect.Effect<void>;
}

export type CodexSessionRuntimeError =
  | CodexErrors.CodexAppServerError
  | CodexSessionRuntimePendingApprovalNotFoundError
  | CodexSessionRuntimePendingUserInputNotFoundError
  | CodexSessionRuntimeInvalidUserInputAnswersError
  | CodexSessionRuntimeActiveTurnNotSteerableError
  | CodexSessionRuntimeThreadIdMissingError;

export class CodexSessionRuntimePendingApprovalNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingApprovalNotFoundError>()(
  "CodexSessionRuntimePendingApprovalNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex approval request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimePendingUserInputNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingUserInputNotFoundError>()(
  "CodexSessionRuntimePendingUserInputNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex user input request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimeInvalidUserInputAnswersError extends Schema.TaggedErrorClass<CodexSessionRuntimeInvalidUserInputAnswersError>()(
  "CodexSessionRuntimeInvalidUserInputAnswersError",
  {
    questionId: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid Codex user input answers for question '${this.questionId}'`;
  }
}

export class CodexSessionRuntimeThreadIdMissingError extends Schema.TaggedErrorClass<CodexSessionRuntimeThreadIdMissingError>()(
  "CodexSessionRuntimeThreadIdMissingError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Codex session is missing a provider thread id for ${this.threadId}`;
  }
}

export class CodexSessionRuntimeActiveTurnNotSteerableError extends Schema.TaggedErrorClass<CodexSessionRuntimeActiveTurnNotSteerableError>()(
  "CodexSessionRuntimeActiveTurnNotSteerableError",
  {
    turnId: TurnId,
    turnKind: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.turnKind
      ? `The active Codex ${this.turnKind} turn cannot be steered.`
      : "The active Codex turn cannot be steered.";
  }
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly jsonRpcId: string;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface ApprovalCorrelation {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
}

interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

type CodexServerNotification = {
  readonly [M in CodexRpc.ServerNotificationMethod]: {
    readonly method: M;
    readonly params: CodexRpc.ServerNotificationParamsByMethod[M];
  };
}[CodexRpc.ServerNotificationMethod];

function makeCodexServerNotification<M extends CodexRpc.ServerNotificationMethod>(
  method: M,
  params: CodexRpc.ServerNotificationParamsByMethod[M],
): CodexServerNotification {
  return { method, params } as CodexServerNotification;
}

function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }
  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }
  return normalized;
}

function readResumeCursorThreadId(
  resumeCursor: ProviderSession["resumeCursor"],
): string | undefined {
  return isCodexResumeCursorSchema(resumeCursor) ? resumeCursor.threadId : undefined;
}

function runtimeModeToThreadConfig(input: RuntimeMode): {
  readonly approvalPolicy: EffectCodexSchema.V2ThreadStartParams__AskForApproval;
  readonly sandbox: EffectCodexSchema.V2ThreadStartParams__SandboxMode;
} {
  switch (input) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      };
  }
}

function buildThreadStartParams(input: {
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly mcpServer?: CodexThreadMcpServerConfig;
}): EffectCodexSchema.V2ThreadStartParams {
  const config = runtimeModeToThreadConfig(input.runtimeMode);
  return {
    cwd: input.cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.mcpServer
      ? {
          config: {
            mcp_servers: {
              "t3-code": {
                url: input.mcpServer.endpoint,
                http_headers: {
                  Authorization: input.mcpServer.authorizationHeader,
                },
              },
            },
          },
        }
      : {}),
  };
}

function runtimeModeToTurnSandboxPolicy(
  input: RuntimeMode,
): EffectCodexSchema.V2TurnStartParams__SandboxPolicy {
  switch (input) {
    case "approval-required":
      return {
        type: "readOnly",
      };
    case "auto-accept-edits":
      return {
        type: "workspaceWrite",
      };
    case "full-access":
    default:
      return {
        type: "dangerFullAccess",
      };
  }
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: ProviderInteractionMode;
  readonly model?: string;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
}): EffectCodexSchema.V2TurnStartParams__CollaborationMode | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? DEFAULT_MODEL;
  const reasoningEffort = input.effort ?? "medium";
  return {
    mode: input.interactionMode,
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: buildCodexDeveloperInstructions(input.interactionMode, {
        model,
        reasoningEffort,
      }),
    },
  };
}

export function buildTurnStartParams(input: {
  readonly threadId: string;
  readonly runtimeMode: RuntimeMode;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
  readonly interactionMode?: ProviderInteractionMode;
}): Effect.Effect<
  CodexTurnStartParamsWithCollaborationMode,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnStartParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }

  const config = runtimeModeToThreadConfig(input.runtimeMode);
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  });

  return decodeCodexTurnStartParamsWithCollaborationMode({
    threadId: input.threadId,
    input: turnInput,
    approvalPolicy: config.approvalPolicy,
    sandboxPolicy: runtimeModeToTurnSandboxPolicy(input.runtimeMode),
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  }).pipe(
    Effect.mapError((cause) =>
      CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
        "decode-request-payload",
        cause,
        { method: "turn/start" },
      ),
    ),
  );
}

export function buildTurnSteerParams(input: {
  readonly threadId: string;
  readonly expectedTurnId: string;
  readonly clientUserMessageId: string;
  readonly turnInput: ReadonlyArray<EffectCodexSchema.V2TurnSteerParams__UserInput>;
}): Effect.Effect<
  EffectCodexSchema.V2TurnSteerParams,
  CodexErrors.CodexAppServerProtocolParseError
> {
  return decodeV2TurnSteerParams({
    threadId: input.threadId,
    expectedTurnId: input.expectedTurnId,
    clientUserMessageId: input.clientUserMessageId,
    input: input.turnInput,
  }).pipe(
    Effect.mapError((cause) =>
      CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
        "decode-request-payload",
        cause,
        { method: "turn/steer" },
      ),
    ),
  );
}

export function isTurnSteerUnavailableError(error: unknown): boolean {
  return (
    isCodexAppServerRequestError(error) &&
    (error.code === -32601 || error.errorMessage.toLowerCase().includes("method not found"))
  );
}

function findActiveTurnNotSteerable(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if ("activeTurnNotSteerable" in value) {
    const detail = value.activeTurnNotSteerable;
    if (typeof detail === "object" && detail !== null && "turnKind" in detail) {
      return typeof detail.turnKind === "string" ? detail.turnKind : "active";
    }
    return "active";
  }
  for (const nested of Object.values(value)) {
    const turnKind = findActiveTurnNotSteerable(nested);
    if (turnKind) return turnKind;
  }
  return undefined;
}

export function activeTurnNotSteerableKind(error: unknown): string | undefined {
  if (!isCodexAppServerRequestError(error)) {
    return undefined;
  }
  return (
    findActiveTurnNotSteerable(error.data) ??
    (error.errorMessage.toLowerCase().includes("active turn") &&
    error.errorMessage.toLowerCase().includes("steer")
      ? "active"
      : undefined)
  );
}

function classifyCodexStderrLine(rawLine: string): { readonly message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }
    if (BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet))) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread")) {
    return false;
  }
  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

type CodexThreadOpenResponse =
  | CodexRpc.ClientRequestResponsesByMethod["thread/start"]
  | CodexRpc.ClientRequestResponsesByMethod["thread/resume"];

type CodexThreadOpenMethod = "thread/start" | "thread/resume";

interface CodexThreadOpenClient {
  readonly request: <M extends CodexThreadOpenMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

export const openCodexThread = (input: {
  readonly client: CodexThreadOpenClient;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly requestedModel: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly resumeThreadId: string | undefined;
  readonly mcpServer?: CodexThreadMcpServerConfig;
}): Effect.Effect<CodexThreadOpenResponse, CodexErrors.CodexAppServerError> => {
  const resumeThreadId = input.resumeThreadId;
  const startParams = buildThreadStartParams({
    cwd: input.cwd,
    runtimeMode: input.runtimeMode,
    model: input.requestedModel,
    serviceTier: input.serviceTier,
    ...(input.mcpServer ? { mcpServer: input.mcpServer } : {}),
  });

  if (resumeThreadId === undefined) {
    return input.client.request("thread/start", startParams);
  }

  return input.client
    .request("thread/resume", {
      threadId: resumeThreadId,
      ...startParams,
    })
    .pipe(
      Effect.catchIf(isRecoverableThreadResumeError, (error) =>
        Effect.logWarning("codex app-server thread resume fell back to fresh start", {
          threadId: input.threadId,
          requestedRuntimeMode: input.runtimeMode,
          resumeThreadId,
          recoverable: true,
          cause: error,
        }).pipe(Effect.andThen(input.client.request("thread/start", startParams))),
      ),
    );
};

function readNotificationThreadId(notification: CodexServerNotification): string | undefined {
  switch (notification.method) {
    case "thread/started":
      return notification.params.thread.id;
    case "error":
    case "thread/status/changed":
    case "thread/archived":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/name/updated":
    case "thread/tokenUsage/updated":
    case "turn/started":
    case "hook/started":
    case "turn/completed":
    case "hook/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/completed":
    case "rawResponseItem/completed":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "serverRequest/resolved":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "thread/compacted":
    case "thread/realtime/started":
    case "thread/realtime/itemAdded":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/error":
    case "thread/realtime/closed":
      return notification.params.threadId;
    default:
      return undefined;
  }
}

function readRouteFields(notification: CodexServerNotification): {
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
} {
  switch (notification.method) {
    case "thread/started":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "turn/started":
    case "turn/completed":
      return {
        turnId: TurnId.make(notification.params.turn.id),
        itemId: undefined,
      };
    case "error":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "turn/diff/updated":
    case "turn/plan/updated":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "serverRequest/resolved":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "item/started":
    case "item/completed":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.item.id),
      };
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.itemId),
      };
    default:
      return {
        turnId: undefined,
        itemId: undefined,
      };
  }
}

function rememberCollabReceiverTurns(
  collabReceiverTurns: Map<string, TurnId>,
  notification: CodexServerNotification,
  parentTurnId: TurnId | undefined,
): void {
  if (!parentTurnId) {
    return;
  }

  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }

  if (notification.params.item.type !== "collabAgentToolCall") {
    return;
  }

  for (const receiverThreadId of notification.params.item.receiverThreadIds) {
    collabReceiverTurns.set(receiverThreadId, parentTurnId);
  }
}

function shouldSuppressChildConversationNotification(
  method: CodexRpc.ServerNotificationMethod,
): boolean {
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/plan/updated" ||
    method === "item/plan/delta"
  );
}

function toCodexUserInputAnswer(
  questionId: string,
  value: ProviderUserInputAnswers[string],
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse__ToolRequestUserInputAnswer,
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  if (typeof value === "string") {
    return Effect.succeed({ answers: [value] });
  }
  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return Effect.succeed({ answers });
  }
  if (isCodexUserInputAnswerObject(value)) {
    return Effect.succeed({ answers: value.answers });
  }
  return Effect.fail(new CodexSessionRuntimeInvalidUserInputAnswersError({ questionId }));
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse["answers"],
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  return Effect.forEach(
    Object.entries(answers),
    ([questionId, value]) =>
      toCodexUserInputAnswer(questionId, value).pipe(
        Effect.map((answer) => [questionId, answer] as const),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
}

function readMcpElicitationFieldLabel(
  fieldId: string,
  field: EffectCodexSchema.McpServerElicitationRequestParams__McpElicitationPrimitiveSchema,
): string {
  return "title" in field && typeof field.title === "string" && field.title.trim()
    ? field.title
    : fieldId;
}

function mcpElicitationOptions(
  field: EffectCodexSchema.McpServerElicitationRequestParams__McpElicitationPrimitiveSchema,
): ReadonlyArray<{ readonly label: string; readonly description: string }> {
  if ("enum" in field && Array.isArray(field.enum)) {
    return field.enum
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => ({ label: entry, description: entry }));
  }
  if (
    "items" in field &&
    field.items &&
    typeof field.items === "object" &&
    "enum" in field.items &&
    Array.isArray(field.items.enum)
  ) {
    return field.items.enum
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => ({ label: entry, description: entry }));
  }
  if ("type" in field && field.type === "boolean") {
    return [
      { label: "Yes", description: "Yes" },
      { label: "No", description: "No" },
    ];
  }
  return [];
}

export function mcpElicitationQuestions(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
): ReadonlyArray<{
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiSelect: boolean;
}> {
  if (payload.mode === "url") {
    return [
      {
        id: "action",
        header: payload.serverName,
        question: payload.message,
        options: [
          { label: "Open", description: payload.url },
          { label: "Decline", description: "Do not continue." },
        ],
        multiSelect: false,
      },
    ];
  }
  return Object.entries(payload.requestedSchema.properties).map(([fieldId, field]) => ({
    id: fieldId,
    header: readMcpElicitationFieldLabel(fieldId, field),
    question:
      "description" in field && typeof field.description === "string"
        ? field.description
        : payload.message,
    options: mcpElicitationOptions(field),
    multiSelect: "type" in field && field.type === "array",
  }));
}

function normalizeMcpElicitationContent(
  answers: ProviderUserInputAnswers,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(answers).map(([key, value]) => {
      if (isCodexUserInputAnswerObject(value)) {
        return [key, value.answers.length === 1 ? value.answers[0] : value.answers];
      }
      return [key, value];
    }),
  );
}

function currentProviderThreadId(session: ProviderSession): string | undefined {
  return readResumeCursorThreadId(session.resumeCursor);
}

function updateSession(
  sessionRef: Ref.Ref<ProviderSession>,
  updates: Partial<ProviderSession>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Ref.update(sessionRef, (session) => ({
      ...session,
      ...updates,
      updatedAt,
    }));
  });
}

function parseThreadSnapshot(
  response: EffectCodexSchema.V2ThreadReadResponse | EffectCodexSchema.V2ThreadRollbackResponse,
): CodexThreadSnapshot {
  return {
    threadId: response.thread.id,
    turns: response.thread.turns.map((turn) => ({
      id: TurnId.make(turn.id),
      items: turn.items,
    })),
  };
}

export const makeCodexAppServerConnection = (
  options: CodexAppServerConnectionOptions,
): Effect.Effect<
  CodexAppServerConnection,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const connectionScope = yield* Scope.Scope;
    // `~` is not shell-expanded when env vars are set via child_process.spawn.
    const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
    const env = {
      ...options.environment,
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
      DO_NOT_TRACK: "1",
      OTEL_SDK_DISABLED: "true",
      CODEX_TELEMETRY_DISABLED: "1",
      CODEX_ANALYTICS_ENABLED: "false",
    };
    const extendEnv = options.environment === undefined;
    const spawnCommand = yield* resolveSpawnCommand(
      options.binaryPath,
      ["app-server", ...(options.appServerArgs ?? [])],
      { env, extendEnv },
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: options.cwd,
          env,
          extendEnv,
          forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, connectionScope),
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerSpawnError({
              command: `${options.binaryPath} app-server`,
              cause,
            }),
        ),
      );

    const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
      Layer.build,
      Effect.provideService(Scope.Scope, connectionScope),
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );

    const stderrRemainderRef = yield* Ref.make("");
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(stderrRemainderRef, (current) => {
          const combined = current + chunk;
          const lines = combined.split("\n");
          const remainder = lines.pop() ?? "";
          return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
        }).pipe(
          Effect.flatMap((lines) =>
            Effect.forEach(
              lines,
              (line) => {
                const classified = classifyCodexStderrLine(line);
                return classified
                  ? Effect.logWarning("Codex App Server stderr", {
                      message: classified.message,
                    })
                  : Effect.void;
              },
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkIn(connectionScope),
    );

    yield* client.request("initialize", buildCodexInitializeParams());
    yield* client.notify("initialized", undefined);
    return {
      client,
      exitCode: child.exitCode,
    };
  });

export const makeCodexSessionRuntime = (
  options: CodexSessionRuntimeOptions,
): Effect.Effect<
  CodexSessionRuntimeShape,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const runtimeScope = yield* Scope.Scope;
    const crypto = yield* Crypto.Crypto;
    const events = yield* Queue.unbounded<ProviderEvent>();
    const pendingApprovalsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingApproval>());
    const approvalCorrelationsRef = yield* Ref.make(new Map<string, ApprovalCorrelation>());
    const pendingUserInputsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingUserInput>());
    const collabReceiverTurnsRef = yield* Ref.make(new Map<string, TurnId>());
    const closedRef = yield* Ref.make(false);
    const connection =
      options.connection ??
      (yield* makeCodexAppServerConnection({
        binaryPath: options.binaryPath,
        ...(options.homePath ? { homePath: options.homePath } : {}),
        ...(options.environment ? { environment: options.environment } : {}),
        cwd: options.cwd,
        ...(options.appServerArgs ? { appServerArgs: options.appServerArgs } : {}),
      }));
    const client = connection.client;
    const serverNotifications = yield* Queue.unbounded<CodexServerNotification>();
    let routedProviderThreadId = readResumeCursorThreadId(options.resumeCursor);
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = (purpose: CodexErrors.CodexAppServerIdentifierPurpose) =>
      crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerIdentifierGenerationError({
              purpose,
              cause,
            }),
        ),
      );

    const sessionCreatedAt = yield* nowIso;
    const initialSession = {
      provider: PROVIDER,
      ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
      status: "connecting",
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      threadId: options.threadId,
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      createdAt: sessionCreatedAt,
      updatedAt: sessionCreatedAt,
    } satisfies ProviderSession;
    const sessionRef = yield* Ref.make<ProviderSession>(initialSession);
    const offerEvent = (event: ProviderEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const emitEvent = (event: Omit<ProviderEvent, "id" | "provider" | "createdAt">) =>
      Effect.gen(function* () {
        const id = yield* randomUUIDv4("provider-event");
        return yield* offerEvent({
          id: EventId.make(id),
          provider: PROVIDER,
          ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
          createdAt: yield* nowIso,
          ...event,
        });
      });
    const emitSessionEvent = (method: string, message: string) =>
      emitEvent({
        kind: "session",
        threadId: options.threadId,
        method,
        message,
      });

    const settlePendingApprovals = (decision: ProviderApprovalDecision) =>
      Ref.get(pendingApprovalsRef).pipe(
        Effect.flatMap((pendingApprovals) =>
          Effect.forEach(
            Array.from(pendingApprovals.values()),
            (pendingApproval) =>
              Deferred.succeed(pendingApproval.decision, decision).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const settlePendingUserInputs = (answers: ProviderUserInputAnswers) =>
      Ref.get(pendingUserInputsRef).pipe(
        Effect.flatMap((pendingUserInputs) =>
          Effect.forEach(
            Array.from(pendingUserInputs.values()),
            (pendingUserInput) =>
              Deferred.succeed(pendingUserInput.answers, answers).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const handleRawNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        const payload = notification.params;
        const route = readRouteFields(notification);
        const collabReceiverTurns = yield* Ref.get(collabReceiverTurnsRef);
        const notificationThreadId = readNotificationThreadId(notification);
        if (
          notificationThreadId &&
          ((!routedProviderThreadId && !collabReceiverTurns.has(notificationThreadId)) ||
            (routedProviderThreadId &&
              notificationThreadId !== routedProviderThreadId &&
              !collabReceiverTurns.has(notificationThreadId)))
        ) {
          return;
        }
        const childParentTurnId = (() => {
          const providerConversationId = notificationThreadId;
          return providerConversationId
            ? collabReceiverTurns.get(providerConversationId)
            : undefined;
        })();

        rememberCollabReceiverTurns(collabReceiverTurns, notification, route.turnId);
        if (childParentTurnId && shouldSuppressChildConversationNotification(notification.method)) {
          yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
          return;
        }

        let requestId: ApprovalRequestId | undefined;
        let requestKind: ProviderRequestKind | undefined;
        let turnId = childParentTurnId ?? route.turnId;
        let itemId = route.itemId;

        if (notification.method === "serverRequest/resolved") {
          const rawRequestId =
            typeof notification.params.requestId === "string"
              ? notification.params.requestId
              : String(notification.params.requestId);
          const correlation = rawRequestId
            ? (yield* Ref.get(approvalCorrelationsRef)).get(rawRequestId)
            : undefined;
          if (correlation) {
            requestId = correlation.requestId;
            requestKind = correlation.requestKind;
            turnId = correlation.turnId ?? turnId;
            itemId = correlation.itemId ?? itemId;
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.delete(rawRequestId);
              return next;
            });
          }
        }

        yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: notification.method,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          ...(requestId ? { requestId } : {}),
          ...(requestKind ? { requestKind } : {}),
          ...(notification.method === "item/agentMessage/delta"
            ? { textDelta: notification.params.delta }
            : {}),
          ...(payload !== undefined ? { payload } : {}),
        });
      });

    const registerSessionNotification = <M extends CodexRpc.ServerNotificationMethod>(
      method: M,
      accepts: (payload: CodexRpc.ServerNotificationParamsByMethod[M]) => boolean,
      handler: (
        payload: CodexRpc.ServerNotificationParamsByMethod[M],
      ) => Effect.Effect<void, CodexErrors.CodexAppServerError>,
    ) =>
      client
        .registerServerNotification(method, accepts, handler)
        .pipe(Effect.flatMap((unregister) => Effect.addFinalizer(() => unregister)));

    yield* registerSessionNotification(
      "thread/started",
      (payload) => payload.thread.id === routedProviderThreadId,
      (payload) =>
        updateSession(sessionRef, {
          resumeCursor: { threadId: payload.thread.id },
        }),
    );

    yield* registerSessionNotification(
      "turn/started",
      (payload) => payload.threadId === routedProviderThreadId,
      (payload) =>
        updateSession(sessionRef, {
          status: "running",
          activeTurnId: TurnId.make(payload.turn.id),
        }),
    );

    yield* registerSessionNotification(
      "turn/completed",
      (payload) => payload.threadId === routedProviderThreadId,
      (payload) => {
        const lastError =
          payload.turn.status === "failed" && "error" in payload.turn && payload.turn.error
            ? payload.turn.error.message
            : undefined;
        return updateSession(sessionRef, {
          status: payload.turn.status === "failed" ? "error" : "ready",
          activeTurnId: undefined,
          ...(lastError ? { lastError } : {}),
        });
      },
    );

    yield* registerSessionNotification(
      "error",
      (payload) => !payload.threadId || payload.threadId === routedProviderThreadId,
      (payload) => {
        const errorMessage = payload.error.message;
        const willRetry = payload.willRetry;
        return updateSession(sessionRef, {
          status: willRetry ? "running" : "error",
          ...(errorMessage ? { lastError: errorMessage } : {}),
        });
      },
    );

    yield* client
      .registerServerRequest(
        "item/commandExecution/requestApproval",
        (payload) => payload.threadId === routedProviderThreadId,
        (payload) =>
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.make(
              yield* randomUUIDv4("command-approval-request"),
            );
            const turnId = TurnId.make(payload.turnId);
            const itemId = ProviderItemId.make(payload.itemId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();

            yield* Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.set(requestId, {
                requestId,
                jsonRpcId: payload.approvalId ?? payload.itemId,
                requestKind: "command",
                turnId,
                itemId,
                decision,
              });
              return next;
            });
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.set(payload.approvalId ?? payload.itemId, {
                requestId,
                requestKind: "command",
                turnId,
                itemId,
              });
              return next;
            });

            yield* emitEvent({
              kind: "request",
              threadId: options.threadId,
              method: "item/commandExecution/requestApproval",
              requestId,
              requestKind: "command",
              ...(turnId ? { turnId } : {}),
              ...(itemId ? { itemId } : {}),
              payload,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingApprovalsRef, (current) => {
                  const next = new Map(current);
                  next.delete(requestId);
                  return next;
                }),
              ),
            );
            return {
              decision: resolved,
            } satisfies EffectCodexSchema.CommandExecutionRequestApprovalResponse;
          }),
      )
      .pipe(Effect.flatMap((unregister) => Effect.addFinalizer(() => unregister)));

    yield* client
      .registerServerRequest(
        "item/fileChange/requestApproval",
        (payload) => payload.threadId === routedProviderThreadId,
        (payload) =>
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.make(
              yield* randomUUIDv4("file-change-approval-request"),
            );
            const turnId = TurnId.make(payload.turnId);
            const itemId = ProviderItemId.make(payload.itemId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();

            yield* Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.set(requestId, {
                requestId,
                jsonRpcId: payload.itemId,
                requestKind: "file-change",
                turnId,
                itemId,
                decision,
              });
              return next;
            });
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.set(payload.itemId, {
                requestId,
                requestKind: "file-change",
                turnId,
                itemId,
              });
              return next;
            });

            yield* emitEvent({
              kind: "request",
              threadId: options.threadId,
              method: "item/fileChange/requestApproval",
              requestId,
              requestKind: "file-change",
              ...(turnId ? { turnId } : {}),
              ...(itemId ? { itemId } : {}),
              payload,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingApprovalsRef, (current) => {
                  const next = new Map(current);
                  next.delete(requestId);
                  return next;
                }),
              ),
            );
            return {
              decision: resolved,
            } satisfies EffectCodexSchema.FileChangeRequestApprovalResponse;
          }),
      )
      .pipe(Effect.flatMap((unregister) => Effect.addFinalizer(() => unregister)));

    yield* client
      .registerServerRequest(
        "item/permissions/requestApproval",
        (payload) => payload.threadId === routedProviderThreadId,
        (payload) =>
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.make(
              yield* randomUUIDv4("command-approval-request"),
            );
            const turnId = TurnId.make(payload.turnId);
            const itemId = ProviderItemId.make(payload.itemId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();

            yield* Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.set(requestId, {
                requestId,
                jsonRpcId: payload.itemId,
                requestKind: "permissions",
                turnId,
                itemId,
                decision,
              });
              return next;
            });
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.set(payload.itemId, {
                requestId,
                requestKind: "permissions",
                turnId,
                itemId,
              });
              return next;
            });
            yield* emitEvent({
              kind: "request",
              threadId: options.threadId,
              method: "item/permissions/requestApproval",
              requestId,
              requestKind: "permissions",
              turnId,
              itemId,
              payload,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingApprovalsRef, (current) => {
                  const next = new Map(current);
                  next.delete(requestId);
                  return next;
                }),
              ),
            );
            return {
              permissions:
                resolved === "accept" || resolved === "acceptForSession" ? payload.permissions : {},
              scope: resolved === "acceptForSession" ? "session" : "turn",
            } satisfies EffectCodexSchema.PermissionsRequestApprovalResponse;
          }),
      )
      .pipe(Effect.flatMap((unregister) => Effect.addFinalizer(() => unregister)));

    yield* client
      .registerServerRequest(
        "item/tool/requestUserInput",
        (payload) => payload.threadId === routedProviderThreadId,
        (payload) =>
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.make(yield* randomUUIDv4("user-input-request"));
            const turnId = TurnId.make(payload.turnId);
            const itemId = ProviderItemId.make(payload.itemId);
            const answers = yield* Deferred.make<ProviderUserInputAnswers>();

            yield* Ref.update(pendingUserInputsRef, (current) => {
              const next = new Map(current);
              next.set(requestId, {
                requestId,
                turnId,
                itemId,
                answers,
              });
              return next;
            });

            yield* emitEvent({
              kind: "request",
              threadId: options.threadId,
              method: "item/tool/requestUserInput",
              requestId,
              ...(turnId ? { turnId } : {}),
              ...(itemId ? { itemId } : {}),
              payload,
            });

            const resolvedAnswers = yield* Deferred.await(answers).pipe(
              Effect.ensuring(
                Ref.update(pendingUserInputsRef, (current) => {
                  const next = new Map(current);
                  next.delete(requestId);
                  return next;
                }),
              ),
            );

            return {
              answers: yield* toCodexUserInputAnswers(resolvedAnswers).pipe(
                Effect.mapError((error) =>
                  CodexErrors.CodexAppServerRequestError.invalidParams(error.message, {
                    questionId: error.questionId,
                  }),
                ),
              ),
            } satisfies EffectCodexSchema.ToolRequestUserInputResponse;
          }),
      )
      .pipe(Effect.flatMap((unregister) => Effect.addFinalizer(() => unregister)));

    yield* client
      .registerServerRequest(
        "mcpServer/elicitation/request",
        (payload) => payload.threadId === routedProviderThreadId,
        (payload) =>
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.make(yield* randomUUIDv4("user-input-request"));
            const turnId = payload.turnId ? TurnId.make(payload.turnId) : undefined;
            const answers = yield* Deferred.make<ProviderUserInputAnswers>();

            yield* Ref.update(pendingUserInputsRef, (current) => {
              const next = new Map(current);
              next.set(requestId, {
                requestId,
                turnId,
                itemId: undefined,
                answers,
              });
              return next;
            });
            yield* emitEvent({
              kind: "request",
              threadId: options.threadId,
              method: "mcpServer/elicitation/request",
              requestId,
              ...(turnId ? { turnId } : {}),
              payload,
            });
            yield* emitEvent({
              kind: "request",
              threadId: options.threadId,
              method: "item/tool/requestUserInput",
              requestId,
              ...(turnId ? { turnId } : {}),
              payload: {
                itemId: `mcp-elicitation:${requestId}`,
                threadId: routedProviderThreadId ?? options.threadId,
                turnId: payload.turnId ?? `mcp-elicitation:${requestId}`,
                questions: mcpElicitationQuestions(payload),
                mcpElicitation: payload,
              },
            });

            const resolvedAnswers = yield* Deferred.await(answers).pipe(
              Effect.ensuring(
                Ref.update(pendingUserInputsRef, (current) => {
                  const next = new Map(current);
                  next.delete(requestId);
                  return next;
                }),
              ),
            );
            const content = normalizeMcpElicitationContent(resolvedAnswers);
            const urlAction =
              payload.mode === "url" && typeof content.action === "string"
                ? content.action.toLowerCase()
                : undefined;
            const action =
              Object.keys(content).length === 0
                ? ("cancel" as const)
                : urlAction === "decline"
                  ? ("decline" as const)
                  : ("accept" as const);
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              method: "mcpServer/elicitation/resolved",
              requestId,
              ...(turnId ? { turnId } : {}),
              payload: { action, ...(action === "accept" ? { content } : {}) },
            });
            return {
              action,
              ...(action === "accept" ? { content } : {}),
            } satisfies EffectCodexSchema.McpServerElicitationRequestResponse;
          }),
      )
      .pipe(Effect.flatMap((unregister) => Effect.addFinalizer(() => unregister)));

    yield* client
      .registerServerRequest(
        "item/tool/call",
        (payload) => payload.threadId === routedProviderThreadId,
        (payload) =>
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.make(yield* randomUUIDv4("user-input-request"));
            const turnId = TurnId.make(payload.turnId);
            yield* emitEvent({
              kind: "request",
              threadId: options.threadId,
              method: "item/tool/call",
              requestId,
              turnId,
              payload,
            });
            const key = payload.namespace ? `${payload.namespace}/${payload.tool}` : payload.tool;
            const handler = options.clientTools?.get(key) ?? options.clientTools?.get(payload.tool);
            const response = handler
              ? yield* handler(payload)
              : {
                  success: false,
                  contentItems: [
                    {
                      type: "inputText" as const,
                      text: `No trusted client tool is registered for '${key}'.`,
                    },
                  ],
                };
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              method: "item/tool/call/resolved",
              requestId,
              turnId,
              payload: response,
            });
            return response;
          }),
      )
      .pipe(Effect.flatMap((unregister) => Effect.addFinalizer(() => unregister)));

    const registerServerNotification = <M extends CodexRpc.ServerNotificationMethod>(method: M) =>
      client
        .registerServerNotification(
          method,
          () => true,
          (params) =>
            Queue.offer(serverNotifications, makeCodexServerNotification(method, params)).pipe(
              Effect.asVoid,
            ),
        )
        .pipe(Effect.flatMap((unregister) => Effect.addFinalizer(() => unregister)));

    yield* Effect.forEach(
      Object.values(
        CodexRpc.SERVER_NOTIFICATION_METHODS,
      ) as ReadonlyArray<CodexRpc.ServerNotificationMethod>,
      registerServerNotification,
      { concurrency: 1, discard: true },
    );

    yield* Stream.fromQueue(serverNotifications).pipe(
      Stream.runForEach(handleRawNotification),
      Effect.forkIn(runtimeScope),
    );

    yield* connection.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Ref.get(closedRef).pipe(
          Effect.flatMap((closed) => {
            if (closed) {
              return Effect.void;
            }
            const nextStatus = exitCode === 0 ? "closed" : "error";
            return updateSession(sessionRef, {
              status: nextStatus,
              activeTurnId: undefined,
            }).pipe(
              Effect.andThen(
                emitSessionEvent(
                  "session/exited",
                  exitCode === 0
                    ? "Codex App Server exited."
                    : `Codex App Server exited with code ${exitCode}.`,
                ),
              ),
            );
          }),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    const start = Effect.fn("CodexSessionRuntime.start")(function* () {
      yield* emitSessionEvent("session/connecting", "Opening Codex App Server thread.");

      const requestedModel = normalizeCodexModelSlug(options.model);

      const opened = yield* openCodexThread({
        client,
        threadId: options.threadId,
        runtimeMode: options.runtimeMode,
        cwd: options.cwd,
        requestedModel,
        serviceTier: options.serviceTier,
        resumeThreadId: readResumeCursorThreadId(options.resumeCursor),
        ...(options.mcpServer ? { mcpServer: options.mcpServer } : {}),
      });

      const providerThreadId = opened.thread.id;
      routedProviderThreadId = providerThreadId;
      const session = {
        ...(yield* Ref.get(sessionRef)),
        status: "ready",
        cwd: opened.cwd,
        model: opened.model,
        resumeCursor: { threadId: providerThreadId },
        updatedAt: yield* nowIso,
      } satisfies ProviderSession;
      yield* Ref.set(sessionRef, session);
      yield* emitSessionEvent("session/ready", "Codex App Server thread ready.");
      return session;
    });

    const readProviderThreadId = Effect.gen(function* () {
      const providerThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
      if (!providerThreadId) {
        return yield* new CodexSessionRuntimeThreadIdMissingError({
          threadId: options.threadId,
        });
      }
      return providerThreadId;
    });

    const close = Effect.gen(function* () {
      const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
      if (alreadyClosed) {
        return;
      }
      yield* settlePendingApprovals("cancel");
      yield* settlePendingUserInputs({});
      yield* updateSession(sessionRef, {
        status: "closed",
        activeTurnId: undefined,
      });
      yield* emitSessionEvent("session/closed", "Session stopped").pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Codex session closed event.", { cause }),
        ),
      );
      yield* Scope.close(runtimeScope, Exit.void);
      yield* Queue.shutdown(serverNotifications);
      yield* Queue.shutdown(events);
    });

    return {
      start,
      getSession: Ref.get(sessionRef),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          if (options.mcpServer || hasConfiguredMcpServer(options.appServerArgs)) {
            yield* client.request("config/mcpServer/reload", undefined).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to refresh Codex MCP tool catalog before turn.", {
                  cause,
                }),
              ),
            );
          }
          const normalizedModel = normalizeCodexModelSlug(
            input.model ?? (yield* Ref.get(sessionRef)).model,
          );
          const params = yield* buildTurnStartParams({
            threadId: providerThreadId,
            runtimeMode: options.runtimeMode,
            ...(input.input ? { prompt: input.input } : {}),
            ...(input.attachments ? { attachments: input.attachments } : {}),
            ...(normalizedModel ? { model: normalizedModel } : {}),
            ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
          });
          const sessionBeforeSend = yield* Ref.get(sessionRef);
          const activeTurnId =
            sessionBeforeSend.status === "running" ? sessionBeforeSend.activeTurnId : undefined;

          const startTurn = (delivery: "started" | "queued") =>
            Effect.gen(function* () {
              const rawResponse = yield* client.raw.request("turn/start", params);
              const response = yield* decodeV2TurnStartResponse(rawResponse).pipe(
                Effect.mapError((error) =>
                  CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
                    "decode-response-payload",
                    error,
                    { method: "turn/start" },
                  ),
                ),
              );
              return { turnId: TurnId.make(response.turn.id), delivery } as const;
            });

          const accepted = activeTurnId
            ? yield* Effect.gen(function* () {
                const clientUserMessageId =
                  input.clientUserMessageId ?? (yield* randomUUIDv4("steer-message"));
                const steerParams = yield* buildTurnSteerParams({
                  threadId: providerThreadId,
                  expectedTurnId: activeTurnId,
                  clientUserMessageId,
                  turnInput: params.input,
                });
                return yield* client.request("turn/steer", steerParams).pipe(
                  Effect.map((response) => ({
                    turnId: TurnId.make(response.turnId),
                    delivery: "steered" as const,
                  })),
                  Effect.tap((result) =>
                    emitEvent({
                      kind: "notification",
                      threadId: options.threadId,
                      method: "turn/steered",
                      turnId: result.turnId,
                      payload: { clientUserMessageId },
                    }),
                  ),
                  Effect.catchIf(isTurnSteerUnavailableError, () =>
                    startTurn("queued").pipe(
                      Effect.tap((result) =>
                        emitEvent({
                          kind: "notification",
                          threadId: options.threadId,
                          method: "turn/queued",
                          turnId: result.turnId,
                          payload: {
                            clientUserMessageId,
                            reason: "turn/steer is unavailable",
                          },
                        }),
                      ),
                    ),
                  ),
                  Effect.catchIf(
                    (error) => activeTurnNotSteerableKind(error) !== undefined,
                    (error) =>
                      Effect.fail(
                        new CodexSessionRuntimeActiveTurnNotSteerableError({
                          turnId: activeTurnId,
                          turnKind: activeTurnNotSteerableKind(error),
                          cause: error,
                        }),
                      ),
                  ),
                );
              })
            : yield* startTurn("started");
          const { turnId, delivery } = accepted;
          yield* updateSession(sessionRef, {
            status: "running",
            activeTurnId: turnId,
            ...(normalizedModel ? { model: normalizedModel } : {}),
          });
          const resumedProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
          return {
            threadId: options.threadId,
            turnId,
            delivery,
            ...(resumedProviderThreadId
              ? { resumeCursor: { threadId: resumedProviderThreadId } }
              : {}),
          } satisfies ProviderTurnStartResult;
        }),
      interruptTurn: (turnId) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const session = yield* Ref.get(sessionRef);
          const effectiveTurnId = turnId ?? session.activeTurnId;
          if (!effectiveTurnId) {
            return;
          }
          yield* client.request("turn/interrupt", {
            threadId: providerThreadId,
            turnId: effectiveTurnId,
          });
        }),
      readThread: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        const response = yield* client.request("thread/read", {
          threadId: providerThreadId,
          includeTurns: true,
        });
        return parseThreadSnapshot(response);
      }),
      rollbackThread: (numTurns) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const response = yield* client.request("thread/rollback", {
            threadId: providerThreadId,
            numTurns,
          });
          yield* updateSession(sessionRef, {
            status: "ready",
            activeTurnId: undefined,
          });
          return parseThreadSnapshot(response);
        }),
      syncThreadLifecycle: (action) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          switch (action.type) {
            case "archive":
              yield* client.request("thread/archive", { threadId: providerThreadId });
              return;
            case "unarchive":
              yield* client.request("thread/unarchive", { threadId: providerThreadId });
              return;
            case "delete":
              yield* client.request("thread/delete", { threadId: providerThreadId });
              return;
            case "name":
              yield* client.request("thread/name/set", {
                threadId: providerThreadId,
                name: action.name,
              });
              return;
            case "compact":
              yield* client.request("thread/compact/start", { threadId: providerThreadId });
              return;
          }
        }),
      respondToRequest: (requestId, decision) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingApprovalsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingApprovalNotFoundError({
              requestId,
            });
          }
          yield* Ref.update(pendingApprovalsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.decision, decision);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/requestApproval/decision",
            requestId: pending.requestId,
            requestKind: pending.requestKind,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              requestId: pending.requestId,
              requestKind: pending.requestKind,
              decision,
            },
          });
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingUserInputsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingUserInputNotFoundError({
              requestId,
            });
          }
          const codexAnswers = yield* toCodexUserInputAnswers(answers);
          yield* Ref.update(pendingUserInputsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.answers, answers);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/tool/requestUserInput/answered",
            requestId: pending.requestId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              answers: codexAnswers,
            },
          });
        }),
      events: Stream.fromQueue(events),
      close,
    } satisfies CodexSessionRuntimeShape;
  });
