/**
 * Wrapper unit tests.
 *
 * Covers the verification matrix called out in tasks.md task 3.1:
 *   - schema rejection (input and output)
 *   - path violation rejection (out-of-scope, `..`, absolute paths, symlinks)
 *   - cost accounting (token + deploy hooks fire)
 *   - logging shape (matches the session contract)
 *   - token redaction
 *
 * Tests use an in-memory `SessionSink`, a stub `CostCounter`, and a stub
 * `pathResolver` so no real filesystem I/O is needed for the path checks.
 * The handlers are tiny lambdas; the wrapper is what's under test.
 */

import { resolve, sep } from "node:path";

import {
  HandlerError,
  InputSchemaError,
  OutputSchemaError,
  PathScopeError,
  wrapTool,
  type CostCounter,
  type SessionSink,
  type ToolDefinition,
  type ToolInvocationRecord,
  type WrapperRuntime,
} from "../src/wrapper";

/**
 * Test fixtures.
 *
 * `MODULE_ROOT` and `OUTSIDE_ROOT` are platform-portable absolute paths.
 * `path.resolve` is used so the leading drive letter is added on Windows
 * (and not added on Linux/macOS); the orchestrator does the same step on
 * `module.path` from `agent-harness.config.json` before handing it to the
 * wrapper.
 */
const MODULE_ROOT = resolve(`${sep}repo${sep}modules${sep}fanout`);
const OUTSIDE_ROOT = resolve(`${sep}repo${sep}modules${sep}other`);

class InMemorySink implements SessionSink {
  public records: ToolInvocationRecord[] = [];
  public async appendToolRecord(record: ToolInvocationRecord): Promise<void> {
    this.records.push(record);
  }
}

class InMemoryCostCounter implements CostCounter {
  public tokenCalls: number[] = [];
  public deployCalls: number[] = [];
  public recordTokenUsage(usd: number): void {
    this.tokenCalls.push(usd);
  }
  public recordDeployCost(usd: number): void {
    this.deployCalls.push(usd);
  }
}

/**
 * Identity path resolver. Treats every path as already-real. Tests that
 * exercise symlink behaviour override this with a custom resolver.
 */
const identityResolver = (p: string): string => p;

function makeRuntime(overrides: Partial<WrapperRuntime> = {}): {
  runtime: WrapperRuntime;
  sink: InMemorySink;
  costCounter: InMemoryCostCounter;
} {
  const sink = new InMemorySink();
  const costCounter = new InMemoryCostCounter();
  const runtime: WrapperRuntime = {
    moduleRoot: MODULE_ROOT,
    sessionSink: sink,
    costCounter,
    sessionId: "session-test",
    iterationIndex: 0,
    pathResolver: identityResolver,
    ...overrides,
  };
  return { runtime, sink, costCounter };
}

// ---------------------------------------------------------------------------
// Input schema rejection
// ---------------------------------------------------------------------------

describe("wrapTool input schema validation", () => {
  it("rejects inputs that violate the declared schema", async () => {
    const tool: ToolDefinition<{ path: string }, { contents: string }> = {
      name: "module.readFile",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", minLength: 1 } },
        required: ["path"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { contents: { type: "string" } },
        required: ["contents"],
        additionalProperties: false,
      },
      handler: async () => ({ output: { contents: "never reached" } }),
    };
    const wrapped = wrapTool(tool);
    const { runtime, sink } = makeRuntime();

    await expect(
      wrapped({} as unknown as { path: string }, runtime)
    ).rejects.toBeInstanceOf(InputSchemaError);

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      tool: "module.readFile",
      outcome: "input-schema-error",
    });
    expect(sink.records[0].error).toMatch(/path/i);
  });

  it("rejects extra properties when additionalProperties is false", async () => {
    const tool: ToolDefinition<{ path: string }, { contents: string }> = {
      name: "module.readFile",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { contents: { type: "string" } },
        required: ["contents"],
        additionalProperties: false,
      },
      handler: async () => ({ output: { contents: "x" } }),
    };
    const wrapped = wrapTool(tool);
    const { runtime, sink } = makeRuntime();

    await expect(
      wrapped(
        { path: "lib/x.ts", smuggled: "secret" } as unknown as { path: string },
        runtime
      )
    ).rejects.toBeInstanceOf(InputSchemaError);

    expect(sink.records[0].outcome).toBe("input-schema-error");
  });
});

