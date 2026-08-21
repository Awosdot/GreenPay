"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const pool = require("../db/pool");
const {
  toScaledInt,
  fromScaledInt,
  amountsEqual,
  computeProjectRaisedXlm,
  computeDonorTotalDonated,
  isGoalFalselyReached,
  runDryRun,
  reconcileProject,
  reconcileDonor,
  applyCorrections,
} = require("./reconcile-donation-totals");

function donationEvent(amountXlm, { currency = "XLM", projectId = "project-1", donorAddress = "donor-1" } = {}) {
  return { eventType: "DonationRecorded", data: { amountXlm, currency, projectId, donorAddress } };
}

function migratedEvent(amountXlm, { currency = "XLM", projectId = "project-1", donorAddress = "donor-1", isMatch = false } = {}) {
  return { eventType: "LegacyDonationMigrated", data: { amountXlm, currency, projectId, donorAddress, isMatch } };
}

function matchEvent(matchAmount, { projectId = "project-1", donorAddress = "donor-1" } = {}) {
  return { eventType: "MatchApplied", data: { matchAmount, projectId, donorAddress } };
}

describe("scaled decimal helpers", () => {
  test("round-trips fractional XLM amounts exactly", () => {
    expect(fromScaledInt(toScaledInt(12.3456789))).toBe("12.3456789");
    expect(fromScaledInt(toScaledInt("0.0000001"))).toBe("0.0000001");
    expect(fromScaledInt(toScaledInt(0))).toBe("0.0000000");
  });

  test("amountsEqual ignores string vs number formatting differences", () => {
    expect(amountsEqual("25.0000000", 25)).toBe(true);
    expect(amountsEqual("25.0000001", 25)).toBe(false);
  });

  test("does not accumulate floating-point drift over many additions", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE754 doubles; the scaled-BigInt sum must not
    // inherit that drift the way naive JS float addition would.
    let total = 0n;
    for (let i = 0; i < 10; i++) total += toScaledInt(0.1);
    expect(fromScaledInt(total)).toBe("1.0000000");
  });
});

describe("computeProjectRaisedXlm", () => {
  test("returns zero for an empty history", () => {
    expect(computeProjectRaisedXlm([])).toBe("0.0000000");
  });

  test("recovers the correct single-counted total from a known donation history", () => {
    // This is the exact scenario #368 is about: event_stream holds one
    // event per donation (never duplicated); the historical bug duplicated
    // the *write* to raised_xlm, not the event itself. Recomputing straight
    // from events must therefore land on the plain sum, not some multiple.
    const events = [donationEvent(100), donationEvent(50), donationEvent(25.5)];
    expect(computeProjectRaisedXlm(events)).toBe("175.5000000");
  });

  test("includes MatchApplied amounts unconditionally", () => {
    const events = [donationEvent(100), matchEvent(40)];
    expect(computeProjectRaisedXlm(events)).toBe("140.0000000");
  });

  test("includes LegacyDonationMigrated amounts like regular donations", () => {
    const events = [migratedEvent(200), donationEvent(50)];
    expect(computeProjectRaisedXlm(events)).toBe("250.0000000");
  });

  test("ignores non-XLM donations", () => {
    const events = [donationEvent(100, { currency: "USDC" }), donationEvent(50)];
    expect(computeProjectRaisedXlm(events)).toBe("50.0000000");
  });

  test("isolates events by project when mixed together", () => {
    const events = [
      donationEvent(100, { projectId: "project-1" }),
      donationEvent(999, { projectId: "project-2" }),
    ];
    const projectOneOnly = events.filter((e) => e.data.projectId === "project-1");
    expect(computeProjectRaisedXlm(projectOneOnly)).toBe("100.0000000");
  });
});

describe("computeDonorTotalDonated", () => {
  test("returns zero for an empty history", () => {
    expect(computeDonorTotalDonated([])).toBe("0.0000000");
  });

  test("sums DonationRecorded and LegacyDonationMigrated for the donor", () => {
    const events = [donationEvent(30), migratedEvent(70)];
    expect(computeDonorTotalDonated(events)).toBe("100.0000000");
  });

  test("does not count MatchApplied toward donor totals (documented pre-existing gap, not part of #368)", () => {
    // MatchApplied events don't carry a `data` shape computeDonorTotalDonated
    // reads (no `currency`), so they contribute nothing — matching what the
    // live projection actually does today.
    const events = [donationEvent(30), matchEvent(999)];
    expect(computeDonorTotalDonated(events)).toBe("30.0000000");
  });

  test("ignores non-XLM contributions", () => {
    const events = [donationEvent(30, { currency: "USDC" }), donationEvent(10)];
    expect(computeDonorTotalDonated(events)).toBe("10.0000000");
  });
});

