import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd: string;
  timeout: number;
}

/**
 * Executes a command with signal-based timeout.
 *
 * On timeout: sends SIGTERM, waits 5 seconds, then sends SIGKILL.
 * Returns a structured result regardless of exit code.
 * Throws only on spawn failure (ENOENT, EACCES).
 */
export async function execWithTimeout(
  cmd: string,
  args: string[],
  options: ExecOptions
): Promise<ExecResult> {
  const { cwd, timeout } = options;

  return new Promise<ExecResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const child = execFile(
      cmd,
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdoutBuf, stderrBuf) => {
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);

        stdout = stdoutBuf ?? "";
        stderr = stderrBuf ?? "";

        if (error && isSpawnError(error)) {
          reject(error);
          return;
        }

        if (timedOut) {
          resolve({
            stdout,
            stderr: stderr + "\n[Process timed out]",
            exitCode: -1,
          });
          return;
        }

        const exitCode = error ? (error.code as unknown as number ?? 1) : 0;
        resolve({ stdout, stderr, exitCode });
      }
    );

    // Set up signal-based timeout: SIGTERM → 5s → SIGKILL
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");

      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
    }, timeout);
  });
}

/**
 * Determines if an error is a spawn failure (ENOENT, EACCES)
 * rather than a non-zero exit code.
 */
function isSpawnError(error: Error & { code?: string | number | null }): boolean {
  return error.code === "ENOENT" || error.code === "EACCES";
}
