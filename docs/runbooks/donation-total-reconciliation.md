# Runbook: Reconcile inflated donation totals (historical double-counting)

**Severity:** High — displayed amounts raised, donor leaderboards, and
goal-completion state can be wrong.

**Owner:** Backend on call.

## Summary

Before the write-path fix in `backend/src/eventSourcing/commandBus.js`, every
donation was counted twice toward `projects.raised_xlm` and
`donor_stats.total_donated_xlm`: once synchronously by the command handler,
and again by the async projection dispatch in
`backend/src/eventSourcing/projections.js`, which is now the sole writer of
those totals. The write path is fixed, but rows written while the bug was
live are still inflated. `event_stream` is the authoritative record of every
donation event, so correct totals can be recomputed from it.

The reconciliation tool is `backend/src/scripts/reconcile-donation-totals.js`.

## 1. Dry run (always do this first)

```bash
cd backend
node src/scripts/reconcile-donation-totals.js
```

This reads `event_stream` and the current read-model rows and prints every
project/donor whose persisted total differs from the recomputed one, plus any
project whose goal appears reached only because of the inflation. It performs
**zero writes** — safe to run at any time, including in production, against
live traffic.

## 2. Review the report

- Confirm the flagged diffs look like the expected inflation pattern (roughly
  double the correct total for donations recorded while the bug was live).
- Check the `goal-state` section for any project whose goal was reached only
  in the persisted (inflated) total. For each, review whether it has
  milestones already marked `reached_at` (listed in the report) — those
  reflect real, already-confirmed on-chain actions and are informational
  only; this tool does not touch them.

## 3. Apply corrections

```bash
node src/scripts/reconcile-donation-totals.js --apply
```

Each flagged project or donor is corrected independently, inside its own
transaction: the row is locked (`SELECT ... FOR UPDATE`), the total is
recomputed from `event_stream` at that point, and the row is updated only if
it still differs. Concurrent live donations are safe: a project or donor row
being corrected blocks the projection's own update to that same row until the
correction transaction commits, so neither can be lost or double-applied;
unaffected rows are untouched throughout. Only events the projection has
already applied (`processed = true`) are counted, so a donation still
in-flight when apply runs is simply left for the normal dispatch to apply
once, rather than being raced.

Apply is **idempotent** — re-running it after a successful apply (or after a
partial failure) only touches rows that still differ; already-correct rows
are left alone. If a single record's correction fails (e.g. a transient
connection error), it is rolled back cleanly and reported; other records are
unaffected. Re-run apply to pick up anything that failed.

## 4. Goal-state policy

This tool **never** modifies `projects.status`, `project_milestones`,
escrow, or jobs. A project's derived "goal reached" flag (shown in the
`/api/projects/:id/campaigns` response) is computed live from `raised_xlm`
vs. `goal_xlm` on every read, so it corrects itself automatically once
`raised_xlm` is corrected — no further action needed for that.

Milestones (`project_milestones.reached_at`) and any resulting escrow release
are set only through an explicit, external, transaction-hash-backed action
(`POST /api/projects/:id/milestones/:milestoneId/reach`), not automatically
from `raised_xlm`. If the dry-run report flags a project as
`goalFalselyReached` **and** it has milestones already marked reached, treat
those as a real, already-fired external action: do not reverse them
automatically. Escalate to a human decision — whether to announce the
correction, and whether any already-released funds need separate handling —
rather than having this tool decide.

## References

- `backend/src/scripts/reconcile-donation-totals.js` — the tool.
- `backend/src/eventSourcing/commandBus.js` — the write-path fix (issue #368).
- `backend/src/eventSourcing/projections.js` — sole writer of `raised_xlm` / `total_donated_xlm`.
- `backend/src/db/schema.sql` — `event_stream.processed`, `projects`, `donor_stats`.
- [Runbooks index](README.md)
