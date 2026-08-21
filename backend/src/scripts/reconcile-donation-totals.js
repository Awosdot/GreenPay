#!/usr/bin/env node
/**
 * src/scripts/reconcile-donation-totals.js
 *
 * Reconciliation for `projects.raised_xlm` and `donor_stats.total_donated_xlm`
 * (issue #368). Before the write-path fix in commandBus.js, every donation was
 * counted twice: once synchronously by the command handler and once more by
 * the async projection dispatch (projections.js), which is the sole intended
 * writer of these totals. Historical rows written while that bug was live are
 * still inflated; `event_stream` is the authoritative record and is replayed
 * here to recompute what each total should be.
 *
 * Usage:
 *   node src/scripts/reconcile-donation-totals.js            # dry run (default, no writes)
 *   node src/scripts/reconcile-donation-totals.js --apply    # write corrections
 *
 * Dry run reads event_stream and the current read-model rows and reports the
 * diff — it never writes. Apply re-verifies and corrects each flagged project
 * or donor inside its own transaction, holding a row lock (`FOR UPDATE`) for
 * the duration of the recompute-and-write so a concurrent projection update to
 * the same row serializes around it instead of racing it; other rows are
 * unaffected while one is locked. Only events already applied by the
 * projection (`processed = true`) are counted, so an event still in flight
 * when apply runs is simply left for the normal dispatch to apply once,
 * rather than being raced or double-applied. Apply only writes rows whose
 * computed total actually differs from the persisted one, so re-running it
 * is a no-op the second time (idempotent).
 *
 * Goal-state policy: a project whose persisted total met its goal but whose
 * reconstructed total does not is reported under `goalFalselyReached` along
 * with any of its milestones already marked `reached_at`. This script never
 * modifies `projects.status`, `project_milestones`, escrow, or jobs — those
 * may reflect real, already-fired external/on-chain actions and are not
 * safely reversible from a read-model correction. See
 * docs/runbooks/donation-total-reconciliation.md for the operational policy.
 */
"use strict";

const pool = require("../db/pool");
const { computeBadges } = require("../services/store");

const SCALE = 10000000n; // 1e7, matching NUMERIC(20,7) columns

/**
 * Convert a monetary amount (number or numeric string) into a BigInt scaled
 * by 1e7. Using BigInt for the running sum avoids the floating-point drift
 * that repeatedly adding many donation amounts as JS numbers would risk.
 */
function toScaledInt(amount) {
  if (amount === null || amount === undefined) return 0n;
  const num = typeof amount === "number" ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(num)) return 0n;
  const fixed = num.toFixed(7);
  const negative = fixed.startsWith("-");
  const [whole, frac] = fixed.replace("-", "").split(".");
  const scaled = BigInt(whole) * SCALE + BigInt(frac);
  return negative ? -scaled : scaled;
}

