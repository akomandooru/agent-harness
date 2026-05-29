#!/usr/bin/env node
/**
 * discover-gaps.js — Runs the reviewer against the current module state
 * and outputs the highest-severity finding as a JSON trigger payload.
 *
 * Usage:
 *   node scripts/discover-gaps.js --module-root modules/fanout
 *
 * Outputs JSON to stdout: { title, body, severity }
 * Exits 0 if a finding was discovered, 1 if no findings.
 */

const { readFileSync, readdirSync, statSync } = require("fs");
const { resolve, join, relative } = require("path");

async function main() {
  const args = process.argv.slice(2);
  const moduleRootIdx = args.indexOf("--module-root");
  const moduleRoot = moduleRootIdx >= 0 ? args[moduleRootIdx + 1] : "modules/fanout";
  const absoluteRoot = resolve(process.cwd(), moduleRoot);

  // Load reviewer system prompt
  const systemPromptRaw = readFileSync(
    resolve(__dirname, "../agents/reviewer/system.md"),
    "utf8",
  );
  const systemPrompt = systemPromptRaw.replace(/^---[\s\S]*?---\n/, "");

  // Load checklists
  const securityItems = JSON.parse(
    readFileSync(resolve(__dirname, "../agents/reviewer/checklists/security.json"), "utf8"),
  );
  const reliabilityItems = JSON.parse(
    readFileSync(resolve(__dirname, "../agents/reviewer/checklists/reliability.json"), "utf8"),
  );

  // Read key module files to give the reviewer context
  const moduleFiles = collectFiles(absoluteRoot, absoluteRoot);
  const fileContents = moduleFiles
    .filter((f) => f.endsWith(".ts") && !f.includes("node_modules") && !f.includes("cdk.out"))
    .slice(0, 10)
    .map((f) => {
      const content = readFileSync(join(absoluteRoot, f), "utf8");
      return `--- ${f} ---\n${content}`;
    })
    .join("\n\n");

  // Build the user message — asking for a full module review (no diff)
  const userMessage = [
    "## Task: Full module architecture review",
    "",
    "Review the following module source files against the Security and Reliability checklists.",
    "Identify architecture fitness gaps that should be remediated.",
    "",
    "## Module files",
    "",
    fileContents,
    "",
    "## Security checklist",
    "",
    JSON.stringify(securityItems, null, 2),
    "",
    "## Reliability checklist",
    "",
    JSON.stringify(reliabilityItems, null, 2),
    "",
    "Produce your ReviewerOutput JSON now. No prose before or after the JSON.",
  ].join("\n");

  // Call Bedrock Converse
  const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });

  console.error("[discover] Invoking reviewer model for module scan...");

  const command = new ConverseCommand({
    modelId: "us.anthropic.claude-sonnet-4-6",
    system: [{ text: systemPrompt }],
    messages: [{ role: "user", content: [{ text: userMessage }] }],
    inferenceConfig: { maxTokens: 4096, temperature: 0 },
  });

  const response = await client.send(command);

  const outputContent = response.output?.message?.content ?? [];
  const textBlock = outputContent.find((b) => typeof b.text === "string");
  const assistantText = textBlock?.text ?? "";

  if (!assistantText.trim()) {
    console.error("[discover] Reviewer returned no output.");
    process.exit(1);
  }

  // Parse JSON
  const jsonMatch = assistantText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error("[discover] Could not parse reviewer output.");
    console.error(assistantText.slice(0, 500));
    process.exit(1);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const findings = parsed.findings || [];

  if (findings.length === 0) {
    console.error("[discover] No findings — module passes review.");
    process.exit(1);
  }

  // Pick highest severity finding
  const severityOrder = ["critical", "high", "medium", "low", "info"];
  findings.sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity));
  const top = findings[0];

  console.error(`[discover] Found ${findings.length} finding(s). Top: [${top.severity}] ${top.description}`);

  // Output as JSON for the caller
  const result = {
    title: `[Fitness gap] ${top.description}`,
    body: [
      "## Finding",
      "",
      `${top.id}: ${top.description}`,
      top.file ? `\nFile: ${top.file}${top.line ? `:${top.line}` : ""}` : "",
      "",
      "## Source",
      "",
      "Automated architecture review (scheduled reviewer scan).",
      "",
      "## Suggested remediation",
      "",
      top.suggestedFix,
    ].join("\n"),
    severity: top.severity,
    findingCount: findings.length,
  };

  // Output to stdout (caller reads this)
  console.log(JSON.stringify(result));
}

function collectFiles(dir, root) {
  const results = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "cdk.out" || entry === ".git") continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...collectFiles(full, root));
      } else {
        results.push(relative(root, full));
      }
    }
  } catch { /* ignore permission errors */ }
  return results;
}

main().catch((err) => {
  console.error("[discover] Fatal:", err.message || err);
  process.exit(1);
});
