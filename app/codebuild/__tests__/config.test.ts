import * as path from "node:path";
import * as fs from "node:fs";
import { loadConfig, loadLoopConfig } from "../config";

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear relevant env vars
    delete process.env.TRIGGER_PAYLOAD;
    delete process.env.SESSION_ID;
    delete process.env.LOCAL_MODE;
    delete process.env.CODEBUILD_BUILD_ID;
    delete process.env.CODEBUILD_SRC_DIR;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults to local mode when TRIGGER_PAYLOAD is absent", () => {
    const config = loadConfig();
    expect(config.localMode).toBe(true);
    expect(config.triggerPayload.module.path).toBe("modules/fanout");
    expect(config.triggerPayload.issue.number).toBe(0);
  });

  it("defaults to local mode when TRIGGER_PAYLOAD is empty string", () => {
    process.env.TRIGGER_PAYLOAD = "";
    const config = loadConfig();
    expect(config.localMode).toBe(true);
  });

  it("defaults to local mode when LOCAL_MODE is true regardless of payload", () => {
    process.env.LOCAL_MODE = "true";
    process.env.TRIGGER_PAYLOAD = JSON.stringify({
      issue: { number: 1, title: "Test" },
      module: { repository: "org/repo", path: "modules/test", ref: "main", commitSha: "abc123" },
      auth: { githubInstallationToken: "tok" },
    });
    const config = loadConfig();
    expect(config.localMode).toBe(true);
    // Uses synthetic trigger in local mode
    expect(config.triggerPayload.module.path).toBe("modules/fanout");
  });

  it("parses TRIGGER_PAYLOAD when present and not in local mode", () => {
    const payload = {
      issue: { number: 42, title: "Fix bug" },
      module: { repository: "org/repo", path: "modules/networking", ref: "main", commitSha: "deadbeef" },
      auth: { githubInstallationToken: "ghs_token123" },
    };
    process.env.TRIGGER_PAYLOAD = JSON.stringify(payload);
    process.env.LOCAL_MODE = "false";

    const config = loadConfig();
    expect(config.localMode).toBe(false);
    expect(config.triggerPayload).toEqual(payload);
  });

  it("uses SESSION_ID env var when present", () => {
    process.env.SESSION_ID = "my-session-123";
    const config = loadConfig();
    expect(config.sessionId).toBe("my-session-123");
  });

  it("derives session ID from CODEBUILD_BUILD_ID when SESSION_ID is absent", () => {
    process.env.CODEBUILD_BUILD_ID = "project:build-uuid-123";
    const config = loadConfig();
    // Should be a 40-char hex string (from deriveSessionId)
    expect(config.sessionId).toMatch(/^[0-9a-f]{40}$/);
  });

  it("generates random session ID in local mode without CODEBUILD_BUILD_ID", () => {
    const config = loadConfig();
    // Should be a 40-char hex string (from randomBytes(20))
    expect(config.sessionId).toMatch(/^[0-9a-f]{40}$/);
  });

  it("uses CODEBUILD_SRC_DIR as sourceDir when present", () => {
    process.env.CODEBUILD_SRC_DIR = "/codebuild/output/src";
    const config = loadConfig();
    expect(config.sourceDir).toBe("/codebuild/output/src");
  });

  it("falls back to cwd when CODEBUILD_SRC_DIR is absent", () => {
    const config = loadConfig();
    expect(config.sourceDir).toBe(process.cwd());
  });

  it("resolves moduleRoot from sourceDir and trigger module path", () => {
    process.env.CODEBUILD_SRC_DIR = "/project";
    const config = loadConfig();
    expect(config.moduleRoot).toBe(path.join("/project", "modules/fanout"));
  });
});

describe("loadLoopConfig", () => {
  const tmpDir = path.join(__dirname, "__tmp_config_test__");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads and parses agent-harness.config.json from sourceDir", () => {
    const configContent = {
      limits: { iterationCap: 5, wallClockCapMinutes: 12, tokenSpendCapUSD: 10.0 },
      oscillation: { sameDiffWindow: 3, alternationWindow: 4 },
      sensors: {
        cdkNagRulePack: "AwsSolutions",
        reviewerSeverityThreshold: "MEDIUM",
        reviewerPillars: ["Security", "Reliability"],
      },
      models: { editor: "claude-sonnet", reviewer: "claude-sonnet" },
    };
    fs.writeFileSync(path.join(tmpDir, "agent-harness.config.json"), JSON.stringify(configContent));

    const loopConfig = loadLoopConfig(tmpDir);
    expect(loopConfig.limits.iterationCap).toBe(5);
    expect(loopConfig.limits.wallClockCapMinutes).toBe(12);
    expect(loopConfig.limits.tokenSpendCapUSD).toBe(10.0);
    expect(loopConfig.oscillation.sameDiffWindow).toBe(3);
    expect(loopConfig.oscillation.alternationWindow).toBe(4);
    expect(loopConfig.sensors.cdkNagRulePack).toBe("AwsSolutions");
    expect(loopConfig.sensors.reviewerPillars).toEqual(["Security", "Reliability"]);
    expect(loopConfig.models.editor).toBe("claude-sonnet");
  });

  it("throws when config file does not exist", () => {
    expect(() => loadLoopConfig("/nonexistent/path")).toThrow();
  });
});
