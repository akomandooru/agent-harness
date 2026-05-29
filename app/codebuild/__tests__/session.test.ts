import { deriveSessionId } from "../session";

describe("deriveSessionId", () => {
  it("returns a 40-character hex string", () => {
    const result = deriveSessionId("my-project:abc-123-uuid");
    expect(result).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is deterministic (same input produces same output)", () => {
    const buildId = "project:build-uuid-456";
    expect(deriveSessionId(buildId)).toBe(deriveSessionId(buildId));
  });

  it("produces different outputs for different inputs", () => {
    const id1 = deriveSessionId("project:build-1");
    const id2 = deriveSessionId("project:build-2");
    expect(id1).not.toBe(id2);
  });

  it("handles empty string input", () => {
    const result = deriveSessionId("");
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });
});
