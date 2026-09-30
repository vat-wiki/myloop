import { describe, expect, it, vi } from "vitest";
import { postJson, type HttpTransport, type HttpTransportResponse } from "../../src/clients/http.js";

function response(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): HttpTransportResponse {
  const status = init.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(init.headers),
    text: JSON.stringify(body),
  };
}

describe("postJson retry transport", () => {
  it("retries transient HTTP errors with slower defaults", async () => {
    vi.useFakeTimers();
    const transport = vi.fn().mockResolvedValue(
      response({ error: "upstream unavailable" }, { status: 502 }),
    );

    try {
      const result = expect(postJson({
        transport,
        url: "https://example.test/model",
        headers: {},
        body: { prompt: "hello" },
        errorName: "AnthropicHttpError",
      })).rejects.toThrow("AnthropicHttpError failed with status 502");

      await vi.advanceTimersByTimeAsync(200_000);
      await result;
      expect(transport).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-retryable HTTP errors", async () => {
    const transport = vi.fn().mockResolvedValue(response({ message: "bad request" }, { status: 400 }));

    await expect(postJson({
      transport,
      url: "https://example.test/model",
      headers: {},
      body: { prompt: "hello" },
      retry: { attempts: 3, initialDelayMs: 0 },
      errorName: "TestHttpError",
    })).rejects.toThrow("TestHttpError failed with status 400");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("retries retryable HTTP errors and returns the successful response", async () => {
    const transport = vi.fn<Parameters<HttpTransport>, ReturnType<HttpTransport>>()
      .mockResolvedValueOnce(response({ error: "temporarily unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(response({ answer: "ok" }));

    await expect(postJson({
      transport,
      url: "https://example.test/model",
      headers: {},
      body: { prompt: "hello" },
      retry: { attempts: 2, initialDelayMs: 0 },
      errorName: "TestHttpError",
    })).resolves.toEqual({ answer: "ok" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("retries transient network errors", async () => {
    const transport = vi.fn<Parameters<HttpTransport>, ReturnType<HttpTransport>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(response({ answer: "ok" }));

    await expect(postJson({
      transport,
      url: "https://example.test/model",
      headers: {},
      body: { prompt: "hello" },
      retry: { attempts: 2, initialDelayMs: 0 },
      errorName: "TestHttpError",
    })).resolves.toEqual({ answer: "ok" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("stops when the request signal is aborted", async () => {
    const controller = new AbortController();
    const transport = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error("connection reset");
    });

    await expect(postJson({
      transport,
      url: "https://example.test/model",
      headers: {},
      body: { prompt: "hello" },
      signal: controller.signal,
      retry: { attempts: 3, initialDelayMs: 0 },
      errorName: "TestHttpError",
    })).rejects.toThrow("connection reset");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
