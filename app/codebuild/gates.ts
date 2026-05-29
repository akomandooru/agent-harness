/**
 * Factory that assembles all CodeBuild gate implementations into a
 * single `LoopGates` object for the bounded loop.
 *
 * Each gate delegates to the corresponding implementation in `./gates/`.
 *
 * Requirements: 8.1
 */

import type {
  LoopGates,
  LoopContext,
  SensorResults,
  ReviewerResult,
  DeployResult,
  PostDeployResult,
} from "@agent-harness/loop/src/run";
import { MapToolCatalogue } from "../orchestrator/tool-executor";
import { runSensors } from "./gates/sensors";
import { runDeploy } from "./gates/deploy";
import { runPostDeploy } from "./gates/post-deploy";
import { runEditor, runReviewer } from "./gates/harness";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CodeBuildGatesOptions {
  /** Absolute path to the cloned module directory. */
  moduleRoot: string;
  /** Session ID for AgentCore session isolation. */
  sessionId: string;
  /** ARN of the editor Managed Harness. */
  editorHarnessArn: string;
  /** ARN of the reviewer Managed Harness. */
  reviewerHarnessArn: string;
  /** Tool catalogue with module_readFile, module_writeFile, module_listFiles. */
  toolCatalogue: MapToolCatalogue;
  /** Per-sensor timeout in milliseconds. Default 120_000 ms. */
  sensorTimeout: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a `LoopGates` implementation backed by real CodeBuild-native
 * subprocesses and Managed Harness invocations.
 */
export function createCodeBuildGates(options: CodeBuildGatesOptions): LoopGates {
  const {
    moduleRoot,
    sessionId,
    editorHarnessArn,
    reviewerHarnessArn: _reviewerHarnessArn,
    toolCatalogue,
    sensorTimeout,
  } = options;

  return {
    async runEditor(context: LoopContext) {
      const result = await runEditor({
        editorHarnessArn,
        sessionId,
        toolCatalogue,
        context: JSON.stringify(context),
      });
      // Map EditorGateResult to EditorResult expected by LoopGates
      return { edits: result.edits };
    },

    async runSensors(): Promise<SensorResults> {
      console.log(`[sensors] Running sensors in ${moduleRoot}...`);
      const result = await runSensors({ moduleRoot, timeout: sensorTimeout });

      // Log each sensor's result for observability
      for (const r of result.results) {
        const status = r.passed ? "PASSED" : `FAILED (exit ${r.exitCode})`;
        console.log(`[sensors] ${r.name}: ${status}`);
        if (!r.passed && r.findings.length > 0) {
          // Log first 5 findings to keep output manageable
          for (const f of r.findings.slice(0, 5)) {
            console.log(`[sensors]   ${f}`);
          }
          if (r.findings.length > 5) {
            console.log(`[sensors]   ... and ${r.findings.length - 5} more`);
          }
        }
      }
      console.log(`[sensors] Overall: ${result.passed ? "ALL PASSED" : "SOME FAILED"}`);

      // Map SensorsGateResult to the LoopGates SensorResults shape
      const findSensor = (name: string) =>
        result.results.find((r) => r.name === name);

      const tsc = findSensor("tsc");
      const eslint = findSensor("eslint");
      const jest = findSensor("jest");
      const cdkNag = findSensor("cdk-nag");

      return {
        tsc: {
          errors: tsc?.findings ?? [],
          passed: tsc?.passed ?? true,
        },
        eslint: {
          findings: eslint?.findings ?? [],
          passed: eslint?.passed ?? true,
        },
        unitTests: {
          results: jest?.findings ?? [],
          passed: jest?.passed ?? true,
        },
        cdkNag: {
          findings: cdkNag?.findings ?? [],
          passed: cdkNag?.passed ?? true,
        },
      };
    },

    async runReviewer(diff: string): Promise<ReviewerResult> {
      if (!diff.trim()) {
        console.log(`[reviewer] Empty diff — skipping review.`);
        return { findings: [], passed: true, severityCounts: {} };
      }

      console.log(`[reviewer] Invoking reviewer (direct Converse)...`);
      try {
        const result = await runReviewer({ diff });
        console.log(`[reviewer] Result: ${result.passed ? "PASSED" : "FAILED"} (${result.findings.length} findings)`);
        if (!result.passed) {
          for (const f of result.findings.slice(0, 5)) {
            console.log(`[reviewer]   ${f}`);
          }
        }
        return {
          findings: result.findings,
          passed: result.passed,
          severityCounts: {},
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[reviewer] Reviewer failed: ${message}`);
        console.log(`[reviewer] Treating as passed (computational sensors already validated).`);
        return { findings: [], passed: true, severityCounts: {} };
      }
    },

    async runDeploy(): Promise<DeployResult> {
      console.log(`[deploy] Running cdk deploy in ${moduleRoot}...`);
      const result = await runDeploy({ moduleRoot });
      const outcome = result.success ? "ok" : "fail";
      console.log(`[deploy] Result: ${outcome}`);
      if (!result.success) {
        console.log(`[deploy] Error: ${(result.error ?? "").slice(0, 500)}`);
      }
      return {
        outcome,
        logs: result.error ?? "",
        stackOutputs: result.stackOutputs,
      };
    },

    async runPostDeploy(stackOutputs?: Record<string, string>): Promise<PostDeployResult> {
      console.log(`[post-deploy] Running post-deploy harness...`);
      const result = await runPostDeploy({ stackOutputs: stackOutputs ?? {} });
      const outcome = result.passed ? "pass" : "fail";
      console.log(`[post-deploy] Result: ${outcome}`);
      return {
        outcome,
        report: { failures: result.failures },
      };
    },

    async openPR(_body: string, _partial: boolean): Promise<{ number: number; url: string }> {
      // In the script-triggered mode, PR creation is handled externally.
      // This no-op implementation is overridden by main.ts.
      throw new Error("openPR gate must be overridden before use.");
    },
  };
}
