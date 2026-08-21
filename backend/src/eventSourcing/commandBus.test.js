"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const pool = require("../db/pool");
const { execute } = require("./commandBus");
const { RecordDonationCommand } = require("./commands");

function makePublicKey(char = "A") {
  return `G${char.repeat(55)}`;
}

function makeTxHash(char = "a") {
  return char.repeat(64);
}

function queryResult(rows = []) {
  return Promise.resolve({ rows, rowCount: rows.length });
}

/**
 * Wires pool.query to answer the fixed sequence of lookups
 * DonationCommandHandler issues (dedup check, project existence, next
 * version) by inspecting the SQL text, so the test doesn't depend on call
 * order. Every SQL statement actually issued is recorded in `queries` so
 * tests can assert on what was (and wasn't) written.
 */
function wireDonationHandlerQueries({ projectId, dedupRow = null, insertResult = { rows: [], rowCount: 1 } } = {}) {
  const queries = [];
  pool.query.mockImplementation((sql, params) => {
    queries.push({ sql, params });
    if (sql.includes("FROM event_stream") && sql.includes("transactionHash")) {
      return queryResult(dedupRow ? [dedupRow] : []);
    }
    if (sql.includes("SELECT id FROM projects")) {
      return queryResult(projectId ? [{ id: projectId }] : []);
    }
    if (sql.includes("MAX(version)")) {
      return queryResult([{ max_version: 0 }]);
    }
    if (sql.startsWith("INSERT INTO event_stream")) {
      return Promise.resolve(insertResult);
    }
    return Promise.reject(new Error(`Unexpected query in test: ${sql}`));
  });
  return queries;
}

describe("DonationCommandHandler", () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  test("records a new donation without writing projects.raised_xlm or donor_stats directly", async () => {
    const projectId = "project-1";
    const donorAddress = makePublicKey();
    const queries = wireDonationHandlerQueries({ projectId });

    const result = await execute(
      new RecordDonationCommand({
        actor: donorAddress,
        projectId,
        donorAddress,
        amountXlm: 25,
        currency: "XLM",
        transactionHash: makeTxHash(),
      })
    );

    expect(result.deduplicated).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe("DonationRecorded");
    expect(result.data.amountXlm).toBe(25);

    // The command handler must insert the event and nothing else — totals
    // are the async projection's job exclusively (issue #368).
    const sqlStatements = queries.map((q) => q.sql);
    expect(sqlStatements.some((sql) => sql.startsWith("INSERT INTO event_stream"))).toBe(true);
    expect(sqlStatements.some((sql) => /UPDATE\s+projects/i.test(sql))).toBe(false);
    expect(sqlStatements.some((sql) => /donor_stats/i.test(sql))).toBe(false);
  });

  test("throws when the project does not exist", async () => {
    wireDonationHandlerQueries({ projectId: null });

    await expect(
      execute(
        new RecordDonationCommand({
          actor: makePublicKey(),
          projectId: "missing-project",
          donorAddress: makePublicKey(),
          amountXlm: 10,
          currency: "XLM",
          transactionHash: makeTxHash("b"),
        })
      )
    ).rejects.toThrow("Project not found");
  });

  test("returns the existing event when the transaction hash was already recorded (dedup)", async () => {
    const txHash = makeTxHash("c");
    const existingEventId = "existing-event-id";
    const queries = wireDonationHandlerQueries({
      projectId: "project-1",
      dedupRow: { event_id: existingEventId },
    });
    // Second lookup: SELECT * FROM event_stream WHERE event_id = $1
    pool.query.mockImplementation((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("transactionHash")) return queryResult([{ event_id: existingEventId }]);
      if (sql === "SELECT * FROM event_stream WHERE event_id = $1") {
        return queryResult([
          {
            event_id: existingEventId,
            stream_id: `Donation:${txHash}`,
            aggregate_type: "Donation",
            aggregate_id: txHash,
            event_type: "DonationRecorded",
            version: 1,
            aggregate_version: 1,
            payload: { data: { amountXlm: 5, transactionHash: txHash } },
            actor: "system",
            occurred_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ]);
      }
      return Promise.reject(new Error(`Unexpected query in test: ${sql}`));
    });

    const result = await execute(
      new RecordDonationCommand({
        actor: makePublicKey(),
        projectId: "project-1",
        donorAddress: makePublicKey(),
        amountXlm: 5,
        currency: "XLM",
        transactionHash: txHash,
      })
    );

    expect(result.deduplicated).toBe(true);
    expect(result.data.eventId).toBe(existingEventId);

    const sqlStatements = queries.map((q) => q.sql);
    expect(sqlStatements.some((sql) => /UPDATE\s+projects/i.test(sql))).toBe(false);
    expect(sqlStatements.some((sql) => /donor_stats/i.test(sql))).toBe(false);
  });
});
