import { execWithTimeout } from "../exec";

export interface SensorResult {
  name: string;
  passed: boolean;
  exitCode: number;
  findings: string[];
  stdout: string;
  stderr: string;
}

export interface SensorsGateResult {
  passed: boolean;
  results: SensorResult[];
}

interface SensorDefinition {
  name: string;
  cmd: string;
  args: string[];
}

const SENSORS: SensorDefinition[] = [
  { name: "tsc", cmd: "npx", args: ["tsc", "--noEmit"] },
  { name: "eslint", cmd: "npx", args: ["eslint", "."] },
  { name: "jest", cmd: "npx", args: ["jest", "--ci"] },
  { name: "cdk-nag", cmd: "npx", args: ["cdk", "synth", "--quiet"] },
];

const DEFAULT_TIMEOUT = 120_000;

/**
 * Runs all sensors (tsc, eslint, jest, cdk-nag) sequentially in the given module root.
 * Each sensor runs as a subprocess with a configurable timeout (default 120s).
 * Returns structured results with findings parsed from non-zero exit outputs.
 */
export async function runSensors(options: {
  moduleRoot: string;
  timeout?: number;
}): Promise<SensorsGateResult> {
  const { moduleRoot, timeout = DEFAULT_TIMEOUT } = options;
  const results: SensorResult[] = [];

  for (const sensor of SENSORS) {
    const result = await runSingleSensor(sensor, moduleRoot, timeout);
    results.push(result);
  }

  const passed = results.every((r) => r.exitCode === 0);
  return { passed, results };
}

async function runSingleSensor(
  sensor: SensorDefinition,
  moduleRoot: string,
  timeout: number
): Promise<SensorResult> {
  const { name, cmd, args } = sensor;

  const execResult = await execWithTimeout(cmd, args, {
    cwd: moduleRoot,
    timeout,
  });

  const { stdout, stderr, exitCode } = execResult;

  if (exitCode === -1) {
    return {
      name,
      passed: false,
      exitCode,
      findings: [`Sensor timed out after ${timeout}ms`],
      stdout,
      stderr,
    };
  }

  if (exitCode !== 0) {
    const findings = parseFindings(stdout, stderr);
    return {
      name,
      passed: false,
      exitCode,
      findings,
      stdout,
      stderr,
    };
  }

  return {
    name,
    passed: true,
    exitCode: 0,
    findings: [],
    stdout,
    stderr,
  };
}

/**
 * Parses stdout and stderr into a structured findings array.
 * Splits combined output by newlines and filters empty lines.
 */
function parseFindings(stdout: string, stderr: string): string[] {
  const combined = `${stdout}\n${stderr}`;
  return combined
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
