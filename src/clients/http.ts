const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 8_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

const DEFAULT_RETRYABLE_STATUS_CODES = new Set([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
]);

export type HttpTransportRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
};

export type HttpTransportResponse = {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
};

export type HttpTransport = (
  request: HttpTransportRequest,
) => Promise<HttpTransportResponse>;

export type HttpRetryOptions = {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
  retryableStatusCodes?: ReadonlyArray<number>;
  shouldRetry?: (input: {
    error: Error;
    attempt: number;
    status?: number;
  }) => boolean | Promise<boolean>;
};

export type FetchTransportOptions = {
  timeoutMs?: number;
  retry?: HttpRetryOptions;
  fetch?: typeof fetch;
};

export type ModelHttpError = Error & {
  status?: number;
  responseText?: string;
  headers?: Headers;
  attempt?: number;
};

export class ModelTransportTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`model API request timed out after ${timeoutMs}ms`);
    this.name = "ModelTransportTimeoutError";
  }
}

export function createFetchTransport(options: FetchTransportOptions = {}): HttpTransport {
  const requestFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

  return async (request) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new ModelTransportTimeoutError(timeoutMs));
    }, timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;

    try {
      const response = await requestFetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal,
      });
      const text = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        text,
      };
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof ModelTransportTimeoutError) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function postJson<TResponse>(input: {
  transport: HttpTransport;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  retry?: HttpRetryOptions;
  errorName: string;
}): Promise<TResponse> {
  const attempts = input.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const initialDelayMs = input.retry?.initialDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
  const maxDelayMs = input.retry?.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const maxRetryAfterMs = input.retry?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const retryableStatusCodes = new Set(
    input.retry?.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES,
  );
  const body = JSON.stringify(input.body);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let error: ModelHttpError;
    try {
      const response = await input.transport({
        url: input.url,
        method: "POST",
        headers: input.headers,
        body,
        signal: input.signal,
      });
      if (response.ok) {
        return response.text.length === 0 ? {} as TResponse : JSON.parse(response.text) as TResponse;
      }

      error = new Error(
        `${input.errorName} failed with status ${response.status}: ${response.text}`,
      ) as ModelHttpError;
      error.name = input.errorName;
      error.status = response.status;
      error.responseText = response.text;
      error.headers = response.headers;
      error.attempt = attempt;
    } catch (caught) {
      if (input.signal?.aborted) {
        throw caught;
      }

      error = caught as ModelHttpError;
      error.attempt = attempt;
    }

    if (attempt === attempts || !(await shouldRetry(error, {
      attempt,
      retryableStatusCodes,
      shouldRetry: input.retry?.shouldRetry,
      maxRetryAfterMs,
      retryAfterHeader: error.headers?.get("retry-after") ?? null,
    }))) {
      throw error;
    }

    const retryAfterMs = parseRetryAfterMs(error.headers?.get("retry-after") ?? null);
    if (retryAfterMs !== undefined && retryAfterMs > maxRetryAfterMs) {
      throw error;
    }
    const delayMs = retryAfterMs ?? Math.min(
      initialDelayMs * 2 ** (attempt - 1),
      maxDelayMs,
    );
    await sleep(delayMs, input.signal);
  }

  throw new Error("unreachable model API retry state");
}

