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
const DLQ = "ai-summary-dlq";

let boss = null;

/**
 * Called when an AI-summary job has exhausted its retries and landed on the
 * dead-letter queue. The repo has no alerting integration (Slack/PagerDuty/
 * Sentry) yet — this is the extension point to wire one up later.
 *
 * @param {{ projectId: string, error: { name?: string, message?: string, stack?: string } }} info
 */
function notifyRepeatedFailure(info) {
  void info;
}

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

  // The DLQ must exist before the main queue is created, since pg-boss
  // validates deadLetter against a foreign key on pgboss.queue(name).
  await boss.createQueue(DLQ);
  await boss.createQueue(QUEUE, { deadLetter: DLQ });

  // pg-boss v10 always invokes work() callbacks with an array of jobs
  // (length 1 here, since batchSize defaults to 1 and isn't overridden).
  await boss.work(QUEUE, { teamSize: 2, teamConcurrency: 1 }, async ([job]) => {
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
      throw err; // pg-boss will retry according to retryLimit
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
  });

  await boss.work(DLQ, { includeMetadata: true }, async ([job]) => {
    const { projectId, ...payload } = job.data || {};
    const error = job.output || {};

    console.error(
      "[summaryQueue] AI summary job exhausted retries and was dead-lettered",
      { projectId, error: error.message },
    );

    try {
      await pool.query(
        `INSERT INTO ai_summary_job_failures (id, project_id, payload, error_message, error_stack)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuid(), projectId, JSON.stringify(payload), error.message || null, error.stack || null],
      );
    } catch (err) {
      console.error("[summaryQueue] Failed to record dead-lettered job:", err.message);
    }

    notifyRepeatedFailure({ projectId, error });
  });

  console.log("[summaryQueue] pg-boss started, worker registered on queue:", QUEUE);
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
  const jobId = await boss.send(QUEUE, { projectId, ...projectData }, { retryLimit: 3, retryDelay: 10 });
  return jobId;
}

module.exports = { start, enqueueAISummary, notifyRepeatedFailure };
