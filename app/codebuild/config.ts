import * as path from "node:path";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { deriveSessionId } from "./session";

/**
 * Trigger payload passed via environment variable from the Webhook Lambda.
 */
export interface TriggerPayload {
  issue: {
    number: number;
    title: string;
  };
  module: {
    repository: string;
    path: string;
    ref: string;
    commitSha: string;
  };
  auth: {
    githubInstallationToken: string;
  };
  session?: {
    id?: string;
  };
}

/**
 * Resolved configuration for a CodeBuild orchestrator run.
 */
export interface CodeBuildConfig {
  /** From TRIGGER_PAYLOAD env var, or synthetic for local mode */
  triggerPayload: TriggerPayload;
  /** From SESSION_ID env var, or derived from CODEBUILD_BUILD_ID */
  sessionId: string;
  /** From LOCAL_MODE env var or absence of TRIGGER_PAYLOAD */
  localMode: boolean;
  /** From CODEBUILD_SRC_DIR or cwd */
  sourceDir: string;
  /** Resolved module root: sourceDir + triggerPayload.module.path */
  moduleRoot: string;
}

/**
 * Loop configuration loaded from agent-harness.config.json.
 */
export interface LoopConfig {
  limits: {
    iterationCap: number;
    wallClockCapMinutes: number;
    tokenSpendCapUSD: number;
  };
  oscillation: {
    sameDiffWindow: number;
    alternationWindow: number;
  };
  sensors: {
    cdkNagRulePack: string;
    reviewerSeverityThreshold: string;
    reviewerPillars: string[];
  };
  models: {
    editor: string;
    reviewer: string;
  };
}

/**
 * Creates a synthetic trigger payload for local mode, targeting modules/fanout.
 */
function createLocalModeTrigger(): TriggerPayload {
  return {
    issue: {
      number: 0,
      title: "Local mode run",
    },
    module: {
      repository: "local/agent-harness",
      path: "modules/fanout",
      ref: "main",
      commitSha: "HEAD",
    },
    auth: {
      githubInstallationToken: "",
    },
  };
}

/**
 * Loads CodeBuild orchestrator configuration from environment variables.
 *
 * - Defaults to local mode when TRIGGER_PAYLOAD is absent or LOCAL_MODE=true
 * - Uses CODEBUILD_BUILD_ID to derive session ID when SESSION_ID is not provided
 * - Falls back to random session ID in local mode without CODEBUILD_BUILD_ID
 */
export function loadConfig(): CodeBuildConfig {
  const triggerPayloadRaw = process.env.TRIGGER_PAYLOAD;
  const localModeEnv = process.env.LOCAL_MODE;
  const sessionIdEnv = process.env.SESSION_ID;
  const codeBuildBuildId = process.env.CODEBUILD_BUILD_ID;
  const codeBuildSrcDir = process.env.CODEBUILD_SRC_DIR;

  // Determine local mode: explicit env var OR absence of trigger payload
  const localMode =
    localModeEnv === "true" || !triggerPayloadRaw || triggerPayloadRaw.trim() === "";

  // Parse or synthesize trigger payload
  let triggerPayload: TriggerPayload;
  if (!localMode && triggerPayloadRaw) {
    triggerPayload = JSON.parse(triggerPayloadRaw) as TriggerPayload;
  } else {
    triggerPayload = createLocalModeTrigger();
  }

  // Resolve session ID: env var > derived from build ID > random for local
  let sessionId: string;
  if (sessionIdEnv) {
    sessionId = sessionIdEnv;
  } else if (codeBuildBuildId) {
    sessionId = deriveSessionId(codeBuildBuildId);
  } else {
    sessionId = randomBytes(20).toString("hex");
  }

  // Source directory
  const sourceDir = codeBuildSrcDir || process.cwd();

  // Module root
  const moduleRoot = path.join(sourceDir, triggerPayload.module.path);

  return {
    triggerPayload,
    sessionId,
    localMode,
    sourceDir,
    moduleRoot,
  };
}

/**
 * Loads loop configuration from agent-harness.config.json in the given source directory.
 */
export function loadLoopConfig(sourceDir: string): LoopConfig {
  const configPath = path.join(sourceDir, "agent-harness.config.json");
  const raw = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);

  return {
    limits: {
      iterationCap: config.limits.iterationCap,
      wallClockCapMinutes: config.limits.wallClockCapMinutes,
      tokenSpendCapUSD: config.limits.tokenSpendCapUSD,
    },
    oscillation: {
      sameDiffWindow: config.oscillation.sameDiffWindow,
      alternationWindow: config.oscillation.alternationWindow,
    },
    sensors: {
      cdkNagRulePack: config.sensors.cdkNagRulePack,
      reviewerSeverityThreshold: config.sensors.reviewerSeverityThreshold,
      reviewerPillars: config.sensors.reviewerPillars,
    },
    models: {
      editor: config.models.editor,
      reviewer: config.models.reviewer,
    },
  };
}
