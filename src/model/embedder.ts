import { GEMINI_BASE_URL } from "./configured-model";

// Turns text into vectors for search by meaning (ADR 0005). Gemini's embedding model, through the
// same OpenAI-compatible endpoint and key as the agent's Gemini model. Plain fetch, no SDK. Tests
// hand search a fake; nothing in a check calls the real endpoint.

export interface Embedder {
  // Stored beside each vector, so a change of model recomputes them.
  model: string;
  // One vector per text, in the same order.
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
// The endpoint takes at most 100 inputs per call.
export const EMBEDDING_BATCH = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

export class EmbeddingFailed extends Error {
  override name = "EmbeddingFailed";
}

export interface GeminiEmbedderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface ApiEmbeddings {
  data?: { embedding?: unknown; index?: number }[];
}

export class GeminiEmbedder implements Embedder {
  readonly model: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: GeminiEmbedderOptions) {
    this.model = options.model;
    // Called through a wrapper, so the platform's fetch never runs with this object as its `this`.
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH) {
      vectors.push(...(await this.embedBatch(texts.slice(start, start + EMBEDDING_BATCH))));
    }
    return vectors;
  }

  private async embedBatch(input: string[]): Promise<number[][]> {
    const base = this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let response: Response;
    try {
      response = await this.fetch(new URL("embeddings", base), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ model: this.model, input }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new EmbeddingFailed(`The embedding service didn’t answer within ${Math.round(timeoutMs / 1000)} s.`);
      }
      throw new EmbeddingFailed("The embedding service couldn’t be reached.", { cause: error });
    }
    if (!response.ok) {
      // The body is the provider's error, never the key; cut short so a log line stays a line.
      throw new EmbeddingFailed(`The embedding service answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    const reply = (await response.json()) as ApiEmbeddings;
    const data = [...(reply.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = data.map((item) => item.embedding);
    if (vectors.length !== input.length || !vectors.every(isVector)) {
      throw new EmbeddingFailed("The embedding service answered with something other than one vector per text.");
    }
    return vectors;
  }
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

// Search by meaning needs Gemini's key, whichever model runs the agent; without it, null.
export function configuredEmbedder(env: Record<string, string | undefined> = process.env): Embedder | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  return new GeminiEmbedder({
    // Overridable for a local stand-in of the endpoint; production leaves it unset.
    baseUrl: env.GEMINI_BASE_URL?.trim() || GEMINI_BASE_URL,
    apiKey,
    model: env.GEMINI_EMBEDDING_MODEL?.trim() || DEFAULT_GEMINI_EMBEDDING_MODEL,
  });
}
