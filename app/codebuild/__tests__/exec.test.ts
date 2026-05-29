import { execWithTimeout } from "../exec";
import * as path from "node:path";
import * as os from "node:os";

describe("execWithTimeout", () => {
  const cwd = os.tmpdir();

  it("returns stdout, stderr, and exitCode 0 on success", async () => {
    const result = await execWithTimeout("node", ["-e", "console.log('hello')"], {
      cwd,
      timeout: 5000,
    });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("returns non-zero exit code without throwing", async () => {
    const result = await execWithTimeout("node", ["-e", "process.exit(42)"], {
      cwd,
      timeout: 5000,
    });
    expect(result.exitCode).toBe(42);
  });

  it("captures stderr output", async () => {
    const result = await execWithTimeout(
      "node",
      ["-e", "console.error('oops'); process.exit(1)"],
      { cwd, timeout: 5000 }
    );
    expect(result.stderr.trim()).toBe("oops");
    expect(result.exitCode).toBe(1);
  });

  it("throws on spawn failure (ENOENT)", async () => {
    await expect(
      execWithTimeout("nonexistent-binary-xyz", [], { cwd, timeout: 5000 })
    ).rejects.toThrow();
  });

  it("returns exitCode -1 and timeout message on timeout", async () => {
    const result = await execWithTimeout(
      "node",
      ["-e", "setTimeout(() => {}, 30000)"],
      { cwd, timeout: 200 }
    );
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("[Process timed out]");
  }, 15000);
});
