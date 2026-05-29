/**
 * CodeBuild orchestrator entry point.
 *
 * This is the main script executed by the buildspec's `build` phase.
 * It parses configuration from environment variables, runs the bounded loop,
 * and writes the session record to build artifacts.
 *
 * Requirements: 8.1, 8.2, 8.3, 4.6, 11.2, 11.3, 11.4
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadConfig, loadLoopConfig } from "./config";
import { createCodeBuildToolCatalogue } from "./tool-catalogue";
import { createCodeBuildGates } from "./gates";
import {
  runLoop,
  type LoopOptions,
  type LoopGates,
} from "@agent-harness/loop/src/run";
import {
  createSessionFromTrigger,
  InMemorySessionStore,
  type SessionTrigger,
} from "@agent-harness/loop/src/session";
import type { KillSwitchPoll } from "@agent-harness/loop/src/stop-conditions";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Parse config from environment
  const config = loadConfig();
  const loopConfig = loadLoopConfig(config.sourceDir);

  console.log(`[main] Session ID: ${config.sessionId}`);
  console.log(`[main] Local mode: ${config.localMode}`);
  console.log(`[main] Module root: ${config.moduleRoot}`);

  // 2. Build tool catalogue and LoopGates
  const toolCatalogue = createCodeBuildToolCatalogue({ moduleRoot: config.moduleRoot });

  const editorHarnessArn = process.env.EDITOR_HARNESS_ARN ?? "";
  const reviewerHarnessArn = process.env.REVIEWER_HARNESS_ARN ?? "";

  const gates: LoopGates = createCodeBuildGates({
    moduleRoot: config.moduleRoot,
    sessionId: config.sessionId,
    editorHarnessArn,
    reviewerHarnessArn,
    toolCatalogue,
    sensorTimeout: 120_000,
  });

  // In local mode, the openPR gate is a no-op
  const gatesWithPR: LoopGates = {
    ...gates,
    async openPR(_body: string, _partial: boolean): Promise<{ number: number; url: string }> {
      console.log(`[main] Local mode: skipping PR creation`);
      return { number: 0, url: "" };
    },
  };

  // 3. Build session and store
  const sessionTrigger: SessionTrigger = {
    schemaVersion: "1.0",
    triggerType: "script",
    issue: {
      number: config.triggerPayload.issue.number,
      title: config.triggerPayload.issue.title,
      body: "",
      url: "",
      openedBy: "",
    },
    module: {
      path: config.triggerPayload.module.path,
      repository: config.triggerPayload.module.repository || "",
      ref: config.triggerPayload.module.ref || "main",
      commitSha: config.triggerPayload.module.commitSha || "",
    },
    session: {
      id: config.sessionId,
      createdAt: new Date().toISOString(),
    },
    limits: {
      iterationCap: loopConfig.limits.iterationCap,
      wallClockCapMinutes: loopConfig.limits.wallClockCapMinutes,
      tokenSpendCapUSD: loopConfig.limits.tokenSpendCapUSD,
    },
    auth: {},
  };

  const session = createSessionFromTrigger(sessionTrigger);
  const store = new InMemorySessionStore();

  // 4. Build kill switch poll (no-op; CLI-based kill switch is external)
  const killSwitchPoll: KillSwitchPoll = {
    async isAgentStopLabelApplied(): Promise<boolean> {
      return false;
    },
  };

  // 5. Call runLoop
  console.log(`[main] Starting bounded loop...`);

  const loopOptions: LoopOptions = {
    session,
    store,
    config: {
      iterationCap: loopConfig.limits.iterationCap,
      wallClockCapMinutes: loopConfig.limits.wallClockCapMinutes,
      tokenSpendCapUSD: loopConfig.limits.tokenSpendCapUSD,
      oscillation: {
        sameDiffWindow: loopConfig.oscillation.sameDiffWindow,
        alternationWindow: loopConfig.oscillation.alternationWindow,
      },
    },
    killSwitchPoll,
    gates: gatesWithPR,
  };

  const loopResult = await runLoop(loopOptions);

  console.log(`[main] Loop terminated: ${loopResult.terminationReason}`);

  // 6. Write session record to build artifacts
  const sessionRecordPath = path.join(config.sourceDir, "session-record.json");
  let finalSession;
  try {
    finalSession = await store.read(config.sessionId);
  } catch {
    finalSession = {
      sessionId: config.sessionId,
      terminationReason: loopResult.terminationReason,
      prNumber: loopResult.prNumber,
    };
  }

  fs.writeFileSync(sessionRecordPath, JSON.stringify(finalSession, null, 2), "utf-8");
  console.log(`[main] Session record written to ${sessionRecordPath}`);

  // 7. Log results to stdout
  console.log(`[main] Results:`);
  console.log(`  Termination reason: ${loopResult.terminationReason}`);
  console.log(`  PR number: ${loopResult.prNumber ?? 0}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("[main] Fatal error:", err);
    process.exit(1);
  });
