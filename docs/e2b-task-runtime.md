# Tasks without a dedicated Render service

`AGENT_TASK_DISPATCH_MODE=e2b_job` uses Vercel Workflow to launch one temporary
E2B runtime for an exact task. No Render service or Render credentials are needed
in this mode. The existing task loop, durable events, database claim fencing,
cancellation and recovery checkpoints run in that temporary runtime.

The trusted runtime is separate from the task's browser/terminal computer.
Only the trusted runtime receives database, model and provider credentials;
model-generated code executes in the task computer. This means an active task
can use two E2B sandboxes. This removes dedicated Render compute, but does not
promise a lower total bill at every traffic level. E2B runtime, Workflow and
model/search usage are still metered. Existing provider subscriptions are not
changed by this migration.

## Lifecycle and spending bounds

- No idle runtime pool, package installation or repository clone per task.
- Runtime code and production dependencies are prebuilt into a template.
- A content hash is checked against the template before execution starts.
- A created but unstarted runtime expires after 60 seconds.
- The trusted launcher grants a maximum 20-minute VM lifetime. The existing
  worker's 15-minute task deadline and cancellation hard stop still apply.
- The runtime kills itself when its one-task worker exits. Workflow cleanup
  and the provider lifetime limit are independent backstops.
- Launch reservations remain atomic and bounded. An ambiguous create is
  reconciled by exact task/queue metadata before another launch is attempted.
- The task computer keeps the existing pause-on-completion behavior, preserving
  files. The trusted runtime is killed, not paused or auto-resumed.

## Build and validate

Keep production paused, its durable intake hold active, and Render suspended.
Do not run `cloud:finish-setup` for this backend: that is the legacy Render
rollout helper and deliberately refuses `e2b_job`.

```sh
node scripts/e2b-task-runtime-smoke.mjs
node scripts/e2b-task-runtime-queue-smoke.mjs
node scripts/e2b-task-runtime-build.mjs
```

The first test uses a fake provider. The second writes and removes isolated
diagnostic queue records; it creates no provider compute or LLM calls. The build
command without `--apply` only prepares a temporary local context and prints its
hash. It uploads nothing.

```sh
node scripts/e2b-task-runtime-build.mjs --apply
```

This uploads allowlisted application source, package manifests and task scripts
to E2B to build a 1-vCPU, 2-GiB trusted runtime template. It excludes `.env`
files, git history, customer attachments, local caches and QA output. Credentials
are injected into the trusted process at launch, never into the template.
Build metadata is saved to `.agent-runtime/e2b-task-runtime-build.json`.

Set the following in the web deployment using the exact built template metadata:

```dotenv
AGENT_TASK_WORKER_MODE=external
AGENT_TASK_DISPATCH_MODE=e2b_job
AGENT_REQUIRE_TASK_WORKER_HEARTBEAT=false
E2B_TASK_RUNTIME_TEMPLATE=<template>
E2B_TASK_RUNTIME_REVISION=<revision>
```

Retain the existing Turso, OpenRouter, search and task-computer E2B settings.
`scripts/vercel-cloud-env.mjs` supports these settings when the local dispatch
mode is `e2b_job`. It does not need Render keys for this mode. Runtime-only
template/revision settings belong in server environment variables, never in
`NEXT_PUBLIC_*` settings.

Before reopening customers, deploy to an isolated preview queue and run the
signed background-worker readiness and smoke probes against that deployment.
Readiness checks provider access and configuration without creating compute;
the execution smoke verifies the actual template, task completion, viewer
reconnection, and cleanup. Also run one bounded real-agent task to validate the
model/tools inside the template. Confirm no trusted runtime remains afterward.
Only then activate the production deployment and release the existing hold.
Do not resume Render. If production was explicitly suspended, reopening still
requires the user to request resumption.

## Current migration status

The source-only E2B template has been built with user approval, and private
credential injection into the trusted runtime is approved. Hosted completion
and cancellation tests both pass, including automatic runtime termination.
Provider and isolated queue tests, TypeScript, targeted lint, and the production
build pass. The worker recognizes E2B's exact `e2b.local` hostname while retaining
its exclusions for local laptop hostnames.

Production cutover is in progress. Verify the signed deployed Workflow smoke
and real-agent tool execution before releasing the customer intake hold.
The Render worker must remain suspended with automatic deployment disabled.
