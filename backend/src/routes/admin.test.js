"use strict";
const express = require("express");
const request = require("supertest");
const { signToken, adminRequired } = require("../middleware/auth");

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../services/summaryQueue", () => ({
  enqueueAISummary: jest.fn(),
}));

const pool = require("../db/pool");
const { enqueueAISummary } = require("../services/summaryQueue");

process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "testpass";
process.env.JWT_SECRET = "test-secret-for-jest";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", require("./admin"));
  return app;
}

describe("POST /api/admin/login", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 401 when no credentials are sent", async () => {
    const res = await request(app).post("/api/admin/login").send({});
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong username", async () => {
    const res = await request(app).post("/api/admin/login").send({ username: "wrong", password: "testpass" });
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong password", async () => {
    const res = await request(app).post("/api/admin/login").send({ username: "admin", password: "wrongpass" });
    expect(res.status).toBe(401);
  });

  it("returns a token and refreshToken for valid credentials", async () => {
    const res = await request(app).post("/api/admin/login").send({ username: "admin", password: "testpass" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.expiresIn).toBe(3600);
  });

  it("returns 503 when ADMIN_PASSWORD is not configured", async () => {
    delete process.env.ADMIN_PASSWORD;
    const res = await request(app).post("/api/admin/login").send({ username: "admin", password: "testpass" });
    expect(res.status).toBe(503);
    process.env.ADMIN_PASSWORD = "testpass";
  });
});

describe("POST /api/admin/refresh", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 400 when no refreshToken is sent", async () => {
    const res = await request(app).post("/api/admin/refresh").send({});
    expect(res.status).toBe(400);
  });

  it("returns 401 for invalid refresh token", async () => {
    const res = await request(app).post("/api/admin/refresh").send({ refreshToken: "bogus" });
    expect(res.status).toBe(401);
  });

  it("returns a new token for a valid refresh token", async () => {
    const loginRes = await request(app).post("/api/admin/login").send({ username: "admin", password: "testpass" });
    const refreshToken = loginRes.body.data.refreshToken;

    const res = await request(app).post("/api/admin/refresh").send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.expiresIn).toBe(3600);
  });
});

describe("GET /api/admin/me", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 401 without Authorization header", async () => {
    const res = await request(app).get("/api/admin/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 with malformed Authorization header", async () => {
    const res = await request(app).get("/api/admin/me").set("Authorization", "NotBearer token");
    expect(res.status).toBe(401);
  });

  it("returns 401 with expired token", async () => {
    const expired = signToken({ role: "admin" }, "0s");
    await new Promise((r) => setTimeout(r, 100));
    const res = await request(app).get("/api/admin/me").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it("returns admin info with valid token", async () => {
    const loginRes = await request(app).post("/api/admin/login").send({ username: "admin", password: "testpass" });
    const token = loginRes.body.data.token;

    const res = await request(app).get("/api/admin/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.username).toBe("admin");
    expect(res.body.data.role).toBe("admin");
  });
});

describe("GET /api/admin/ai-summary-failures", () => {
  let app, token;

  beforeEach(() => {
    app = buildApp();
    token = signToken({ role: "admin", sub: "admin" }, "1h");
    pool.query.mockReset();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/admin/ai-summary-failures");
    expect(res.status).toBe(401);
  });

  it("returns paginated failure records", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "f1",
            project_id: "project-1",
            payload: { name: "Solar", category: "Solar", description: "desc" },
            error_message: "Claude API timeout",
            error_stack: "Error: Claude API timeout",
            status: "failed",
            created_at: new Date("2026-08-01T00:00:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });

    const res = await request(app)
      .get("/api/admin/ai-summary-failures")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: "f1",
      projectId: "project-1",
      errorMessage: "Claude API timeout",
      status: "failed",
    });
    expect(res.body.pagination).toEqual({ total: 1, limit: 50, offset: 0 });
  });

  it("filters by status", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });

    const res = await request(app)
      .get("/api/admin/ai-summary-failures?status=retried")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][0]).toContain("WHERE status = $1");
    expect(pool.query.mock.calls[0][1]).toEqual(["retried", 50, 0]);
  });
});

describe("POST /api/admin/ai-summary-failures/:id/retry", () => {
  let app, token;

  beforeEach(() => {
    app = buildApp();
    token = signToken({ role: "admin", sub: "admin" }, "1h");
    pool.query.mockReset();
    enqueueAISummary.mockReset();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).post("/api/admin/ai-summary-failures/f1/retry");
    expect(res.status).toBe(401);
  });

  it("returns 404 when the failure record does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/admin/ai-summary-failures/missing/retry")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(enqueueAISummary).not.toHaveBeenCalled();
  });

  it("re-enqueues the original payload and marks the row retried", async () => {
    const payload = { name: "Solar", category: "Solar", description: "desc" };
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "f1", project_id: "project-1", payload, status: "failed" }] })
      .mockResolvedValueOnce({ rows: [] });
    enqueueAISummary.mockResolvedValue("job-2");

    const res = await request(app)
      .post("/api/admin/ai-summary-failures/f1/retry")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: "f1", status: "retried" } });
    expect(enqueueAISummary).toHaveBeenCalledWith("project-1", payload);
    expect(pool.query.mock.calls[1][0]).toContain("SET status = 'retried'");
  });
});

describe("adminRequired middleware", () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.get("/protected", adminRequired, (req, res) => res.json({ ok: true, user: req.admin }));
  });

  it("allows requests with valid token", async () => {
    const token = signToken({ role: "admin", sub: "admin" }, "1h");
    const res = await request(app).get("/protected").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