/** Format a SCALE-scaled BigInt back to a fixed 7-decimal string. */
function fromScaledInt(scaled) {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

function amountsEqual(a, b) {
  return toScaledInt(a) === toScaledInt(b);
}

/**
 * Recompute a project's raised_xlm from its donation-contributing events,
 * mirroring the semantics projections.js actually applies: DonationRecorded
 * and LegacyDonationMigrated events count their amountXlm when the currency
 * is XLM, and MatchApplied events count their matchAmount unconditionally.
 *
 * @param {Array<{eventType: string, data: object}>} events
 * @returns {string} fixed 7-decimal XLM amount
 */
function computeProjectRaisedXlm(events) {
  let total = 0n;
  for (const event of events) {
    const data = event.data || {};
    if (
      (event.eventType === "DonationRecorded" || event.eventType === "LegacyDonationMigrated") &&
      data.currency === "XLM"
    ) {
      total += toScaledInt(data.amountXlm);
    } else if (event.eventType === "MatchApplied") {
      total += toScaledInt(data.matchAmount);
    }
  }
  return fromScaledInt(total);
}

/**
 * Recompute a donor's total_donated_xlm from their donation-contributing
 * events. Mirrors applyDonorProjection's reachable behavior: only
 * DonationRecorded / LegacyDonationMigrated events with currency XLM count.
 * MatchApplied is intentionally excluded — the current projection never adds
 * match amounts to donor totals either (a separate, pre-existing gap, not a
 * double-count, and out of scope for #368).
 *
 * @param {Array<{eventType: string, data: object}>} events
 * @returns {string} fixed 7-decimal XLM amount
 */
function computeDonorTotalDonated(events) {
  let total = 0n;
  for (const event of events) {
    const data = event.data || {};
    if (data.currency === "XLM") {
      total += toScaledInt(data.amountXlm);
    }
  }
  return fromScaledInt(total);
}

/** A project's persisted total met its goal, but the reconstructed one does not. */
function isGoalFalselyReached({ persisted, computed, goalXlm }) {
  if (goalXlm === null || goalXlm === undefined) return false;
  const goal = toScaledInt(goalXlm);
  if (goal <= 0n) return false;
  return toScaledInt(persisted) >= goal && toScaledInt(computed) < goal;
}

function rowToEvent(row) {
  const payload = row.payload || {};
  return { eventType: row.event_type, data: payload.data || {} };
}

const PROJECT_EVENT_TYPES = ["DonationRecorded", "MatchApplied", "LegacyDonationMigrated"];
const DONOR_EVENT_TYPES = ["DonationRecorded", "LegacyDonationMigrated"];

/**
 * Read-only pass: fetch persisted totals and processed events in bulk, group
 * in memory, and diff. Performs zero writes.
 */
async function runDryRun(pool) {
  const [projectsResult, donorsResult, projectEventsResult, donorEventsResult, milestonesResult] = await Promise.all([
    pool.query("SELECT id, raised_xlm, goal_xlm FROM projects"),
    pool.query("SELECT public_key, total_donated_xlm FROM donor_stats"),
    pool.query(
      `SELECT payload->'data'->>'projectId' AS project_id, event_type, payload
       FROM event_stream
       WHERE processed = true AND event_type = ANY($1::text[])
       ORDER BY occurred_at ASC, version ASC`,
      [PROJECT_EVENT_TYPES]
    ),
    pool.query(
      `SELECT payload->'data'->>'donorAddress' AS donor_address, event_type, payload
       FROM event_stream
       WHERE processed = true AND event_type = ANY($1::text[])
       ORDER BY occurred_at ASC, version ASC`,
      [DONOR_EVENT_TYPES]
    ),
    pool.query(
      `SELECT id, project_id, title, percentage, reached_at, transaction_hash
       FROM project_milestones
       WHERE reached_at IS NOT NULL`
    ),
  ]);

  const eventsByProject = new Map();
  for (const row of projectEventsResult.rows) {
    if (!row.project_id) continue;
    const list = eventsByProject.get(row.project_id) || [];
    list.push(rowToEvent(row));
    eventsByProject.set(row.project_id, list);
  }

  const eventsByDonor = new Map();
  for (const row of donorEventsResult.rows) {
    if (!row.donor_address) continue;
    const list = eventsByDonor.get(row.donor_address) || [];
    list.push(rowToEvent(row));
    eventsByDonor.set(row.donor_address, list);
  }

  const milestonesByProject = new Map();
  for (const row of milestonesResult.rows) {
    const list = milestonesByProject.get(row.project_id) || [];
    list.push({
      id: row.id,
      title: row.title,
      percentage: row.percentage,
      reachedAt: row.reached_at,
      transactionHash: row.transaction_hash,
    });
    milestonesByProject.set(row.project_id, list);
  }

  const projects = projectsResult.rows.map((row) => {
    const persisted = row.raised_xlm;
    const computed = computeProjectRaisedXlm(eventsByProject.get(row.id) || []);
    const goalFalselyReached = isGoalFalselyReached({ persisted, computed, goalXlm: row.goal_xlm });
    return {
      projectId: row.id,
      persisted,
      computed,
      needsCorrection: !amountsEqual(persisted, computed),
      goalXlm: row.goal_xlm,
      goalFalselyReached,
      firedMilestones: goalFalselyReached ? milestonesByProject.get(row.id) || [] : [],
    };
  });

  const donors = donorsResult.rows.map((row) => {
    const persisted = row.total_donated_xlm;
    const computed = computeDonorTotalDonated(eventsByDonor.get(row.public_key) || []);
    return {
      donorAddress: row.public_key,
      persisted,
      computed,
      needsCorrection: !amountsEqual(persisted, computed),
    };
  });

  return {
    projects: projects.filter((p) => p.needsCorrection),
    donors: donors.filter((d) => d.needsCorrection),
    goalFalselyReached: projects.filter((p) => p.goalFalselyReached),
    totalsScanned: { projects: projects.length, donors: donors.length },
  };
}

/**
 * Correct a single project's raised_xlm inside its own transaction. Locks
 * the row, recomputes from processed events at that point, and only writes
 * if the value actually differs — safe to call repeatedly (idempotent) and
 * safe to call while donations continue to arrive (the lock serializes
 * against a concurrent projection update to the same row).
 */
async function reconcileProject(pool, projectId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const projectResult = await client.query(
      "SELECT id, raised_xlm FROM projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    const projectRow = projectResult.rows[0];
    if (!projectRow) {
      await client.query("ROLLBACK");
      return { projectId, applied: false, reason: "not_found" };
    }

    const eventsResult = await client.query(
      `SELECT event_type, payload FROM event_stream
       WHERE processed = true AND event_type = ANY($1::text[])
         AND payload->'data'->>'projectId' = $2
       ORDER BY occurred_at ASC, version ASC`,
      [PROJECT_EVENT_TYPES, projectId]
    );
    const computed = computeProjectRaisedXlm(eventsResult.rows.map(rowToEvent));
    const persisted = projectRow.raised_xlm;

    if (amountsEqual(persisted, computed)) {
      await client.query("COMMIT");
      return { projectId, applied: false, reason: "already_correct", persisted, computed };
    }

    await client.query(
      "UPDATE projects SET raised_xlm = $1::numeric, updated_at = NOW() WHERE id = $2",
      [computed, projectId]
    );
    await client.query("COMMIT");
    return { projectId, applied: true, persisted, computed };
  } catch (err) {
    await client.query("ROLLBACK");
    return { projectId, applied: false, reason: "error", error: err.message };
  } finally {
    client.release();
  }
}

/** Same as reconcileProject, for donor_stats.total_donated_xlm (and its derived badges). */
async function reconcileDonor(pool, donorAddress) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const donorResult = await client.query(
      "SELECT public_key, total_donated_xlm FROM donor_stats WHERE public_key = $1 FOR UPDATE",
      [donorAddress]
    );
    const donorRow = donorResult.rows[0];
    if (!donorRow) {
      await client.query("ROLLBACK");
      return { donorAddress, applied: false, reason: "not_found" };
    }

    const eventsResult = await client.query(
      `SELECT event_type, payload FROM event_stream
       WHERE processed = true AND event_type = ANY($1::text[])
         AND payload->'data'->>'donorAddress' = $2
       ORDER BY occurred_at ASC, version ASC`,
      [DONOR_EVENT_TYPES, donorAddress]
    );
    const computed = computeDonorTotalDonated(eventsResult.rows.map(rowToEvent));
    const persisted = donorRow.total_donated_xlm;

    if (amountsEqual(persisted, computed)) {
      await client.query("COMMIT");
      return { donorAddress, applied: false, reason: "already_correct", persisted, computed };
    }

    const badges = computeBadges(Number.parseFloat(computed));
    await client.query(
      "UPDATE donor_stats SET total_donated_xlm = $1::numeric, badges = $2::jsonb WHERE public_key = $3",
      [computed, JSON.stringify(badges), donorAddress]
    );
    await client.query("COMMIT");
    return { donorAddress, applied: true, persisted, computed };
  } catch (err) {
    await client.query("ROLLBACK");
    return { donorAddress, applied: false, reason: "error", error: err.message };
  } finally {
    client.release();
  }
}

