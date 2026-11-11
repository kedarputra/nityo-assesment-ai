import { describe, expect, it } from "vitest";
import { GEMINI_BASE_URL } from "./configured-model";
import { DEFAULT_GEMINI_EMBEDDING_MODEL, EmbeddingFailed, GeminiEmbedder, configuredEmbedder } from "./embedder";

// A stand-in for the endpoint: records each call and answers one vector per input, out of order,
// so the embedder has to put them back by index.
function fakeEndpoint(answer?: (input: string[]) => Response) {
  const calls: { url: string; init: RequestInit; body: { model: string; input: string[] } }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
    calls.push({ url: String(url), init: init ?? {}, body });
    if (answer) return answer(body.input);
    const data = body.input.map((text, index) => ({ index, embedding: [text.length, index + 1] })).reverse();
    return Response.json({ data });
  };
  return { calls, fetch };
}

describe("GeminiEmbedder", () => {
  it("posts the texts to the OpenAI-compatible embeddings endpoint, with the key, and keeps their order", async () => {
    const endpoint = fakeEndpoint();
    const embedder = new GeminiEmbedder({ baseUrl: "https://example.test/openai", apiKey: "key-1", model: "m", fetch: endpoint.fetch });

    expect(await embedder.embed(["a", "bbb"])).toEqual([
      [1, 1],
      [3, 2],
    ]);
    expect(endpoint.calls).toHaveLength(1);
    expect(endpoint.calls[0]?.url).toBe("https://example.test/openai/embeddings");
    expect(endpoint.calls[0]?.body).toEqual({ model: "m", input: ["a", "bbb"] });
    expect(new Headers(endpoint.calls[0]?.init.headers).get("authorization")).toBe("Bearer key-1");
  });

  it("sends at most 100 texts per call", async () => {
    const endpoint = fakeEndpoint();
    const embedder = new GeminiEmbedder({ baseUrl: GEMINI_BASE_URL, apiKey: "k", model: "m", fetch: endpoint.fetch });

    const vectors = await embedder.embed(Array.from({ length: 250 }, (_, index) => `text ${index}`));

    expect(vectors).toHaveLength(250);
    expect(endpoint.calls.map((call) => call.body.input.length)).toEqual([100, 100, 50]);
  });

  it("fails clearly on an error answer, or an answer without one vector per text", async () => {
    const refused = new GeminiEmbedder({
      baseUrl: GEMINI_BASE_URL,
      apiKey: "k",
      model: "m",
      fetch: fakeEndpoint(() => new Response("quota", { status: 429 })).fetch,
    });
    const short = new GeminiEmbedder({
      baseUrl: GEMINI_BASE_URL,
      apiKey: "k",
      model: "m",
      fetch: fakeEndpoint(() => Response.json({ data: [{ index: 0, embedding: [1] }] })).fetch,
    });

    await expect(refused.embed(["a"])).rejects.toBeInstanceOf(EmbeddingFailed);
    await expect(short.embed(["a", "b"])).rejects.toBeInstanceOf(EmbeddingFailed);
  });

  it("fails clearly when the endpoint does not answer in time", async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const embedder = new GeminiEmbedder({ baseUrl: GEMINI_BASE_URL, apiKey: "k", model: "m", fetch: hanging, timeoutMs: 10 });

    await expect(embedder.embed(["a"])).rejects.toThrow(EmbeddingFailed);
  });
});

describe("configuredEmbedder", () => {
  it("is off without a Gemini key, even with Anthropic's", () => {
    expect(configuredEmbedder({})).toBeNull();
    expect(configuredEmbedder({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "  " })).toBeNull();
  });

  it("uses Gemini's embedding model by default, and the env's model and base URL when set", () => {
    expect(configuredEmbedder({ GEMINI_API_KEY: "k" })?.model).toBe(DEFAULT_GEMINI_EMBEDDING_MODEL);
    expect(configuredEmbedder({ GEMINI_API_KEY: "k", GEMINI_EMBEDDING_MODEL: "text-embedding-x" })?.model).toBe("text-embedding-x");
  });

  it("calls the overridden base URL", async () => {
    const endpoint = fakeEndpoint();
    const original = globalThis.fetch;
    globalThis.fetch = endpoint.fetch;
    try {
      await configuredEmbedder({ GEMINI_API_KEY: "k", GEMINI_BASE_URL: "http://localhost:9999/v1/" })?.embed(["a"]);
    } finally {
      globalThis.fetch = original;
    }
    expect(endpoint.calls[0]?.url).toBe("http://localhost:9999/v1/embeddings");
  });
});
