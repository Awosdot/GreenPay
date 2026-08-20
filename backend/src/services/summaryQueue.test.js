"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("./claude", () => ({
  generateProjectSummary: jest.fn(),
}));

jest.mock("./audit", () => ({
  logAdminAction: jest.fn(),
}));

const workHandlers = {};
const createdQueues = [];
let mockSend;

jest.mock("pg-boss", () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    start: jest.fn().mockResolvedValue(),
    createQueue: jest.fn().mockImplementation(async (name) => {
      createdQueues.push(name);
    }),
    work: jest.fn().mockImplementation(async (name, optionsOrCallback, maybeCallback) => {
      workHandlers[name] = maybeCallback || optionsOrCallback;
    }),
    send: (...args) => mockSend(...args),
  }));
});

const pool = require("../db/pool");
const { generateProjectSummary } = require("./claude");
const summaryQueue = require("./summaryQueue");

describe("summaryQueue", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    createdQueues.length = 0;
    for (const key of Object.keys(workHandlers)) delete workHandlers[key];
    mockSend = jest.fn().mockResolvedValue("job-1");
    await summaryQueue.start(null);
  });

  it("creates the dead-letter queue before the main queue references it", () => {
    expect(createdQueues).toEqual(["ai-summary-dlq", "ai-summary"]);
  });

  it("registers work handlers for both the main queue and the DLQ", () => {
    expect(typeof workHandlers["ai-summary"]).toBe("function");
    expect(typeof workHandlers["ai-summary-dlq"]).toBe("function");
  });

  it("enqueueAISummary sends a job onto the ai-summary queue", async () => {
    await summaryQueue.enqueueAISummary("project-1", {
      name: "Solar Co-op",
      category: "Solar",
      description: "desc",
      adminAddress: "GADMIN",
    });

    expect(mockSend).toHaveBeenCalledWith(
      "ai-summary",
      { projectId: "project-1", name: "Solar Co-op", category: "Solar", description: "desc", adminAddress: "GADMIN" },
      { retryLimit: 3, retryDelay: 10 },
    );
  });

  it("enqueueAISummary throws if start() has not been called", async () => {
    jest.resetModules();
    const fresh = require("./summaryQueue");
    await expect(fresh.enqueueAISummary("p1", {})).rejects.toThrow("summaryQueue not started");
  });

  describe("main queue worker", () => {
    it("handles a single-job array (pg-boss always passes an array)", async () => {
      generateProjectSummary.mockResolvedValue({ summary: "A great project.", model: "claude-opus-4-7" });
      pool.query.mockResolvedValue({
        rows: [{ ai_summary: "A great project.", ai_summary_generated_at: new Date(), ai_summary_model: "claude-opus-4-7" }],
      });

      const job = { data: { projectId: "project-1", name: "Solar", category: "Solar", description: "desc" } };
      await workHandlers["ai-summary"]([job]);

      expect(generateProjectSummary).toHaveBeenCalledWith({ name: "Solar", category: "Solar", description: "desc" });
      expect(pool.query).toHaveBeenCalled();
    });

    it("skips retry and returns cleanly when ANTHROPIC_API_KEY is missing", async () => {
      const err = new Error("ANTHROPIC_API_KEY is not set");
      err.code = "MISSING_API_KEY";
      generateProjectSummary.mockRejectedValue(err);

      const job = { data: { projectId: "project-1", name: "Solar", category: "Solar", description: "desc" } };
      await expect(workHandlers["ai-summary"]([job])).resolves.toBeUndefined();
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("rethrows other errors so pg-boss retries the job", async () => {
      generateProjectSummary.mockRejectedValue(new Error("Claude API timeout"));

      const job = { data: { projectId: "project-1", name: "Solar", category: "Solar", description: "desc" } };
      await expect(workHandlers["ai-summary"]([job])).rejects.toThrow("Claude API timeout");
    });
  });

  describe("dead-letter queue worker", () => {
    it("records the failure with the original payload and serialized error", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      const job = {
        data: { projectId: "project-1", name: "Solar", category: "Solar", description: "desc" },
        output: { name: "Error", message: "Claude API timeout", stack: "Error: Claude API timeout\n at x" },
      };
      await workHandlers["ai-summary-dlq"]([job]);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO ai_summary_job_failures"),
        expect.arrayContaining([
          expect.any(String),
          "project-1",
          JSON.stringify({ name: "Solar", category: "Solar", description: "desc" }),
          "Claude API timeout",
          "Error: Claude API timeout\n at x",
        ]),
      );
    });

    it("does not throw when the insert itself fails", async () => {
      pool.query.mockRejectedValue(new Error("connection lost"));

      const job = {
        data: { projectId: "project-1" },
        output: { message: "boom" },
      };
      await expect(workHandlers["ai-summary-dlq"]([job])).resolves.toBeUndefined();
    });
  });
});
