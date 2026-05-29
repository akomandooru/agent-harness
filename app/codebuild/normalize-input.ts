/**
 * Coerces tool-use block inputs to valid JSON objects.
 *
 * Bedrock tool-use blocks can contain malformed or unexpected input shapes
 * (primitives, arrays, null, objects with a `type` field). This function
 * normalizes any input into a plain object suitable for tool handlers.
 *
 * Guarantees:
 * - Output is always a non-null, non-array object
 * - Output never contains a `type` key
 * - Never throws
 */
export function normalizeInput(input: unknown): Record<string, unknown> {
  try {
    // null or undefined → empty object
    if (input == null) {
      return {};
    }

    // Primitives (string, number, boolean) → wrap in { value }
    const type = typeof input;
    if (type === "string" || type === "number" || type === "boolean") {
      return { value: input };
    }

    // Arrays → wrap in { items }
    if (Array.isArray(input)) {
      return { items: input };
    }

    // Objects → clone and remove `type` key
    if (type === "object") {
      const result = { ...(input as Record<string, unknown>) };
      delete result.type;
      return result;
    }

    // Fallback for any other type (symbol, bigint, function)
    return {};
  } catch {
    return {};
  }
}
