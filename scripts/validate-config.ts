/**
 * Validates `agent-harness.config.json` against `schemas/agent-harness-config.schema.json`.
 *
 * Exits 0 when the config is well-formed.
 * Exits 1 with a readable error report when fields are missing, malformed, or unknown.
 *
 * Run via `npm run validate-config`. Intended to gate CI before any other build step.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

const REPO_ROOT = resolve(__dirname, "..");
const CONFIG_PATH = resolve(REPO_ROOT, "agent-harness.config.json");
const SCHEMA_PATH = resolve(
  REPO_ROOT,
  "schemas",
  "agent-harness-config.schema.json"
);

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read ${path}: ${message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${path} is not valid JSON: ${message}`);
  }
}

function formatErrors(errors: ErrorObject[]): string {
  return errors
    .map((e) => {
      const path = e.instancePath === "" ? "(root)" : e.instancePath;
      const detail =
        e.params && Object.keys(e.params).length > 0
          ? ` [${JSON.stringify(e.params)}]`
          : "";
      return `  - ${path} ${e.message ?? ""}${detail}`;
    })
    .join("\n");
}

function main(): number {
  let schema: unknown;
  let config: unknown;
  try {
    schema = readJson(SCHEMA_PATH);
    config = readJson(CONFIG_PATH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`validate-config: ${message}`);
    return 1;
  }

  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);

  let validate;
  try {
    validate = ajv.compile(schema as object);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `validate-config: schema at ${SCHEMA_PATH} did not compile: ${message}`
    );
    return 1;
  }

  const ok = validate(config);
  if (!ok) {
    console.error(`validate-config: ${CONFIG_PATH} failed schema validation:`);
    console.error(formatErrors(validate.errors ?? []));
    return 1;
  }

  console.log(`validate-config: ${CONFIG_PATH} is valid.`);
  return 0;
}

process.exit(main());
