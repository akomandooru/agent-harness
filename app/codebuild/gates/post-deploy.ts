/**
 * Post-deploy gate: runs HTTP assertions against the deployed endpoint
 * using stack outputs from a successful CDK deploy.
 *
 * If no endpoint URL is found in the stack outputs, the gate passes
 * (nothing to test). Network errors are captured as failures rather
 * than thrown so the loop can continue.
 *
 * If an API key ID is found in the stack outputs (key matching "ApiKeyId"),
 * the gate retrieves the key value via the API Gateway SDK and passes it
 * as the `x-api-key` header on all requests.
 */

import {
  APIGatewayClient,
  GetApiKeyCommand,
} from "@aws-sdk/client-api-gateway";

export interface PostDeployResult {
  passed: boolean;
  failures: string[];
}

const ENDPOINT_KEY_PATTERNS = [/endpoint/i, /url/i, /apiurl/i];
const API_KEY_ID_PATTERN = /apikey.*id/i;

/**
 * Looks for an endpoint URL in the stack outputs and performs a basic
 * HTTP smoke test (POST with a test message expecting a 2xx response).
 *
 * - If no endpoint key is found: returns passed (nothing to assert).
 * - If the request returns a non-2xx status: records a failure.
 * - If a network error occurs: records the error message as a failure.
 */
export async function runPostDeploy(options: {
  stackOutputs: Record<string, string>;
}): Promise<PostDeployResult> {
  const { stackOutputs } = options;

  const endpointUrl = findEndpointUrl(stackOutputs);

  if (!endpointUrl) {
    return { passed: true, failures: [] };
  }

  try {
    // Resolve API key if present in stack outputs
    const apiKey = await resolveApiKey(stackOutputs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    // POST a test message to the endpoint
    const testUrl = endpointUrl.endsWith("/")
      ? `${endpointUrl}messages`
      : `${endpointUrl}/messages`;

    const response = await fetch(testUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "post-deploy-smoke-test" }),
    });

    const failures: string[] = [];

    if (response.status < 200 || response.status >= 300) {
      const body = await response.text().catch(() => "");
      failures.push(
        `Expected 2xx from POST ${testUrl}, got ${response.status} ${response.statusText}. Body: ${body}`
      );
    }

    return { passed: failures.length === 0, failures };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      failures: [`Network error requesting ${endpointUrl}: ${message}`],
    };
  }
}

/**
 * Searches stack outputs for a key matching common endpoint patterns
 * (contains "Endpoint", "Url", or "ApiUrl" case-insensitively).
 * Returns the first matching value, or undefined if none found.
 */
function findEndpointUrl(
  stackOutputs: Record<string, string>
): string | undefined {
  for (const [key, value] of Object.entries(stackOutputs)) {
    for (const pattern of ENDPOINT_KEY_PATTERNS) {
      if (pattern.test(key)) {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * Looks for an API key ID in the stack outputs and retrieves the
 * actual key value from API Gateway. Returns undefined if no key ID found.
 */
async function resolveApiKey(
  stackOutputs: Record<string, string>
): Promise<string | undefined> {
  const apiKeyId = findApiKeyId(stackOutputs);
  if (!apiKeyId) return undefined;

  try {
    const client = new APIGatewayClient({});
    const response = await client.send(
      new GetApiKeyCommand({ apiKey: apiKeyId, includeValue: true })
    );
    return response.value;
  } catch {
    // If we can't retrieve the key, proceed without it.
    // The request will get a 403, which surfaces as a test failure.
    return undefined;
  }
}

/**
 * Searches stack outputs for a key matching the API key ID pattern.
 */
function findApiKeyId(
  stackOutputs: Record<string, string>
): string | undefined {
  for (const [key, value] of Object.entries(stackOutputs)) {
    if (API_KEY_ID_PATTERN.test(key)) {
      return value;
    }
  }
  return undefined;
}
