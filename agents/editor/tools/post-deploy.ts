/**
 * `postDeploy.invoke` tool wrapper for the editor agent.
 *
 * The design's editor catalogue declares this tool as:
 *
 *     postDeploy.invoke   `{}`   -> `{outcome, report}`
 *
 * The empty input is intentional. The editor agent does not pick where
 * the harness runs or what it asserts: those are set by the deploy
 * that just landed and the reference module's design. The wrapper
 * supplies everything the runner needs (session id, stack outputs,
 * any upstream deploy logs) from a per-session context the
 * orchestrator updates on every iteration.
 *
 * Why a `PostDeployContext` rather than threading state through
 * `WrapperRuntime`?
 *
 * `WrapperRuntime` lives in `@agent-harness/shared` and is the seam
 * every tool flows through; widening it for one tool would turn a
 * generic primitive into a `postDeploy`-aware one. Instead, the tool
 * factory takes a context object the orchestrator owns and mutates
 * before each iteration:
 *
 *     const ctx: PostDeployContext = { sessionId, stackOutputs: undefined };
 *     const tool = createPostDeployTool(runPostDeploy, ctx);
 *
 *     // Per iteration, after `cdk.deploy` returns:
 *     ctx.stackOutputs = deployResult.stackOutputs;
 *     ctx.deployFailureLogs = deployResult.outcome === "deploy-error"
 *       ? deployResult.logs
 *       : undefined;
 *
 *     // The agent then calls `postDeploy.invoke()` and the wrapper reads
 *     // from `ctx`.
 *
 * The session id on the context normally matches the runtime's
 * session id; the wrapper sanity-checks they agree on each call so a
 * stale context object doesn't smuggle the wrong session into a
 * harness run.
 */

import type { ToolDefinition } from "@agent-harness/shared";
import type {
  PostDeployInput,
  PostDeployOutput,
} from "@agent-harness/post-deploy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mutable context the orchestrator updates each iteration so the tool
 * picks up the latest deploy result without re-creating the tool.
 *
 * The orchestrator is the only writer. The tool reads on every call.
 * The `sessionId` is set once at session start; everything else is
 * iteration-scoped.
 */
export interface PostDeployContext {
  /** Session id the orchestrator pinned at session start. */
  sessionId: string;
  /** Stack outputs from the most recent successful `cdk.deploy`. */
  stackOutputs?: Record<string, string>;
  /**
   * `cdk.deploy` logs from a failing deploy. When set, the runner
   * short-circuits and returns `outcome: "deploy-failure"`. The
   * orchestrator clears this on every successful deploy.
   */
  deployFailureLogs?: string;
}

/**
 * The runner shape the tool wrapper depends on. Matches
 * `@agent-harness/post-deploy`'s exported `runPostDeploy` signature
 * (the second argument, `clients`, is not exposed here because the
 * tool wrapper does not own SDK client lifecycle: standalone-mode
 * defaults are used in production, and tests stub the runner directly).
 */
export type PostDeployRunner = (
  input: PostDeployInput,
) => Promise<PostDeployOutput>;

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Build a `postDeploy.invoke` tool bound to the given runner and
 * context.
 *
 * The tool's input schema is empty `{}` per the design's catalogue;
 * the wrapper enforces no extra properties so the editor agent cannot
 * smuggle through stack outputs or deploy logs (those come from the
 * orchestrator-owned context, not the agent's prompt).
 *
 * The output schema validates the four-outcome union and the `report`
 * shape from `design.md` Data Models. `logs` and `deployLogs` are
 * optional in the contract.
 */
export function createPostDeployTool(
  runner: PostDeployRunner,
  context: PostDeployContext,
): ToolDefinition<Record<string, never>, PostDeployOutput> {
  return {
    name: "postDeploy.invoke",
    description:
      "Run the synthetic post-deploy harness against the most recent " +
      "preview deploy. Returns pass | fail | partial | deploy-failure.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["pass", "fail", "partial", "deploy-failure"],
        },
        report: { type: "object", additionalProperties: true },
        logs: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        deployLogs: { type: "string" },
      },
      required: ["outcome", "report"],
      additionalProperties: false,
    },
    handler: async (_input, ctx) => {
      // Session id consistency check: a misconfigured orchestrator
      // could leave a context object pointing at an older session
      // while the runtime moved on. Surfacing the mismatch as a
      // handler error is preferable to silently running the harness
      // against the wrong deploy.
      if (context.sessionId !== ctx.sessionId) {
        throw new Error(
          `postDeploy.invoke: session id mismatch (context=${JSON.stringify(
            context.sessionId,
          )}, runtime=${JSON.stringify(ctx.sessionId)})`,
        );
      }
      const input: PostDeployInput = {
        sessionId: context.sessionId,
        ...(context.stackOutputs !== undefined
          ? { stackOutputs: context.stackOutputs }
          : {}),
        ...(context.deployFailureLogs !== undefined
          ? { deployFailureLogs: context.deployFailureLogs }
          : {}),
      };
      const output = await runner(input);
      return { output };
    },
  };
}
