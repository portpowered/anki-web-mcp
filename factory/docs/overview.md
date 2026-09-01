# Factory Overview

This factory is the facotry for the anki-web-mcp website. 

The anki-web-mcp is a github pages hosted website static next site that lets customers load stuff.

- The **ideafy** workstation is the meta-planner. It inspects live factory state, submits batches of `idea` work, records planner state, and schedules a `thoughts` loopback so planning resumes after each batch completes. 
- The **plan** workstation turns each idea into a PRD. 
- **process** and **review** executors implement and gate work in isolated worktrees.

## Read First

Before submitting work, read:

* `factory/factory.json`
* `factory/workstations/ideafy/AGENTS.md`
* `docs/temp/customer-ask.md` — current customer authorization and goals
* `docs/temp/progress.md`, `docs/temp/checklist.md`, and `docs/temp/meta.md` —
  live planner state files (local, not checked in)
* `factory/docs/batch-inputs.md`
* `factory/docs/batch-input-example.json`
* `factory/docs/decision-envelope.md`
* `you docs agents`
* `you docs batch-inputs`

Repository context that shapes planner batches:

* root `AGENTS.md` — architecture, package map, and verification expectations
* `docs/architecture/data-model.md` — public vocabulary (`Factory`, `Factory
  Session`, `Work`, `Work Request`)
* `docs/reference/` — packaged `you docs <topic>` contracts

## Planner Loop

The meta-planner operates the work queue rather than implementing every feature
directly:

1. Read the customer ask, factory state, project docs, and codebase.
2. Maintain direction in `docs/temp/*` state files.
3. Submit a batch of concrete `idea` work items.
4. Add a `thoughts` loopback item that depends on those ideas so ideafy runs
   again after the batch completes.
5. Append planner progress and update the checklist after submission.

Always dry-run a batch before real submission:

```sh
you submit batch --dry-run <path> --session <session_id>
```

Do not submit a real batch until the customer ask, checklist, and live queue
state agree the next slice of work is ready.

## Work Types

Configured work types:

```txt
thoughts       meta-planner loopback work
idea           product/implementation idea submitted by ideafy
plan           PRD planning output from an idea
task           executor/review implementation work
cron-triggers  runtime trigger type
```

Use `idea`, singular, for implementation proposals.
Use `thoughts`, plural, for ideafy loopback.

## Workstation Flow

```txt
thoughts:init -> ideafy -> thoughts:complete

idea:init -> plan -> idea:to-complete + plan:init
plan:init -> setup-workspace -> plan:complete + task:init
task:init -> process -> task:in-review
task:in-review -> review -> task:to-complete
idea:to-complete + task:to-complete with the same name -> consume
```

Executor and review workstations run in worktrees under
`.claude/worktrees/<work-item-name>/`, created by
`factory/scripts/setup-workspace.py`.

## Batch Submission

Use the canonical `FACTORY_REQUEST_BATCH` shape from `you docs batch-inputs`.
Human-readable notes live in `factory/docs/batch-inputs.md`.

For a running factory, prefer:

```sh
you submit batch <path> --session <session_id>
```

Always dry-run first:

```sh
you submit batch --dry-run <path> --session <session_id>
```

For watched-folder operator ingress, use:

```txt
factory/inputs/BATCH/default/<request_id>.json
```

The checked-in example is:

```txt
factory/docs/batch-input-example.json
```

Each batch should include several concrete `idea` items plus one `thoughts`
loopback item connected through `DEPENDS_ON` relations so the meta-planner
re-enters after the ideas complete.

## State Inspection

Before submitting new work, inspect the current queue and active sessions.

Use:

```sh
you work list --session <session_id> --max-results 400
```

to see current work items, work types, states, names, and whether previous
batches are still running, blocked, failed, or ready to be consumed.

Use:

```sh
you session list
```

to enumerate active and recent factory sessions. Check both commands before
deciding that work is stuck or before submitting a new batch. Session list
answers whether the runtime is alive; work list answers what the queue is doing
inside a session.

Run these commands from this repository’s default factory context. Do not
hard-code a server override; use one only when an operator explicitly supplies
a non-default runtime endpoint. `--max-results` is required because the default
page size is 50.

Replace `<session_id>` with a live id from `you session list` (for example
`c803e7f7-1361-4ba6-bb2b-b5c9cfeb2754` on a long-running host).

## Repair

Use:

```sh
you work move <work-id> <state-name> --session <session_id> --request-id <stable-repair-id>
```

only for deliberate workflow repair. Record every manual move in
`docs/temp/progress.md` with the work item, old state, new state, reason, and
expected next workstation. Do not use work moves to skip implementation,
review, or validation.

## Local State Files

Planner-owned state under `docs/temp/`:

```txt
docs/temp/customer-ask.md  current customer authorization and goals
docs/temp/progress.md      append-only meta-planner progress log
docs/temp/checklist.md     high-level customer-ask and phase tracking
docs/temp/meta.md          lightweight world-state notes for long-running passes
```

These files are local planner state. Keep them out of version control when
possible. The meta-planner creates and maintains them during planning passes.
Task executors append to the worktree `progress.txt` at the repository root
during implementation batches.

