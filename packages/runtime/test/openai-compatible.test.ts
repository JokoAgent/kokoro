import { describe, expect, it, vi } from "vitest";
import { type ModelCallContext, type ModelRequest, OpenAiCompatibleProvider } from "../src/index.js";

const CREDENTIAL = "opaque-credential-2ee6046f-8caf-4937-8b27-790967bad728";

describe("OpenAiCompatibleProvider credential boundary", () => {
  it("does not send its configured credential when Context contains the exact opaque value", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = fixtureProvider(fetch);

    await expect(
      provider.complete(request(`Owner text accidentally contained ${CREDENTIAL}.`), context()),
    ).rejects.toMatchObject({
      code: "provider_credential_in_request_body",
      status: 400,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a Provider response that echoes the exact credential before it becomes a Runtime fact", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "response-1",
          choices: [
            {
              message: { role: "assistant", content: `echo:${CREDENTIAL}` },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = fixtureProvider(fetch);

    await expect(provider.complete(request("ordinary Context"), context())).rejects.toMatchObject({
      code: "provider_credential_in_response",
      status: 502,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
    expect(String(init?.body)).not.toContain(CREDENTIAL);
  });

  it("rejects capabilities that contain the exact configured credential", async () => {
    const provider = new OpenAiCompatibleProvider({
      id: "fixture",
      baseUrl: "https://provider.invalid/v1",
      apiKey: async () => CREDENTIAL,
      models: [
        {
          id: "model",
          displayName: CREDENTIAL,
          contextWindow: 16_384,
          maxOutputTokens: 1_024,
        },
      ],
    });

    await expect(provider.listModels()).rejects.toMatchObject({
      code: "provider_credential_in_capabilities",
      status: 500,
    });
  });
});

function fixtureProvider(fetch: typeof globalThis.fetch): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id: "fixture",
    baseUrl: "https://provider.invalid/v1",
    apiKey: CREDENTIAL,
    models: [{ id: "model", contextWindow: 16_384, maxOutputTokens: 1_024 }],
    fetch,
  });
}

function request(content: string): ModelRequest {
  return {
    id: "request-1",
    role: "persona",
    model: { provider: "fixture", model: "model" },
    promptLocale: "en",
    system: "Fixture system prompt.",
    messages: [{ role: "user", content }],
    tools: [],
    maxOutputTokens: 1_024,
    continuation: false,
  };
}

function context(): ModelCallContext {
  return {
    signal: new AbortController().signal,
    emit: async () => undefined,
  };
}