describe("isGoalFalselyReached", () => {
  test("true when the persisted total met the goal but the reconstructed one does not", () => {
    expect(isGoalFalselyReached({ persisted: "100.0000000", computed: "60.0000000", goalXlm: "100" })).toBe(true);
  });

  test("false when the reconstructed total still meets the goal", () => {
    expect(isGoalFalselyReached({ persisted: "150.0000000", computed: "120.0000000", goalXlm: "100" })).toBe(false);
  });

  test("false when the persisted total never met the goal", () => {
    expect(isGoalFalselyReached({ persisted: "40.0000000", computed: "20.0000000", goalXlm: "100" })).toBe(false);
  });

  test("false when there is no goal set", () => {
    expect(isGoalFalselyReached({ persisted: "100", computed: "0", goalXlm: "0" })).toBe(false);
    expect(isGoalFalselyReached({ persisted: "100", computed: "0", goalXlm: null })).toBe(false);
  });
});

function queryResult(rows = []) {
  return Promise.resolve({ rows, rowCount: rows.length });
}

describe("runDryRun", () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  test("reports only the rows whose computed total differs from what is persisted, and writes nothing", async () => {
    pool.query.mockImplementation((sql) => {
      if (sql === "SELECT id, raised_xlm, goal_xlm FROM projects") {
        return queryResult([
          { id: "project-inflated", raised_xlm: "200.0000000", goal_xlm: "150.0000000" },
          { id: "project-correct", raised_xlm: "50.0000000", goal_xlm: "100.0000000" },
        ]);
      }
      if (sql === "SELECT public_key, total_donated_xlm FROM donor_stats") {
        return queryResult([{ public_key: "donor-1", total_donated_xlm: "100.0000000" }]);
      }
      if (sql.includes("project_id") && sql.includes("event_stream")) {
        return queryResult([
          { project_id: "project-inflated", event_type: "DonationRecorded", payload: { data: { amountXlm: 100, currency: "XLM", projectId: "project-inflated" } } },
          { project_id: "project-correct", event_type: "DonationRecorded", payload: { data: { amountXlm: 50, currency: "XLM", projectId: "project-correct" } } },
        ]);
      }
      if (sql.includes("donor_address") && sql.includes("event_stream")) {
        return queryResult([
          { donor_address: "donor-1", event_type: "DonationRecorded", payload: { data: { amountXlm: 50, currency: "XLM", donorAddress: "donor-1" } } },
        ]);
      }
      if (sql.includes("project_milestones")) {
        return queryResult([]);
      }
      return Promise.reject(new Error(`Unexpected query in test: ${sql}`));
    });

    const report = await runDryRun(pool);

    expect(report.projects).toEqual([
      expect.objectContaining({ projectId: "project-inflated", persisted: "200.0000000", computed: "100.0000000" }),
    ]);
    expect(report.donors).toEqual([
      expect.objectContaining({ donorAddress: "donor-1", persisted: "100.0000000", computed: "50.0000000" }),
    ]);
    expect(report.goalFalselyReached).toHaveLength(1);
    expect(report.goalFalselyReached[0].projectId).toBe("project-inflated");
    expect(report.totalsScanned).toEqual({ projects: 2, donors: 1 });

    // Dry run must never write.
    const sqlStatements = pool.query.mock.calls.map(([sql]) => sql);
    expect(sqlStatements.some((sql) => /^UPDATE/i.test(sql))).toBe(false);
    expect(sqlStatements.some((sql) => /^INSERT/i.test(sql))).toBe(false);
  });

  test("reports nothing for an empty database", async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes("project_milestones")) return queryResult([]);
      return queryResult([]);
    });

    const report = await runDryRun(pool);

    expect(report.projects).toEqual([]);
    expect(report.donors).toEqual([]);
    expect(report.goalFalselyReached).toEqual([]);
    expect(report.totalsScanned).toEqual({ projects: 0, donors: 0 });
  });
});