export async function postSse(input: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  retry?: HttpRetryOptions;
  errorName: string;
  fetch?: typeof fetch;
  onEvent: (event: { event?: string; data: string }) => void | Promise<void>;
}): Promise<void> {
  const attempts = input.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const initialDelayMs = input.retry?.initialDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
  const maxDelayMs = input.retry?.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const maxRetryAfterMs = input.retry?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const retryableStatusCodes = new Set(
    input.retry?.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES,
  );
  const requestFetch = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const body = JSON.stringify(input.body);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let streamStarted = false;
    let error: ModelHttpError;
    try {
      const controller = new AbortController();
      let timeout = setTimeout(() => {
        controller.abort(new ModelTransportTimeoutError(timeoutMs));
      }, timeoutMs);
      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          controller.abort(new ModelTransportTimeoutError(timeoutMs));
        }, timeoutMs);
      };
      const signal = input.signal
        ? AbortSignal.any([input.signal, controller.signal])
        : controller.signal;

      try {
        const response = await requestFetch(input.url, {
          method: "POST",
          headers: input.headers,
          body,
          signal,
        });
        if (!response.ok) {
          const responseText = await response.text();
          error = new Error(
            `${input.errorName} failed with status ${response.status}: ${responseText}`,
          ) as ModelHttpError;
          error.name = input.errorName;
          error.status = response.status;
          error.responseText = responseText;
          error.headers = response.headers;
          error.attempt = attempt;
        } else if (!response.body) {
          throw new Error(`${input.errorName} returned an empty stream`);
        } else {
          streamStarted = true;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          try {
            while (true) {
              const chunk = await reader.read();
              resetTimeout();
              if (chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              const segments = buffer.split(/\r?\n\r?\n/);
              buffer = segments.pop() ?? "";

              for (const segment of segments) {
                let eventName: string | undefined;
                const dataLines: Array<string> = [];
                for (const line of segment.split(/\r?\n/)) {
                  if (line.startsWith("event:")) {
                    eventName = line.slice(6).trim();
                  } else if (line.startsWith("data:")) {
                    dataLines.push(line.slice(5).trimStart());
                  }
                }
                if (dataLines.length > 0) {
                  await input.onEvent({
                    event: eventName,
                    data: dataLines.join("\n"),
                  });
                }
              }
            }
            buffer += decoder.decode();
            if (buffer.trim().length > 0) {
              const lines = buffer.split(/\r?\n/);
              const dataLines = lines
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart());
              if (dataLines.length > 0) {
                await input.onEvent({ data: dataLines.join("\n") });
              }
            }
          } finally {
            reader.releaseLock();
          }
          return;
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (caught) {
      if (input.signal?.aborted) {
        throw caught;
      }
      error = caught as ModelHttpError;
      error.attempt = attempt;
    }

    if (
      streamStarted ||
      attempt === attempts ||
      !(await shouldRetry(error, {
        attempt,
        retryableStatusCodes,
        shouldRetry: input.retry?.shouldRetry,
        maxRetryAfterMs,
        retryAfterHeader: error.headers?.get("retry-after") ?? null,
      }))
    ) {
      throw error;
    }

    const retryAfterMs = parseRetryAfterMs(error.headers?.get("retry-after") ?? null);
    if (retryAfterMs !== undefined && retryAfterMs > maxRetryAfterMs) {
      throw error;
    }
    const delayMs = retryAfterMs ?? Math.min(
      initialDelayMs * 2 ** (attempt - 1),
      maxDelayMs,
    );
    await sleep(delayMs, input.signal);
  }

  throw new Error("unreachable model API SSE retry state");
}

async function shouldRetry(
  error: ModelHttpError,
  input: {
    attempt: number;
    retryableStatusCodes: Set<number>;
    shouldRetry?: HttpRetryOptions["shouldRetry"];
    maxRetryAfterMs: number;
    retryAfterHeader: string | null;
  },
): Promise<boolean> {
  if (error.name === "ModelTransportTimeoutError") {
    return true;
  }
  if (error.name === "AbortError") {
    return false;
  }
  if (error.status !== undefined && !input.retryableStatusCodes.has(error.status)) {
    return false;
  }
  if (error.status === undefined && !(error instanceof TypeError)) {
    return false;
  }
  if (input.retryAfterHeader !== undefined && input.retryAfterHeader !== null) {
    const retryAfterMs = parseRetryAfterMs(input.retryAfterHeader);
    if (retryAfterMs !== undefined && retryAfterMs > input.maxRetryAfterMs) {
      return false;
    }
  }

  return await input.shouldRetry?.({ error, attempt: input.attempt, status: error.status }) ?? true;
}

function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const date = new Date(header);
  const milliseconds = date.getTime() - Date.now();
  return milliseconds >= 0 ? milliseconds : 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}