// ---------------------------------------------------------------------------
// Output schema rejection
// ---------------------------------------------------------------------------

describe("wrapTool output schema validation", () => {
  it("rejects outputs that violate the declared schema", async () => {
    const tool: ToolDefinition<Record<string, never>, { passed: boolean }> = {
      name: "sensor.tsc",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: { passed: { type: "boolean" } },
        required: ["passed"],
        additionalProperties: false,
      },
      // Handler returns something that doesn't conform.
      handler: async () => ({
        output: { passed: "yes" } as unknown as { passed: boolean },
      }),
    };
    const wrapped = wrapTool(tool);
    const { runtime, sink } = makeRuntime();

    await expect(wrapped({}, runtime)).rejects.toBeInstanceOf(
      OutputSchemaError
    );

    expect(sink.records[0]).toMatchObject({
      tool: "sensor.tsc",
      outcome: "output-schema-error",
    });
    // Output is absent on rejection because the schema said it wasn't valid.
    expect(sink.records[0].output).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Path scoping
// ---------------------------------------------------------------------------

describe("wrapTool path scoping", () => {
  function makeFileTool(): ToolDefinition<
    { path: string },
    { contents: string }
  > {
    return {
      name: "module.readFile",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", minLength: 1 } },
        required: ["path"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { contents: { type: "string" } },
        required: ["contents"],
        additionalProperties: false,
      },
      handler: async (_input, ctx) => ({
        output: { contents: ctx.resolvedPath ?? "" },
      }),
      pathField: "path",
    };
  }

  it("accepts a relative path inside the module root", async () => {
    const wrapped = wrapTool(makeFileTool());
    const { runtime, sink } = makeRuntime();

    const result = await wrapped({ path: "lib/fanout-stack.ts" }, runtime);

    expect(result.contents).toBe(
      `${MODULE_ROOT}${sep}lib${sep}fanout-stack.ts`
    );
    expect(sink.records[0].outcome).toBe("ok");
  });

  it("rejects paths containing `..` segments", async () => {
    const wrapped = wrapTool(makeFileTool());
    const { runtime, sink } = makeRuntime();

    await expect(
      wrapped({ path: "../other/secret.ts" }, runtime)
    ).rejects.toBeInstanceOf(PathScopeError);

    expect(sink.records[0]).toMatchObject({
      tool: "module.readFile",
      outcome: "path-scope-error",
    });
    expect(sink.records[0].error).toMatch(/\.\./);
  });

  it("rejects absolute paths outside the module root", async () => {
    const wrapped = wrapTool(makeFileTool());
    const { runtime, sink } = makeRuntime();

    await expect(
      wrapped({ path: `${OUTSIDE_ROOT}${sep}leak.ts` }, runtime)
    ).rejects.toBeInstanceOf(PathScopeError);

    expect(sink.records[0].outcome).toBe("path-scope-error");
  });

  it("accepts an absolute path that lies inside the module root", async () => {
    const wrapped = wrapTool(makeFileTool());
    const { runtime, sink } = makeRuntime();

    const inside = `${MODULE_ROOT}${sep}lib${sep}fanout-stack.ts`;
    const result = await wrapped({ path: inside }, runtime);

    expect(result.contents).toBe(inside);
    expect(sink.records[0].outcome).toBe("ok");
  });

  it("rejects a path whose real path resolves outside the module root (symlink)", async () => {
    // The resolver simulates a symlink: anything under MODULE_ROOT/symlink
    // resolves to OUTSIDE_ROOT.
    const escapingResolver = (p: string): string => {
      if (p.startsWith(`${MODULE_ROOT}${sep}symlink`)) {
        return p.replace(`${MODULE_ROOT}${sep}symlink`, OUTSIDE_ROOT);
      }
      return p;
    };
    const wrapped = wrapTool(makeFileTool());
    const { runtime, sink } = makeRuntime({ pathResolver: escapingResolver });

    await expect(
      wrapped({ path: "symlink/leak.ts" }, runtime)
    ).rejects.toBeInstanceOf(PathScopeError);

    expect(sink.records[0].outcome).toBe("path-scope-error");
    expect(sink.records[0].error).toMatch(/symlink|outside module root/);
  });

  it("rejects empty path strings even when the schema only requires `string`", async () => {
    // Tool with NO minLength on path; rely on the wrapper to reject empty.
    const tool: ToolDefinition<{ path: string }, { ok: boolean }> = {
      name: "module.readFile",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      handler: async () => ({ output: { ok: true } }),
      pathField: "path",
    };
    const wrapped = wrapTool(tool);
    const { runtime } = makeRuntime();

    await expect(wrapped({ path: "" }, runtime)).rejects.toBeInstanceOf(
      PathScopeError
    );
  });

  it("rejects paths that contain NUL bytes", async () => {
    const wrapped = wrapTool(makeFileTool());
    const { runtime } = makeRuntime();

    await expect(
      wrapped({ path: "lib/x\0.ts" }, runtime)
    ).rejects.toBeInstanceOf(PathScopeError);
  });

  it("does not engage path scoping for tools that omit pathField", async () => {
    const tool: ToolDefinition<Record<string, never>, { diff: string }> = {
      name: "module.diff",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: { diff: { type: "string" } },
        required: ["diff"],
        additionalProperties: false,
      },
      handler: async () => ({ output: { diff: "no path required" } }),
    };
    const wrapped = wrapTool(tool);
    const { runtime, sink } = makeRuntime();

    const result = await wrapped({}, runtime);
    expect(result.diff).toBe("no path required");
    expect(sink.records[0].outcome).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Cost accounting
// ---------------------------------------------------------------------------

describe("wrapTool cost accounting", () => {
  it("records token usage for tools with category 'tokens'", async () => {
    const tool: ToolDefinition<{ diff: string }, { passed: boolean }> = {
      name: "reviewer.invoke",
      inputSchema: {
        type: "object",
        properties: { diff: { type: "string" } },
        required: ["diff"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { passed: { type: "boolean" } },
        required: ["passed"],
        additionalProperties: false,
      },
      handler: async () => ({
        output: { passed: true },
        cost: { usd: 0.42 },
      }),
      costCategory: "tokens",
    };
    const wrapped = wrapTool(tool);
    const { runtime, sink, costCounter } = makeRuntime();

    await wrapped({ diff: "diff content" }, runtime);

    expect(costCounter.tokenCalls).toEqual([0.42]);
    expect(costCounter.deployCalls).toEqual([]);
    expect(sink.records[0].cost).toEqual({ usd: 0.42, category: "tokens" });
  });

  it("records deploy cost for tools with category 'deploy'", async () => {
    const tool: ToolDefinition<
      Record<string, never>,
      { outcome: "ok" | "deploy-error" }
    > = {
      name: "cdk.deploy",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: { outcome: { type: "string", enum: ["ok", "deploy-error"] } },
        required: ["outcome"],
        additionalProperties: false,
      },
      handler: async () => ({
        output: { outcome: "ok" },
        cost: { usd: 1.25 },
      }),
      costCategory: "deploy",
    };
    const wrapped = wrapTool(tool);
    const { runtime, costCounter, sink } = makeRuntime();

    await wrapped({}, runtime);

    expect(costCounter.deployCalls).toEqual([1.25]);
    expect(costCounter.tokenCalls).toEqual([]);
    expect(sink.records[0].cost).toEqual({ usd: 1.25, category: "deploy" });
  });

  it("does not call cost counters when the tool category is 'none'", async () => {
    const tool: ToolDefinition<Record<string, never>, { passed: boolean }> = {
      name: "sensor.tsc",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: { passed: { type: "boolean" } },
        required: ["passed"],
        additionalProperties: false,
      },
      handler: async () => ({ output: { passed: true } }),
    };
    const wrapped = wrapTool(tool);
    const { runtime, costCounter, sink } = makeRuntime();

    await wrapped({}, runtime);

    expect(costCounter.tokenCalls).toEqual([]);
    expect(costCounter.deployCalls).toEqual([]);
    expect(sink.records[0].cost).toBeUndefined();
  });

  it("rejects negative cost reports as handler errors", async () => {
    const tool: ToolDefinition<{ diff: string }, { passed: boolean }> = {
      name: "reviewer.invoke",
      inputSchema: {
        type: "object",
        properties: { diff: { type: "string" } },
        required: ["diff"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { passed: { type: "boolean" } },
        required: ["passed"],
        additionalProperties: false,
      },
      handler: async () => ({
        output: { passed: true },
        cost: { usd: -1 },
      }),
      costCategory: "tokens",
    };
    const wrapped = wrapTool(tool);
    const { runtime, costCounter, sink } = makeRuntime();

    await expect(wrapped({ diff: "x" }, runtime)).rejects.toBeInstanceOf(
      HandlerError
    );
    expect(costCounter.tokenCalls).toEqual([]);
    expect(sink.records[0].outcome).toBe("handler-error");
  });
});

// ---------------------------------------------------------------------------
// Logging shape and redaction
// ---------------------------------------------------------------------------

describe("wrapTool session record shape", () => {
  it("writes a record matching the session contract on success", async () => {
    const tool: ToolDefinition<{ path: string }, { contents: string }> = {
      name: "module.readFile",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { contents: { type: "string" } },
        required: ["contents"],
        additionalProperties: false,
      },
      handler: async () => ({ output: { contents: "hello" } }),
      pathField: "path",
    };
    const wrapped = wrapTool(tool);
    const { runtime, sink } = makeRuntime({
      sessionId: "session-abc",
      iterationIndex: 3,
    });

    await wrapped({ path: "lib/fanout-stack.ts" }, runtime);

    expect(sink.records).toHaveLength(1);
    const record = sink.records[0];
    expect(record.schemaVersion).toBe("1.0");
    expect(record.sessionId).toBe("session-abc");
    expect(record.iterationIndex).toBe(3);
    expect(record.tool).toBe("module.readFile");
    expect(record.outcome).toBe("ok");
    expect(record.error).toBeUndefined();
    expect(record.input).toEqual({ path: "lib/fanout-stack.ts" });
    expect(record.output).toEqual({ contents: "hello" });
    expect(typeof record.startedAt).toBe("string");
    expect(typeof record.endedAt).toBe("string");
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    // ISO-8601 sanity
    expect(() => new Date(record.startedAt).toISOString()).not.toThrow();
    expect(() => new Date(record.endedAt).toISOString()).not.toThrow();
  });

  it("redacts githubInstallationToken from logged inputs and outputs", async () => {
    type Input = { auth: { githubInstallationToken: string } };
    type Output = { echoToken: string };
    const tool: ToolDefinition<Input, Output> = {
      name: "pr.open",
      inputSchema: {
        type: "object",
        properties: {
          auth: {
            type: "object",
            properties: {
              githubInstallationToken: { type: "string" },
            },
            required: ["githubInstallationToken"],
            additionalProperties: false,
          },
        },
        required: ["auth"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { echoToken: { type: "string" } },
        required: ["echoToken"],
        additionalProperties: false,
      },
      // Handler still gets the real token; the wrapper redacts only the
      // sanitised copies that go to the session sink.
      handler: async (input) => ({
        output: { echoToken: input.auth.githubInstallationToken },
      }),
    };
    const wrapped = wrapTool(tool);
    const { runtime, sink } = makeRuntime();

    const realToken = "ghs_supersecrettoken1234";
    const result = await wrapped(
      { auth: { githubInstallationToken: realToken } },
      runtime
    );

    // Handler saw the real value (it's in the return).
    expect(result.echoToken).toBe(realToken);

    // Sink saw only the redacted form, in both the input and the output.
    const record = sink.records[0];
    const sanitisedInput = record.input as {
      auth: { githubInstallationToken: string };
    };
    expect(sanitisedInput.auth.githubInstallationToken).toBe("[REDACTED]");
    // Output's `echoToken` matches the secret-pattern (`*Token`) so it gets
    // redacted too, by the pattern fallback.
    const sanitisedOutput = record.output as { echoToken: string };
    expect(sanitisedOutput.echoToken).toBe("[REDACTED]");
  });

  it("redacts secrets at any nesting depth", async () => {
    type Input = {
      payload: {
        nested: { token: string; safe: string };
        list: Array<{ password: string }>;
      };
    };
    type Output = { ok: boolean };
    const tool: ToolDefinition<Input, Output> = {
      name: "test.deepRedact",
      inputSchema: {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: {
              nested: {
                type: "object",
                properties: {
                  token: { type: "string" },
                  safe: { type: "string" },
                },
                required: ["token", "safe"],
                additionalProperties: false,
              },
              list: {
                type: "array",
                items: {
                  type: "object",
                  properties: { password: { type: "string" } },
                  required: ["password"],
                  additionalProperties: false,
                },
              },
            },
            required: ["nested", "list"],
            additionalProperties: false,
          },
        },
        required: ["payload"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      handler: async () => ({ output: { ok: true } }),
    };
    const wrapped = wrapTool(tool);
    const { runtime, sink } = makeRuntime();

    await wrapped(
      {
        payload: {
          nested: { token: "secret1", safe: "public" },
          list: [{ password: "secret2" }, { password: "secret3" }],
        },
      },
      runtime
    );

    const sanitised = sink.records[0].input as Input;
    expect(sanitised.payload.nested.token).toBe("[REDACTED]");
    expect(sanitised.payload.nested.safe).toBe("public");
    expect(sanitised.payload.list[0].password).toBe("[REDACTED]");
    expect(sanitised.payload.list[1].password).toBe("[REDACTED]");
  });

  it("captures a record on input-schema rejection without leaking input", async () => {
    type Input = { token: string };
    const tool: ToolDefinition<Input, { ok: boolean }> = {
      name: "test.rejected",
      inputSchema: {
        type: "object",
        properties: { token: { type: "string", minLength: 100 } },
        required: ["token"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      handler: async () => ({ output: { ok: true } }),
    };
    const wrapped = wrapTool(tool);
    const { runtime, sink } = makeRuntime();

    await expect(wrapped({ token: "short" }, runtime)).rejects.toBeInstanceOf(
      InputSchemaError
    );

    const record = sink.records[0];
    expect(record.outcome).toBe("input-schema-error");
    // Even on rejection, the stored input is redacted.
    expect((record.input as Input).token).toBe("[REDACTED]");
  });

  it("captures a record when the handler throws an unexpected error", async () => {
    const tool: ToolDefinition<Record<string, never>, { ok: boolean }> = {
      name: "test.throwing",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      handler: async () => {
        throw new Error("boom");
      },
    };
    const wrapped = wrapTool(tool);
    const { runtime, sink } = makeRuntime();

    await expect(wrapped({}, runtime)).rejects.toBeInstanceOf(HandlerError);
    expect(sink.records[0].outcome).toBe("handler-error");
    expect(sink.records[0].error).toMatch(/boom/);
  });

  it("does not invoke the handler when input validation fails", async () => {
    let handlerCalls = 0;
    const tool: ToolDefinition<{ x: number }, { ok: boolean }> = {
      name: "test.guard",
      inputSchema: {
        type: "object",
        properties: { x: { type: "number" } },
        required: ["x"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      handler: async () => {
        handlerCalls += 1;
        return { output: { ok: true } };
      },
    };
    const wrapped = wrapTool(tool);
    const { runtime } = makeRuntime();

    await expect(
      wrapped({ x: "wrong" } as unknown as { x: number }, runtime)
    ).rejects.toBeInstanceOf(InputSchemaError);
    expect(handlerCalls).toBe(0);
  });

  it("does not invoke the handler when path scope fails", async () => {
    let handlerCalls = 0;
    const tool: ToolDefinition<{ path: string }, { ok: boolean }> = {
      name: "module.readFile",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      handler: async () => {
        handlerCalls += 1;
        return { output: { ok: true } };
      },
      pathField: "path",
    };
    const wrapped = wrapTool(tool);
    const { runtime } = makeRuntime();

    await expect(
      wrapped({ path: "../escape" }, runtime)
    ).rejects.toBeInstanceOf(PathScopeError);
    expect(handlerCalls).toBe(0);
  });
});