/**
 * Apply corrections for every project/donor the dry-run flagged. Each record
 * is corrected in its own transaction, so a failure on one record does not
 * roll back or block corrections already committed for others; failures are
 * collected and reported so the (idempotent) apply can simply be re-run.
 */
async function applyCorrections(pool, dryRunReport) {
  const projects = [];
  for (const p of dryRunReport.projects) {
    projects.push(await reconcileProject(pool, p.projectId));
  }

  const donors = [];
  for (const d of dryRunReport.donors) {
    donors.push(await reconcileDonor(pool, d.donorAddress));
  }

  return {
    projects,
    donors,
    failures: [...projects, ...donors].filter((r) => r.reason === "error"),
  };
}

function printDryRunReport(report) {
  console.log(
    `[Reconcile] Scanned ${report.totalsScanned.projects} project(s), ${report.totalsScanned.donors} donor(s).`
  );
  console.log(`[Reconcile] ${report.projects.length} project(s) need correction:`);
  for (const p of report.projects) {
    console.log(`  project ${p.projectId}: persisted=${p.persisted} computed=${p.computed}`);
  }
  console.log(`[Reconcile] ${report.donors.length} donor(s) need correction:`);
  for (const d of report.donors) {
    console.log(`  donor ${d.donorAddress}: persisted=${d.persisted} computed=${d.computed}`);
  }
  if (report.goalFalselyReached.length > 0) {
    console.log(
      `[Reconcile] ${report.goalFalselyReached.length} project(s) show their goal as reached only because of inflation:`
    );
    for (const p of report.goalFalselyReached) {
      const milestoneNote =
        p.firedMilestones.length > 0
          ? ` — ${p.firedMilestones.length} milestone(s) already marked reached, NOT modified by this tool`
          : "";
      console.log(`  project ${p.projectId}: goalXlm=${p.goalXlm} computed=${p.computed}${milestoneNote}`);
    }
  }
}

function printApplyResult(result) {
  const appliedProjects = result.projects.filter((r) => r.applied).length;
  const appliedDonors = result.donors.filter((r) => r.applied).length;
  console.log(`[Reconcile] Applied corrections to ${appliedProjects} project(s), ${appliedDonors} donor(s).`);
  if (result.failures.length > 0) {
    console.error(`[Reconcile] ${result.failures.length} correction(s) failed and were rolled back individually:`);
    for (const f of result.failures) {
      console.error(`  ${f.projectId || f.donorAddress}: ${f.error}`);
    }
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const report = await runDryRun(pool);
  printDryRunReport(report);

  if (!apply) {
    console.log("[Reconcile] Dry run only — no writes were made. Re-run with --apply to write corrections.");
    return;
  }

  const result = await applyCorrections(pool, report);
  printApplyResult(result);
  if (result.failures.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch((err) => {
      console.error("[Reconcile] Failed:", err.message);
      process.exitCode = 1;
      return pool.end();
    });
}

module.exports = {
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
};
