/**
 * src/services/summaryQueue.js
 *
 * pg-boss job queue for async AI summary generation.
 * Keeps the HTTP request lifecycle decoupled from the Claude API call.
 */
"use strict";

const crypto = require("crypto");
const { v4: uuid } = require("uuid");
const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const { generateProjectSummary } = require("./claude");
const { logAdminAction } = require("./audit");

const QUEUE = "ai-summary";
const DEAD_LETTER_QUEUE = "ai-summary-dlq";
const RETRY_LIMIT = 3;
const RETRY_DELAY = 10;

const ALERT_WEBHOOK_URL = process.env.SUMMARY_FAILURE_ALERT_WEBHOOK_URL || "";

let boss = null;

/**
 * Start the pg-boss scheduler and register the AI-summary worker.
 * Must be called after database migrations and before the HTTP server starts
 * accepting requests.
 *
 * @param {import('socket.io').Server} io  Socket.IO server instance
 */
async function start(io) {
  const connectionString =
    process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/greenpay";

  boss = new PgBoss(connectionString);

  boss.on("error", (err) => console.error("[summaryQueue] pg-boss error:", err.message));

  await boss.start();

  // pg-boss v10 requires queues to be created before send()/work() will do
  // anything with them — createQueue() is what wires up retryLimit/retryDelay
  // and the deadLetter routing below. The dead-letter queue must be created
  // first: pg-boss's own schema has a foreign key from a queue's
  // `dead_letter` column to another queue's name, so ai-summary-dlq has to
  // exist before ai-summary can reference it.
  await boss.createQueue(DEAD_LETTER_QUEUE);
  await boss.createQueue(QUEUE, { retryLimit: RETRY_LIMIT, retryDelay: RETRY_DELAY, deadLetter: DEAD_LETTER_QUEUE });

  await boss.work(QUEUE, { teamSize: 2, teamConcurrency: 1 }, handleSummaryJob(io));
  await boss.work(DEAD_LETTER_QUEUE, { includeMetadata: true }, handlePermanentFailure);

  console.log("[summaryQueue] pg-boss started, worker registered on queue:", QUEUE);
}

function handleSummaryJob(io) {
  // pg-boss v10 always invokes a work() callback with an array of jobs (the
  // fetched batch), even when exactly one job was fetched — never a bare job.
  return async (jobs) => {
    for (const job of jobs) {
      await processSummaryJob(io, job);
    }
  };
}

async function processSummaryJob(io, job) {
  const { projectId, name, category, description, adminAddress } = job.data;

  let summaryResult;
  try {
    summaryResult = await generateProjectSummary({ name, category, description });
  } catch (err) {
    if (err.code === "MISSING_API_KEY") {
      // Permanent misconfiguration — log and give up without retrying.
      console.error("[summaryQueue] ANTHROPIC_API_KEY not set; skipping job", projectId);
      return;
    }
    throw err; // pg-boss will retry according to retryLimit, then dead-letter
  }

  const sourceHash = crypto
    .createHash("sha256")
    .update(description || "")
    .digest("hex");

  const updated = await pool.query(
    `UPDATE projects
        SET ai_summary              = $1,
            ai_summary_generated_at = NOW(),
            ai_summary_model        = $2,
            ai_summary_source_hash  = $3,
            updated_at              = NOW()
      WHERE id = $4
      RETURNING ai_summary, ai_summary_generated_at, ai_summary_model`,
    [summaryResult.summary, summaryResult.model, sourceHash, projectId],
  );

  const row = updated.rows[0];
  if (!row) return; // project was deleted while job was queued

  if (io) {
    io.emit("ai_summary_ready", {
      projectId,
      aiSummary:            row.ai_summary,
      aiSummaryGeneratedAt: new Date(row.ai_summary_generated_at).toISOString(),
      aiSummaryModel:       row.ai_summary_model,
    });
  }

  logAdminAction({
    actor: adminAddress || "system",
    action: "project.summary.generated",
    targetType: "project",
    targetId: projectId,
    metadata: { model: summaryResult.model },
    ipAddress: null,
  });
}

/**
 * Runs once a summary-generation job has exhausted RETRY_LIMIT attempts and
 * pg-boss has routed it to the dead-letter queue. Records the failure where
 * project admins can see it, logs it distinctly from a normal in-progress
 * retry, and fires the alerting hook.
 */
async function handlePermanentFailure(jobs) {
  for (const job of jobs) {
    await recordPermanentFailure(job);
  }
}

async function recordPermanentFailure(job) {
  const { projectId, ...payload } = job.data || {};
  const error = job.output || {};

  console.error(
    "[summaryQueue] job permanently failed after exhausting retries:",
    projectId,
    error.message || "unknown error",
  );

  try {
    await pool.query(
      `INSERT INTO ai_summary_job_failures (id, project_id, payload, error_message, error_stack)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuid(), projectId, JSON.stringify(payload), error.message || null, error.stack || null],
    );
  } catch (err) {
    console.error("[summaryQueue] failed to record permanent job failure:", err.message);
  }

  await module.exports.notifyRepeatedFailure({
    projectId,
    errorMessage: error.message || "unknown error",
    retryLimit: RETRY_LIMIT,
  });
}

/**
 * Alerting hook for a summary-generation job that has permanently failed
 * (i.e. failed repeatedly, exhausting every retry). No third-party alerting
 * provider exists in this codebase today, so this posts to a generic webhook
 * when one is configured (mirroring the RESEND_API_KEY-gated pattern in
 * services/email.js) and otherwise just logs — a clear extension point for
 * whichever alerting provider is wired up later.
 */
async function notifyRepeatedFailure({ projectId, errorMessage, retryLimit }) {
  if (!ALERT_WEBHOOK_URL) {
    console.warn("[summaryQueue] SUMMARY_FAILURE_ALERT_WEBHOOK_URL not set — skipping alert");
    return;
  }

  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "ai_summary_generation_permanently_failed",
        projectId,
        errorMessage,
        retryLimit,
      }),
    });
  } catch (err) {
    console.error("[summaryQueue] failed to deliver failure alert:", err.message);
  }
}

/**
 * Enqueue an AI summary generation job.
 *
 * @param {string} projectId
 * @param {{ name: string, category: string, description: string, adminAddress?: string }} projectData
 * @returns {Promise<string>} job ID
 */
async function enqueueAISummary(projectId, projectData) {
  if (!boss) {
    throw new Error("summaryQueue not started — call start(io) first");
  }
  const jobId = await boss.send(
    QUEUE,
    { projectId, ...projectData },
    { retryLimit: RETRY_LIMIT, retryDelay: RETRY_DELAY, deadLetter: DEAD_LETTER_QUEUE },
  );
  return jobId;
}

module.exports = { start, enqueueAISummary, notifyRepeatedFailure };