function makeClient(queryImpl) {
  return { query: jest.fn(queryImpl), release: jest.fn() };
}

describe("reconcileProject", () => {
  test("locks the row, corrects an inflated total, and commits", async () => {
    const client = makeClient((sql) => {
      if (sql === "BEGIN" || sql === "COMMIT") return Promise.resolve();
      if (sql.includes("FOR UPDATE")) {
        return queryResult([{ id: "project-1", raised_xlm: "200.0000000" }]);
      }
      if (sql.includes("event_stream")) {
        return queryResult([
          { event_type: "DonationRecorded", payload: { data: { amountXlm: 100, currency: "XLM" } } },
        ]);
      }
      if (sql.startsWith("UPDATE projects")) {
        return queryResult([]);
      }
      return Promise.reject(new Error(`Unexpected query in test: ${sql}`));
    });
    pool.connect = jest.fn().mockResolvedValue(client);

    const result = await reconcileProject(pool, "project-1");

    expect(result).toEqual({ projectId: "project-1", applied: true, persisted: "200.0000000", computed: "100.0000000" });
    const calls = client.query.mock.calls.map(([sql]) => sql);
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("COMMIT");
    expect(calls.some((sql) => sql.includes("FOR UPDATE"))).toBe(true);
    expect(calls.some((sql) => sql.startsWith("UPDATE projects"))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  test("is idempotent: re-running once already correct makes no write", async () => {
    const client = makeClient((sql) => {
      if (sql === "BEGIN" || sql === "COMMIT") return Promise.resolve();
      if (sql.includes("FOR UPDATE")) {
        return queryResult([{ id: "project-1", raised_xlm: "100.0000000" }]);
      }
      if (sql.includes("event_stream")) {
        return queryResult([
          { event_type: "DonationRecorded", payload: { data: { amountXlm: 100, currency: "XLM" } } },
        ]);
      }
      return Promise.reject(new Error(`Unexpected query in test: ${sql}`));
    });
    pool.connect = jest.fn().mockResolvedValue(client);

    const result = await reconcileProject(pool, "project-1");

    expect(result).toEqual({
      projectId: "project-1",
      applied: false,
      reason: "already_correct",
      persisted: "100.0000000",
      computed: "100.0000000",
    });
    const calls = client.query.mock.calls.map(([sql]) => sql);
    expect(calls.some((sql) => sql.startsWith("UPDATE projects"))).toBe(false);
  });

  test("rolls back and reports the error without throwing, on a failed write", async () => {
    const client = makeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return Promise.resolve();
      if (sql.includes("FOR UPDATE")) {
        return queryResult([{ id: "project-1", raised_xlm: "200.0000000" }]);
      }
      if (sql.includes("event_stream")) {
        return queryResult([
          { event_type: "DonationRecorded", payload: { data: { amountXlm: 100, currency: "XLM" } } },
        ]);
      }
      if (sql.startsWith("UPDATE projects")) {
        return Promise.reject(new Error("connection lost"));
      }
      return Promise.reject(new Error(`Unexpected query in test: ${sql}`));
    });
    pool.connect = jest.fn().mockResolvedValue(client);

    const result = await reconcileProject(pool, "project-1");

    expect(result).toEqual({ projectId: "project-1", applied: false, reason: "error", error: "connection lost" });
    const calls = client.query.mock.calls.map(([sql]) => sql);
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  test("rolls back cleanly when the project no longer exists", async () => {
    const client = makeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return Promise.resolve();
      if (sql.includes("FOR UPDATE")) return queryResult([]);
      return Promise.reject(new Error(`Unexpected query in test: ${sql}`));
    });
    pool.connect = jest.fn().mockResolvedValue(client);

    const result = await reconcileProject(pool, "missing-project");

    expect(result).toEqual({ projectId: "missing-project", applied: false, reason: "not_found" });
  });
});

describe("reconcileDonor", () => {
  test("corrects an inflated donor total and recomputes badges", async () => {
    const client = makeClient((sql) => {
      if (sql === "BEGIN" || sql === "COMMIT") return Promise.resolve();
      if (sql.includes("FOR UPDATE")) {
        return queryResult([{ public_key: "donor-1", total_donated_xlm: "2000.0000000" }]);
      }
      if (sql.includes("event_stream")) {
        return queryResult([
          { event_type: "DonationRecorded", payload: { data: { amountXlm: 15, currency: "XLM" } } },
        ]);
      }
      if (sql.startsWith("UPDATE donor_stats")) {
        return queryResult([]);
      }
      return Promise.reject(new Error(`Unexpected query in test: ${sql}`));
    });
    pool.connect = jest.fn().mockResolvedValue(client);

    const result = await reconcileDonor(pool, "donor-1");

    expect(result).toEqual({ donorAddress: "donor-1", applied: true, persisted: "2000.0000000", computed: "15.0000000" });
    const updateCall = client.query.mock.calls.find(([sql]) => sql.startsWith("UPDATE donor_stats"));
    expect(updateCall[1][0]).toBe("15.0000000");
    // 15 XLM earns no badge tier (seedling starts at 10... wait 15 >= 10, so seedling).
    const badges = JSON.parse(updateCall[1][1]);
    expect(badges).toEqual([expect.objectContaining({ tier: "seedling" })]); // 15 XLM clears the 10 XLM seedling tier
  });
});

describe("applyCorrections", () => {
  test("applies every flagged record and isolates a single failure from the rest", async () => {
    const goodClient = makeClient((sql) => {
      if (sql === "BEGIN" || sql === "COMMIT") return Promise.resolve();
      if (sql.includes("FOR UPDATE") && sql.includes("projects")) {
        return queryResult([{ id: "project-good", raised_xlm: "200.0000000" }]);
      }
      if (sql.includes("event_stream") && sql.includes("projectId")) {
        return queryResult([{ event_type: "DonationRecorded", payload: { data: { amountXlm: 100, currency: "XLM" } } }]);
      }
      if (sql.startsWith("UPDATE projects")) return queryResult([]);
      return Promise.reject(new Error(`Unexpected query: ${sql}`));
    });
    const badClient = makeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return Promise.resolve();
      if (sql.includes("FOR UPDATE") && sql.includes("projects")) {
        return queryResult([{ id: "project-bad", raised_xlm: "200.0000000" }]);
      }
      if (sql.includes("event_stream") && sql.includes("projectId")) {
        return queryResult([{ event_type: "DonationRecorded", payload: { data: { amountXlm: 100, currency: "XLM" } } }]);
      }
      if (sql.startsWith("UPDATE projects")) return Promise.reject(new Error("deadlock"));
      return Promise.reject(new Error(`Unexpected query: ${sql}`));
    });
    const donorClient = makeClient((sql) => {
      if (sql === "BEGIN" || sql === "COMMIT") return Promise.resolve();
      if (sql.includes("FOR UPDATE") && sql.includes("donor_stats")) {
        return queryResult([{ public_key: "donor-1", total_donated_xlm: "50.0000000" }]);
      }
      if (sql.includes("event_stream") && sql.includes("donorAddress")) {
        return queryResult([{ event_type: "DonationRecorded", payload: { data: { amountXlm: 25, currency: "XLM" } } }]);
      }
      if (sql.startsWith("UPDATE donor_stats")) return queryResult([]);
      return Promise.reject(new Error(`Unexpected query: ${sql}`));
    });

    let call = 0;
    pool.connect = jest.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(goodClient);
      if (call === 2) return Promise.resolve(badClient);
      return Promise.resolve(donorClient);
    });

    const dryRunReport = {
      projects: [{ projectId: "project-good" }, { projectId: "project-bad" }],
      donors: [{ donorAddress: "donor-1" }],
    };

    const result = await applyCorrections(pool, dryRunReport);

    expect(result.projects.find((r) => r.projectId === "project-good")).toEqual(
      expect.objectContaining({ applied: true })
    );
    expect(result.projects.find((r) => r.projectId === "project-bad")).toEqual(
      expect.objectContaining({ applied: false, reason: "error", error: "deadlock" })
    );
    expect(result.donors[0]).toEqual(expect.objectContaining({ applied: true }));
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].projectId).toBe("project-bad");
  });
});
