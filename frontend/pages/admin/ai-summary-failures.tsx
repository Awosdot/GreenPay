/**
 * pages/admin/ai-summary-failures.tsx — Admin visibility into AI-summary
 * jobs that exhausted their pg-boss retries and landed on the dead-letter
 * queue. Gated behind the JWT admin login (username/password), not wallet
 * connection, since it exposes internal job/error data rather than
 * project-owner actions.
 */
import { useEffect, useState, useCallback } from "react";
import Head from "next/head";
import {
  adminLogin,
  fetchAISummaryFailures,
  retryAISummaryFailure,
  type AISummaryJobFailure,
} from "@/lib/api";

const PAGE_SIZE = 20;

export default function AISummaryFailuresPage() {
  const [token, setToken] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const [failures, setFailures] = useState<AISummaryJobFailure[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const loadFailures = useCallback((authToken: string, atOffset: number) => {
    setLoading(true);
    setLoadError(null);
    fetchAISummaryFailures(authToken, { limit: PAGE_SIZE, offset: atOffset })
      .then(({ data, pagination }) => {
        setFailures(data);
        setTotal(pagination.total);
        setOffset(pagination.offset);
      })
      .catch((e: unknown) => setLoadError((e as Error).message || "Failed to load failures"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (token) loadFailures(token, 0);
  }, [token, loadFailures]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    setLoggingIn(true);
    try {
      const { token: authToken } = await adminLogin(username, password);
      setToken(authToken);
    } catch (e: unknown) {
      setLoginError((e as Error).message || "Login failed");
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleRetry(id: string) {
    if (!token) return;
    setRetryingId(id);
    try {
      await retryAISummaryFailure(token, id);
      setFailures((prev) => prev.map((f) => (f.id === id ? { ...f, status: "retried" } : f)));
    } catch (e: unknown) {
      setLoadError((e as Error).message || "Retry failed");
    } finally {
      setRetryingId(null);
    }
  }

  if (!token) {
    return (
      <div className="max-w-md mx-auto px-4 sm:px-6 py-16">
        <Head>
          <title>Admin Login — AI Summary Failures</title>
        </Head>
        <div className="text-center mb-8">
          <p className="text-xs tracking-[0.22em] uppercase text-[#547454] font-body">Admin</p>
          <h1 className="font-display text-2xl font-bold text-forest-900 mb-1">AI Summary Failures</h1>
          <p className="text-sm text-[#4b654b] font-body">Sign in with the admin account to view dead-lettered jobs.</p>
        </div>
        <form onSubmit={handleLogin} className="card space-y-4">
          <div>
            <label htmlFor="username" className="block text-sm font-body text-[#4b654b] mb-1">Username</label>
            <input
              id="username"
              className="input-field"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-body text-[#4b654b] mb-1">Password</label>
            <input
              id="password"
              type="password"
              className="input-field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {loginError && <p className="text-red-600 text-sm font-body">{loginError}</p>}
          <button type="submit" className="btn-primary w-full" disabled={loggingIn}>
            {loggingIn ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 animate-fade-in">
      <Head>
        <title>AI Summary Failures — Admin</title>
      </Head>
      <div className="mb-8">
        <p className="text-xs tracking-[0.22em] uppercase text-[#547454] font-body">Admin</p>
        <h1 className="font-display text-3xl font-bold text-forest-900 mb-1">AI Summary Failures</h1>
        <p className="text-sm text-[#4b654b] font-body">
          Jobs that exhausted retries generating an AI project summary and landed on the dead-letter queue.
        </p>
      </div>

      {loading && (
        <div className="card animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-4 bg-forest-100 rounded" />
          ))}
        </div>
      )}

      {loadError && (
        <div className="card mb-4">
          <p className="text-red-600 font-body">{loadError}</p>
        </div>
      )}

      {!loading && failures.length === 0 && !loadError && (
        <div className="card">
          <p className="text-[#4b654b] font-body">No dead-lettered AI summary jobs.</p>
        </div>
      )}

      {!loading && failures.length > 0 && (
        <div className="space-y-3">
          {failures.map((f) => (
            <div key={f.id} className="card flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="font-display font-semibold text-forest-900 truncate">
                    {f.payload.name || f.projectId}
                  </h2>
                  <span
                    className={`badge text-xs flex-shrink-0 ${
                      f.status === "retried"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-red-50 text-red-700 border-red-200"
                    }`}
                  >
                    {f.status}
                  </span>
                </div>
                <p className="text-xs text-[#547454] font-body mb-1">
                  Project {f.projectId} • {new Date(f.createdAt).toLocaleString()}
                </p>
                {f.errorMessage && (
                  <p className="text-xs text-red-600 font-body break-words">{f.errorMessage}</p>
                )}
              </div>
              <button
                className="btn-primary text-sm flex-shrink-0"
                disabled={f.status === "retried" || retryingId === f.id}
                onClick={() => handleRetry(f.id)}
              >
                {retryingId === f.id ? "Retrying…" : f.status === "retried" ? "Retried" : "Retry"}
              </button>
            </div>
          ))}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-6 text-sm font-body text-[#4b654b]">
          <button
            className="btn-primary text-sm"
            disabled={offset === 0 || loading}
            onClick={() => loadFailures(token, Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </button>
          <span>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <button
            className="btn-primary text-sm"
            disabled={offset + PAGE_SIZE >= total || loading}
            onClick={() => loadFailures(token, offset + PAGE_SIZE)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
