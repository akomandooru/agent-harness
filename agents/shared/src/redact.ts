/**
 * Secret redaction for tool inputs and outputs.
 *
 * The session record is durable and may be exported, copied, or surfaced in
 * UIs. Anything the trigger payload classified as a secret (`auth.*`, the
 * GitHub installation token, the like) MUST NOT survive into a session
 * record.
 *
 * The wrapper invokes `redact` on a deep clone of inputs and outputs before
 * handing them to the `SessionSink`. The original objects the handler sees
 * are unchanged.
 *
 * Redaction strategy: replace the value with the literal string
 * `"[REDACTED]"`. This is preferable to deletion because the *shape* of the
 * record stays consistent; auditors can see that a secret was present
 * without ever seeing its value.
 */

/**
 * Field names that always get redacted regardless of nesting depth.
 *
 * Add to this list (rather than relying on regex patterns alone) when a new
 * secret-bearing field is introduced. The list-based check is the primary
 * defence; the pattern check below is the safety net.
 */
const REDACT_KEYS = new Set<string>([
  "githubInstallationToken",
  "installationToken",
  "githubToken",
  "token",
  "secret",
  "password",
  "apiKey",
  "accessKey",
  "secretAccessKey",
  "privateKey",
  "sessionToken",
]);

/**
 * Patterns matched against keys to catch variants the explicit list misses.
 * Case-insensitive. Designed to err on the side of over-redaction rather
 * than leaking; cost of a false positive is a less informative log line,
 * cost of a false negative is a leaked secret.
 */
const REDACT_PATTERNS: readonly RegExp[] = [
  /token$/i,
  /secret$/i,
  /password$/i,
  /credential/i,
  /apikey$/i,
  /^authorization$/i,
];

const REDACTED = "[REDACTED]" as const;

/** Tells whether a value should recurse (objects/arrays) or be returned as-is. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function shouldRedactKey(key: string): boolean {
  if (REDACT_KEYS.has(key)) return true;
  for (const pattern of REDACT_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

/**
 * Returns a deep clone of `value` with secret fields replaced by the
 * sentinel string. Cycles are not expected in tool inputs/outputs (they are
 * JSON-shaped per their schemas) but are guarded against to avoid infinite
 * recursion if a handler breaks the contract.
 */
export function redact(value: unknown): unknown {
  return redactInternal(value, new WeakSet<object>());
}

function redactInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
    return value;
  }
  if (t === "function" || t === "symbol") {
    // Functions and symbols don't belong in JSON-shaped tool I/O; surface
    // them as a typed sentinel so the contract violation is visible in logs
    // without leaking whatever the function closed over.
    return `[UNSERIALIZABLE:${t}]`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CYCLE]";
    seen.add(value);
    return value.map((item) => redactInternal(item, seen));
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return "[CYCLE]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (shouldRedactKey(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactInternal(child, seen);
      }
    }
    return out;
  }
  // Fallback: classes, Maps, Sets, Dates etc. Tool I/O contracts disallow
  // these by virtue of being JSON-schema-typed; return a sentinel so the
  // log shows the contract was broken.
  return `[UNSERIALIZABLE:${t}]`;
}
