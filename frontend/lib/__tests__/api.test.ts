/**
 * Exercises the real request/response interceptor chain from lib/api.ts
 * against a small fake axios instance so the CSRF refresh-dedup and 403
 * retry behavior run exactly as they do in production, with the network
 * call itself fully controlled by the test.
 */

type FakeRequestConfig = {
  url: string;
  method: string;
  data?: unknown;
  headers: Record<string, string> & {
    set: (key: string, value: string) => void;
    get: (key: string) => string | undefined;
  };
  [key: string]: unknown;
};

function normalizeHeaders(input: unknown): FakeRequestConfig["headers"] {
  const store: Record<string, string> = {};
  if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (typeof value === "string") store[key] = value;
    }
  }
  const headers = store as FakeRequestConfig["headers"];
  headers.set = (key: string, value: string) => {
    store[key] = value;
  };
  headers.get = (key: string) => store[key];
  return headers;
}

function createFakeAxiosInstance() {
  const requestInterceptors: Array<(config: FakeRequestConfig) => unknown> = [];
  const responseInterceptors: Array<{
    onSuccess?: (response: unknown) => unknown;
    onError?: (error: unknown) => unknown;
  }> = [];
  const transport = jest.fn();

  async function runRequest(config: Partial<FakeRequestConfig>) {
    let cfg: FakeRequestConfig = {
      ...(config as FakeRequestConfig),
      headers: normalizeHeaders(config.headers),
    };
    for (const fn of requestInterceptors) {
      cfg = (await fn(cfg)) as FakeRequestConfig;
    }
    try {
      const response = await transport(cfg);
      let result = response;
      for (const { onSuccess } of responseInterceptors) {
        if (onSuccess) result = await onSuccess(result);
      }
      return result;
    } catch (err) {
      (err as { config?: unknown }).config = cfg;
      for (const { onError } of responseInterceptors) {
        if (onError) {
          return await onError(err);
        }
      }
      throw err;
    }
  }

  const instance = {
    get: (url: string, config: Partial<FakeRequestConfig> = {}) =>
      runRequest({ ...config, url, method: "get" }),
    post: (url: string, data?: unknown, config: Partial<FakeRequestConfig> = {}) =>
      runRequest({ ...config, url, method: "post", data }),
    patch: (url: string, data?: unknown, config: Partial<FakeRequestConfig> = {}) =>
      runRequest({ ...config, url, method: "patch", data }),
    delete: (url: string, config: Partial<FakeRequestConfig> = {}) =>
      runRequest({ ...config, url, method: "delete" }),
    request: (config: Partial<FakeRequestConfig>) => runRequest(config),
    interceptors: {
      request: {
        use: (fn: (config: FakeRequestConfig) => unknown) => requestInterceptors.push(fn),
      },
      response: {
        use: (
          onSuccess?: (response: unknown) => unknown,
          onError?: (error: unknown) => unknown,
        ) => responseInterceptors.push({ onSuccess, onError }),
      },
    },
  };

  return { instance, transport };
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

let fakeAxios: ReturnType<typeof createFakeAxiosInstance>;

jest.mock("axios", () => {
  const actual = jest.requireActual("axios");
  const create = jest.fn(() => fakeAxios.instance);
  return { ...actual, create, default: { ...actual.default, create } };
});

function loadApi() {
  return require("../api") as typeof import("../api");
}

beforeEach(() => {
  jest.resetModules();
  fakeAxios = createFakeAxiosInstance();
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({ ok: true });
});

describe("CSRF token refresh deduplication", () => {
  it("shares one in-flight refresh across concurrent POST/PATCH (axios) and DELETE (fetch) callers", async () => {
    const { recordDonation, completeJobRelease, csrfFetch } = loadApi();
    const deferred = makeDeferred<{ data: { success: boolean; csrfToken: string } }>();

    fakeAxios.transport.mockImplementation((cfg: FakeRequestConfig) => {
      if (cfg.url === "/api/v1/csrf-token") return deferred.promise;
      return Promise.resolve({ data: { success: true, data: {} } });
    });

    const p1 = recordDonation({ projectId: "p1", donorAddress: "d1", transactionHash: "tx1" });
    const p2 = completeJobRelease("job-1", "tx2");
    const p3 = csrfFetch("/api/x", { method: "DELETE" });

    await flushMicrotasks();

    expect(fakeAxios.transport).toHaveBeenCalledTimes(1);
    expect((fakeAxios.transport.mock.calls[0][0] as FakeRequestConfig).url).toBe(
      "/api/v1/csrf-token",
    );

    deferred.resolve({ data: { success: true, csrfToken: "shared-token" } });
    await Promise.all([p1, p2, p3]);

    const csrfCalls = fakeAxios.transport.mock.calls.filter(
      (c) => (c[0] as FakeRequestConfig).url === "/api/v1/csrf-token",
    );
    expect(csrfCalls).toHaveLength(1);

    const postCall = fakeAxios.transport.mock.calls.find(
      (c) => (c[0] as FakeRequestConfig).method === "post",
    )?.[0] as FakeRequestConfig;
    const patchCall = fakeAxios.transport.mock.calls.find(
      (c) => (c[0] as FakeRequestConfig).method === "patch",
    )?.[0] as FakeRequestConfig;
    expect(postCall.headers.get("X-CSRF-Token")).toBe("shared-token");
    expect(patchCall.headers.get("X-CSRF-Token")).toBe("shared-token");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/x",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-CSRF-Token": "shared-token" }),
      }),
    );
  });

  it("clears the in-flight state on refresh failure so a later request can retry", async () => {
    const { recordDonation } = loadApi();
    const deferred = makeDeferred<never>();
    let csrfCallCount = 0;

    fakeAxios.transport.mockImplementation((cfg: FakeRequestConfig) => {
      if (cfg.url === "/api/v1/csrf-token") {
        csrfCallCount += 1;
        return csrfCallCount === 1
          ? deferred.promise
          : Promise.resolve({ data: { success: true, csrfToken: "recovered-token" } });
      }
      return Promise.resolve({ data: { success: true, data: {} } });
    });

    const p1 = recordDonation({ projectId: "p1", donorAddress: "d1", transactionHash: "tx1" });
    const p2 = recordDonation({ projectId: "p1", donorAddress: "d2", transactionHash: "tx2" });

    await flushMicrotasks();
    expect(csrfCallCount).toBe(1);

    deferred.reject(new Error("csrf service unavailable"));
    const [r1, r2] = await Promise.allSettled([p1, p2]);

    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
    expect(csrfCallCount).toBe(1);

    const result = await recordDonation({
      projectId: "p1",
      donorAddress: "d3",
      transactionHash: "tx3",
    });
    expect(result).toEqual({});
    expect(csrfCallCount).toBe(2);
  });

  it("does not re-fetch a CSRF token for sequential requests once one is cached", async () => {
    const { recordDonation, completeJobRelease } = loadApi();
    let csrfCallCount = 0;

    fakeAxios.transport.mockImplementation((cfg: FakeRequestConfig) => {
      if (cfg.url === "/api/v1/csrf-token") {
        csrfCallCount += 1;
        return Promise.resolve({ data: { success: true, csrfToken: "cached-token" } });
      }
      return Promise.resolve({ data: { success: true, data: {} } });
    });

    await recordDonation({ projectId: "p1", donorAddress: "d1", transactionHash: "tx1" });
    await completeJobRelease("job-1", "tx2");
    await recordDonation({ projectId: "p1", donorAddress: "d1", transactionHash: "tx3" });

    expect(csrfCallCount).toBe(1);
  });

  it("preserves the existing 403-triggered refresh-and-retry behavior", async () => {
    const { completeJobRelease } = loadApi();
    let csrfCallCount = 0;
    let jobCallCount = 0;

    fakeAxios.transport.mockImplementation((cfg: FakeRequestConfig) => {
      if (cfg.url === "/api/v1/csrf-token") {
        csrfCallCount += 1;
        return Promise.resolve({ data: { success: true, csrfToken: `tok-${csrfCallCount}` } });
      }
      if (cfg.method === "patch") {
        jobCallCount += 1;
        if (jobCallCount === 1) {
          const err = new Error("Forbidden") as Error & { response: { status: number } };
          err.response = { status: 403 };
          throw err;
        }
        return { data: { success: true, data: { id: "job-1" } } };
      }
      return Promise.resolve({ data: { success: true, data: {} } });
    });

    const result = await completeJobRelease("job-1", "tx1");

    expect(result).toEqual({ id: "job-1" });
    expect(jobCallCount).toBe(2);
    expect(csrfCallCount).toBe(2);
  });
});
