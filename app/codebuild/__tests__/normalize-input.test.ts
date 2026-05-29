import { normalizeInput } from "../normalize-input";

describe("normalizeInput", () => {
  it("returns {} for null", () => {
    expect(normalizeInput(null)).toEqual({});
  });

  it("returns {} for undefined", () => {
    expect(normalizeInput(undefined)).toEqual({});
  });

  it("wraps string in { value }", () => {
    expect(normalizeInput("hello")).toEqual({ value: "hello" });
  });

  it("wraps number in { value }", () => {
    expect(normalizeInput(42)).toEqual({ value: 42 });
  });

  it("wraps boolean in { value }", () => {
    expect(normalizeInput(true)).toEqual({ value: true });
  });

  it("wraps array in { items }", () => {
    expect(normalizeInput([1, 2, 3])).toEqual({ items: [1, 2, 3] });
  });

  it("wraps empty array in { items }", () => {
    expect(normalizeInput([])).toEqual({ items: [] });
  });

  it("passes through a plain object", () => {
    expect(normalizeInput({ path: "/foo", content: "bar" })).toEqual({
      path: "/foo",
      content: "bar",
    });
  });

  it("removes the `type` key from objects", () => {
    expect(normalizeInput({ type: "object", path: "/foo" })).toEqual({
      path: "/foo",
    });
  });

  it("handles object with only `type` key", () => {
    expect(normalizeInput({ type: "string" })).toEqual({});
  });

  it("does not mutate the original object", () => {
    const original = { type: "object", path: "/foo" };
    normalizeInput(original);
    expect(original.type).toBe("object");
  });

  it("never throws for any input", () => {
    const inputs = [null, undefined, 0, "", false, [], {}, Symbol("x"), BigInt(1), () => {}];
    for (const input of inputs) {
      expect(() => normalizeInput(input)).not.toThrow();
    }
  });
});
