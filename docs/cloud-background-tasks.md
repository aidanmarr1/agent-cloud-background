# Cloud Background Tasks

The primary production architecture uses a full-time Render worker:

1. Vercel serves the Next.js app and writes accepted tasks to Turso.
2. Turso stores the queue, execution leases, replayable task-stream events, conversations, and durable file metadata.
3. A continuously running Render `background_worker` polls the production queue with `npm run worker:cloud`.
4. The worker claims tasks, runs the agent, publishes live events, and stays online for the next task.

The browser is only a viewer. Closing or reconnecting the tab does not own or stop the Render worker, Turso task, or E2B sandbox.

The app also retains local development and dormant one-off execution code, but production does not configure the one-off launcher:

- Local development: leave `AGENT_TASK_WORKER_MODE` blank so `/api/chat` runs in the web process.
- On-demand execution is inactive unless `AGENT_TASK_DISPATCH_MODE=render_job` and Render launcher credentials are deliberately restored.

For Manus-style cloud computers, use E2B. Task file operations, terminal commands, and Chromium run inside an E2B microVM. The sandbox identity and durable task files are persisted so a replacement attempt can recover useful state. With the production defaults, completed sandboxes are destroyed rather than left running.

## Primary Production Services

Production needs these configured resources:

- A Vercel deployment for the web app, task acceptance, and event replay.
- Turso for the queue, leases, stream events, conversation state, and durable file metadata.
- One continuously running Render `background_worker` service with the worker image and environment.
- E2B for isolated browser, terminal, and file execution.
- OpenRouter and the configured search provider for model and research calls.

Production requires a fresh hosted-worker heartbeat before accepting a task. If the Render worker is unavailable, `/api/chat` fails closed instead of accepting work that cannot run.

The public `/api/health` endpoint is intentionally lightweight and unauthenticated. It proves only that the web deployment is alive. The signed `cloud:worker-ready` check proves the persistent worker heartbeat; `cloud:worker-smoke` verifies that the live worker can claim and complete a diagnostic job.

The repo includes these deployment helpers:

- `Dockerfile`: builds the worker-compatible application image.
- `render.yaml`: defines the always-running Render background worker.
- `render.worker.env.example`: lists the environment required by that worker.
- `e2b.Dockerfile`: builds the E2B sandbox template used for browser, terminal, and file execution.
- `docker-compose.cloud.yml`, `Procfile`, and `npm run worker:cloud`: local production-shape and worker helpers.
- `.node-version`: pins Node 22 for cloud builds.

## Cost Behavior

Provider prices change, so check each provider before launch:

- The Render background worker has a fixed continuous instance cost because it remains online and polls the queue.
- Vercel serves web requests and task/event APIs.
- E2B bills only while a task sandbox is running. Keep `AGENT_E2B_WARM_POOL_ENABLED=false`, `AGENT_E2B_PAUSE_ON_TASK_END=false`, and `AGENT_E2B_KILL_ON_RESET=true` to avoid idle warm-pool or completed-sandbox runtime.
- Turso usage grows with task state, heartbeats during active jobs, dispatch attempts, and persisted stream events.
- OpenRouter and search-provider usage grows with actual model and research calls.
- The deployed background smoke uses the already-running worker and does not call the LLM or start E2B. A real agent task can incur model, search, and E2B usage.

## Primary Production Environment

Set these values on Vercel:

```bash
TURSO_DATABASE_URL=...
TURSO_AUTH_TOKEN=...
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=qwen/qwen3.7-flash
AUTH_SECRET=...
AGENT_INTERNAL_HEALTH_SECRET=...
AGENT_TASK_WORKER_MODE=external
AGENT_TASK_QUEUE_NAME=production
AGENT_TASK_WORKER_HEARTBEAT_MS=15000
AGENT_TASK_WORKER_STALE_MS=60000
AGENT_TASK_WORKER_MAX_ATTEMPTS=3
AGENT_WORKER_HARD_TASK_EXIT_MS=930000
AGENT_WORKER_CANCEL_HARD_EXIT_MS=5000
AGENT_REQUIRE_TASK_WORKER_HEARTBEAT=true
AGENT_REQUIRE_HOSTED_TASK_WORKER=true
AGENT_DEPLOYMENT_VERSION=
AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION=false
```

The Render worker uses the values in `render.worker.env.example`, including the same Turso queue, OpenRouter/search settings, E2B settings, timeouts, and retry limits.

`AGENT_TASK_QUEUE_NAME` must match between Vercel and Render. Use different values for production and staging.

`AGENT_REQUIRE_TASK_WORKER_HEARTBEAT=true` and `AGENT_REQUIRE_HOSTED_TASK_WORKER=true` ensure production accepts work only when the full-time Render worker is alive.

To reject an old worker deployment, set the same `AGENT_DEPLOYMENT_VERSION` on Vercel and Render, then set `AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION=true`.

Do not run incompatible queue protocols concurrently. Pause intake and drain old work before any future execution-mode cutover.

The Render worker uses two isolated task processes by default:

```bash
AGENT_TASK_WORKER_CONCURRENCY=2
AGENT_TASK_WORKER_POLL_MS=100
AGENT_TASK_WORKER_HEARTBEAT_MS=15000
AGENT_TASK_WORKER_STALE_MS=60000
```

Each task process has its own fenced lease and restart boundary, so one crashed or cancelled task does not take the full-time host offline.

Keep `AGENT_E2B_WARM_POOL_ENABLED=false` by default so E2B runtime starts only when a task can be billed. If you explicitly turn warm pooling on for lower startup latency, prewarm time is an operational cost; user runtime billing starts only after a task adopts and confirms the sandbox.

`AGENT_TASK_WORKER_MAX_ATTEMPTS` caps repeated claims for a task whose worker keeps dying before completion. The default is `3`. When the next claim would exceed the cap, the job is marked terminal with a replayable error event and the user's active-task lease is released, preventing an infinite crash/retry loop and unbounded cloud spend.

`AGENT_WORKER_HARD_TASK_EXIT_MS` is the process-level backstop for SDKs or tool handlers that ignore cooperative abort signals. Keep it above the normal worker run limit plus its cleanup allowance (the default `930000` is 15 minutes plus 30 seconds). When it fires, the worker exits immediately, stops refreshing its fenced claim, and lets the persistent supervisor restart a clean process for durable recovery.

`AGENT_WORKER_CANCEL_HARD_EXIT_MS` is the shorter cancellation backstop for the dedicated worker process. After a worker observes a durable stop request it publishes a `stopping` heartbeat, stops refreshing that claim, and gives cooperative cleanup five seconds by default; if the runner is still stuck, the dedicated process exits so ignored aborts cannot continue side effects or E2B billing in the background. Values above 30 seconds are rejected. Keep `AGENT_TASK_WORKER_STALE_MS` greater than the heartbeat interval plus this hard-exit window and the 5-second proof jitter. A cross-instance cancellation remains nonterminal until the exact boot-unique worker/run heartbeat is no longer live, then destroys the sandbox before publishing the terminal event. Heartbeat staleness is the process-loss evidence available across hosts; forced recovery therefore retains an explicit warning that late external side effects could not be ruled out instead of claiming a perfectly clean stop.

In-process local tasks share the web process and never use `process.exit` for cancellation. Their owner retains and refreshes the full durable claim while cooperative abort, in-flight operations, and cleanup settle. If that web process disappears, lease-expiry recovery resets the workspace and publishes an explicitly uncertain error so the UI never claims a clean hard stop that the shared-process architecture cannot prove.

## Manus-Style E2B Sandbox

Set these values on the worker process. Set them on the web process too if the web process needs to read/list sandbox files directly.

```bash
AGENT_SANDBOX_PROVIDER=e2b
E2B_API_KEY=...
E2B_TEMPLATE_ID=agent-cloud-browser
AGENT_E2B_SANDBOX_TIMEOUT_MS=3600000
AGENT_E2B_COMMAND_TIMEOUT_MS=120000
AGENT_E2B_ALLOW_INTERNET=true
AGENT_E2B_PAUSE_ON_TASK_END=false
AGENT_E2B_KILL_ON_RESET=true
AGENT_E2B_BROWSER_PORT=9222
AGENT_E2B_BROWSER_START_TIMEOUT_MS=30000
AGENT_E2B_BROWSER_LAUNCH_TIMEOUT_MS=30000
AGENT_E2B_VERIFY_ON_WORKER_STARTUP=true
AGENT_E2B_VERIFY_BROWSER_ON_WORKER_STARTUP=true
AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND=
```

The included Render Blueprint sets `E2B_TEMPLATE_ID=agent-cloud-browser`, matching the template name built by `npm run e2b:template:build`. You can replace it with a different template ID/name if you create your own E2B template.

`E2B_TEMPLATE_ID` can stay blank to use E2B's base template, but that is only safe if the selected base template already has the tools your agent needs. For Manus-style browser work, use the included custom template or another template with Chromium installed.

When E2B is enabled:

- `getOrCreateSandboxDir()` still creates the app's local mirror directory.
- E2B is the source of truth for cloud execution and file tools.
- Generated E2B files are mirrored into the local sandbox directory so existing previews and downloads keep working.
- Completed task files are still copied into the app's durable task-file storage.
- Contextual follow-up tasks restore those durable task files into the active sandbox before the agent continues. If an E2B sandbox was recycled and a replacement is created, saved artifacts come back; temporary scratch files that were never persisted do not.
- `execute_command` becomes available to the agent and runs inside the E2B sandbox workspace.
- Browser tools start Chromium inside the E2B sandbox and connect over Chrome DevTools Protocol, so browsing/clicking/screenshot work is no longer tied to the user's tab.
- Task completion follows the configured lifecycle. Production uses `AGENT_E2B_PAUSE_ON_TASK_END=false`, and task reset uses `AGENT_E2B_KILL_ON_RESET=true`, so completed or replaced sandboxes do not remain billable in the background.

If the selected E2B template does not include Chromium, either set `E2B_TEMPLATE_ID` to a custom template with Chromium installed or provide a bootstrap command through `AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND`. A custom template is better for production because installing Chromium at task runtime is slower and increases sandbox runtime cost.

This repo includes [e2b.Dockerfile](/e2b.Dockerfile) for that custom template. It uses a Python 3.12 Debian image and installs Node 22, Java 21, Chromium, the scientific Python baseline, media/document tooling, cloud CLIs, a supervised virtual display, and the `/home/user/agent-workspaces` directory expected by the runtime. See [Agent Sandbox Runtime](./sandbox-runtime.md) for the full capability matrix, first-party `agent-*` commands, security boundaries, and provider-controlled limits.

Build it with the E2B CLI:

```bash
npm i -g @e2b/cli
e2b auth login
npm run e2b:template:build
```

For a non-interactive shell, use `E2B_ACCESS_TOKEN` for the CLI:

```bash
E2B_ACCESS_TOKEN=... npm run e2b:template:build
```

After the build finishes, keep `E2B_TEMPLATE_ID=agent-cloud-browser` if you used the included script, or set it to the template name/ID returned by E2B if you changed the template name. Keep `E2B_API_KEY` set for the app runtime; E2B distinguishes the CLI access token from the runtime API key.

To verify the E2B template before deploying, run:

```bash
npm run cloud:e2b-smoke
```

This creates a short-lived E2B sandbox, verifies the expected workspace, language runtimes, CLIs, virtual display, first-party media/document commands, Chromium, and the remote Chromium debugging endpoint, then destroys the sandbox. It does not call the LLM, but it may use a small amount of E2B runtime credit.

For production workers, keep `AGENT_E2B_VERIFY_ON_WORKER_STARTUP=true` and `AGENT_E2B_VERIFY_BROWSER_ON_WORKER_STARTUP=true`. A targeted drain delays full runtime/E2B startup until it has actually claimed a real agent task, so duplicate or already-terminal dispatches do not create a throwaway sandbox. Once claimed, verification prevents a bad E2B key, template, or Chromium endpoint from being treated as a healthy task runtime. The diagnostic `background_probe` used by `cloud:worker-smoke` intentionally bypasses the agent runtime and E2B.

## Runtime Flow

```text
Browser starts task
  -> /api/chat validates auth, credits, and task access
  -> web process starts a durable Vercel Workflow
  -> web process atomically records the coordinator, queued job, conversation placeholder,
     active-task lease, and immediate "Preparing a fresh computer…" event in Turso
  -> Workflow reserves a deterministic dispatch generation
  -> Workflow asks Render to launch one targeted one-off job from the suspended base
  -> finite worker:drain process claims only that run with a fenced lease
  -> worker runs the agent and writes sequenced SSE events to Turso as they happen
  -> browser can close/reopen and replay events by runId/seq
  -> Workflow monitors terminal/stale state, redispatching recoverable lost work when needed
  -> worker exits and Workflow completes when the task becomes terminal
```

If the browser closes, only the viewer disconnects. When the user reopens the task, the client first uses its local resume record; if that is missing, it asks `/api/chat/active` for the current server-side run ID. That endpoint checks durable queued/running jobs first, so it still works if the browser closed before Render launched or before the one-off worker claimed the task. New `/api/chat` starts check durable work for the same conversation before accepting a second run. This preserves concurrent work across different conversations while preventing two runs from mutating one conversation's sandbox, files, and directives.

The dispatch table uses reservation tokens and deterministic generation IDs so Vercel Workflow retries cannot create an unbounded fan-out of jobs. A duplicate one-off exits if another live worker owns the exact run. A crashed one-off stops refreshing its lease; after the fenced stale window, the Workflow can launch a replacement generation. Provider/network/database failures are retried as infrastructure failures, while a permanent Render rejection becomes a replayable terminal task error instead of leaving the UI spinning forever.

With E2B enabled, the claimed worker connects or creates the task's cloud sandbox before the agent loop starts. If a replacement generation runs, it reconnects to the persisted E2B sandbox ID from Turso; if E2B can no longer resume that sandbox, a replacement sandbox is created and durable task files are restored before contextual work continues.

E2B runtime billing is durable and attempt-scoped. A billing segment is activated only after the sandbox and remote browser are confirmed, then checkpointed while the task runs. Each checkpoint advances the segment, debits the account, and inserts its ledger event in one Turso write transaction. Cleanup records the exact provider sandbox ID and lifecycle generation it fenced, confirms that provider instance has stopped, and closes only segments owned by that exact generation. A worker crash therefore does not depend on its `finally` block: stale-task, cancellation, reset, or destroy recovery settles the interrupted segment without double charging a retried checkpoint.

There is one unavoidable provider-discovery boundary: if the process dies after E2B creates a provider sandbox but before its ID is durably committed, or after browser confirmation but before the billing segment transaction commits, the app has no durable provider identity/segment to reconcile. The sandbox's configured E2B timeout still limits that orphan's provider cost, but the app cannot attribute that narrow window without an E2B account-level sandbox enumeration/reconciliation API. Keep the timeout bounded and monitor provider-side usage for these rare creation-window orphans.

## Render-First Deployment Order

Never activate a Vercel deployment that can dispatch `render_job` tasks until the compatible exact-run worker image is available on Render. Otherwise, a newly accepted task can launch paid one-off compute from stale code that cannot claim or complete the new protocol.

1. Create the E2B, Turso, OpenRouter, and Render resources. Copy `E2B_API_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `OPENROUTER_API_KEY`, `RENDER_API_KEY`, and the Render background-worker service ID into the private local deployment environment.
2. Generate `AUTH_SECRET` and `AGENT_INTERNAL_HEALTH_SECRET` with `npm run cloud:secrets`. Keep the internal health secret locally so the signed readiness and smoke commands can authenticate without exposing an endpoint publicly.
3. Build `agent-cloud-browser` with `npm run e2b:template:build`. Non-interactive builds require `E2B_ACCESS_TOKEN`. Optionally run the paid `npm run cloud:e2b-smoke` before production.
4. Make sure the deployed web code exposes the signed `taskIntake` readiness contract before the first suspended-base rollout. During the one-time bootstrap, deploy this hold-aware code while retaining the existing fail-closed persistent-worker environment; do **not** activate `AGENT_TASK_DISPATCH_MODE=render_job` yet. The guarded helper refuses to resume Render if the deployed app cannot acknowledge its exact durable hold ID.
5. **Before pushing any new commit**, disable and independently verify repository-triggered deploys on the already-suspended Render base:

   ```bash
   npm run cloud:render-worker-env -- \
     --apply --disable-auto-deploy \
     --service-id srv-...
   ```

   This path refuses a running service, patches `autoDeploy: no`, re-reads the service, verifies both `autoDeploy=no` and `suspended`, and exits without changing environment values, deploying, or resuming. This pre-push step matters for an existing service that was originally created with auto-deploy enabled; otherwise the Git push itself could expose an unguarded worker build. The guarded deploy repeats the same auto-deploy check.
6. Commit and push the exact worker source, then run the guarded suspended-base deployment. It acquires its owner-fenced hold on the stable queue base (for example, `production`) so the same hold survives a protocol change from one `:orchestration-vN` suffix to the next. The signed deployed endpoint must still report and acknowledge the exact currently active queue. The helper then requires two stable empty snapshots across jobs, live `render-one-off` dispatches, active-task leases, and fresh worker heartbeats for the base queue plus every versioned orchestration namespace. Historical `vercel-workflow` coordinator rows do not represent active Render compute and are deliberately excluded from this drain count.
7. The helper applies `render.worker.env.example`, temporarily resumes only a base that was already suspended, requests a deploy pinned to the full Git commit, waits for `live`, and always attempts to suspend and verify the base in `finally`. Cleanup retries the bounded suspend-and-verify sequence up to three times before reporting failure. It then re-reads the service and deploy, proving suspension, `autoDeploy=no`, and exact commit identity. Every Render API/readiness fetch has one bounded deadline covering both response headers and body. `SIGINT` or `SIGTERM` aborts the active request, then flows through the same suspend-and-verify cleanup; interruption never releases the intake hold. Any failed or ambiguous rollout also keeps intake held and never reports success based only on a trigger response.
8. Apply the primary Vercel values, including `AGENT_TASK_DISPATCH_MODE=render_job`, `AGENT_REQUIRE_TASK_WORKER_HEARTBEAT=false`, the Render API/service/plan IDs, and the matching Turso queue. Then deploy Vercel.
9. Run the signed readiness check. It must validate the Workflow coordinator, Turso, E2B configuration, Render API access, `background_worker` service type, and suspended base.
10. Run the deployed smoke. It must start a real Vercel Workflow and Render one-off diagnostic job, survive a viewer disconnect/reconnect, replay sequenced events, complete, and clean up its diagnostic rows.

The recommended orchestrator is:

```bash
npm run cloud:finish-setup -- \
  --url https://your-deployed-app.example \
  --intake-hold-id rollout-2026-07-27 \
  --write-worker-env /tmp/agent-render-worker.env
```

With `RENDER_API_KEY` present, `cloud:finish-setup` uses the guarded suspended-base path and keeps its exact intake hold active while it applies Vercel environment values and deploys Vercel. It releases the hold only after the signed task-executor readiness check and real one-off smoke pass, then runs `cloud:status` and the deployed preflight. Give the rollout an explicit unique `--intake-hold-id` so recovery is deterministic. If any step fails, the hold remains active: first prove the Render base is suspended, then rerun the full finisher with the same exact owner ID to resume safely. A different owner cannot replace the active hold. The command also prints an owner-fenced manual release command, but release is appropriate only after the suspended base and rollout outcome have been verified. If no ID is supplied, the command generates one and prints it on failure; pass that printed ID explicitly on the retry. The orchestrator invokes repository scripts through its own `process.execPath`, and resolves Vercel through `VERCEL_CLI`, a local binary, `PNPM_BIN`/bundled pnpm, or npx, so it does not require a globally installed `npm` or `vercel`.

`--write-worker-env` writes secrets only to the requested private file. Use `--build-e2b-template` with `E2B_ACCESS_TOKEN`, and `--e2b-smoke` when the paid live E2B probe is desired. Use `--create-render-worker` only when deliberately creating the missing Render base. `--render-commit-id <full-40-character-sha>` can pin an already-pushed commit explicitly; otherwise the helper requires tracked files to match `HEAD`. Reusing `--intake-hold-id` is a recovery mechanism for the same rollout, not permission to start a second concurrent rollout.

If the Render image and suspension state were verified manually, `--skip-render-env` is available, but it transfers responsibility for the Render-first guarantee to the operator. `--worker-ready-wait-ms` tunes the bounded executor-readiness wait, and `--wait-for-worker-ready` forces that wait for a manually prepared executor.

## Primary Readiness And Smoke

Use these checks after the Render-first deployment:

```bash
npm run cloud:status -- --url https://your-deployed-app.example
npm run cloud:worker-ready -- https://your-deployed-app.example
npm run cloud:worker-smoke -- https://your-deployed-app.example --timeout-ms=180000
npm run cloud:preflight -- --deployed-only --url https://your-deployed-app.example
```

- `/api/health` proves only that the web deployment responds. It does not prove that a task can execute.
- `cloud:worker-ready` is a signed, non-dispatching check. In `render_job` mode it verifies external queue mode, Workflow/coordinator configuration, Turso connectivity, E2B browser configuration, Render API access, the Render `background_worker` service type, and that the base is suspended.
- A healthy on-demand readiness response intentionally reports `liveWorkerHeartbeat=false`, `liveCloudWorkerHeartbeat=false`, and an empty `workers` array. No worker exists while idle, so those values are evidence of scale-to-zero behavior, not a readiness failure.
- `cloud:worker-smoke` starts a real Workflow and real targeted Render one-off job. Its `background_probe` does not call the LLM or start E2B, but the short Render/Workflow execution can still incur provider usage. The probe disconnects and reconnects its viewer, verifies `afterSeq` replay and terminal completion, then cleans up its internal diagnostic rows.
- `cloud:status` gives the shortest production-state summary. `cloud:queue -- --queue production` shows recent jobs, active-task leases, dispatch attempts, active-job heartbeats, and safe queue-scoped cleanup actions without exposing secrets.

Run signed deployed checks from a shell holding the same `AGENT_INTERNAL_HEALTH_SECRET` as Vercel. The scripts can fall back to `AUTH_SECRET`, but production should keep the internal health secret separate from the session-signing secret.

## Persistent Worker Production Mode

This is the primary production architecture.

1. Deploy or resume a compatible Render worker and start `npm run worker:cloud`.
2. Set `AGENT_TASK_DISPATCH_MODE` blank (persistent fallback), `AGENT_REQUIRE_TASK_WORKER_HEARTBEAT=true`, and the same `AGENT_TASK_QUEUE_NAME` on Vercel and the worker.
3. Wait for a compatible live heartbeat before routing new tasks.
4. Optionally set the same `AGENT_DEPLOYMENT_VERSION` on both services and enable `AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION=true` to reject stale worker releases.
5. Use `AGENT_TASK_WORKER_CONCURRENCY=2` and the documented poll/stale values unless capacity testing justifies a change.

In this fallback, `npm run cloud:check -- --live` verifies a recent persistent-worker heartbeat. With `AGENT_REQUIRE_TASK_WORKER_HEARTBEAT=true`, `/api/chat` returns `503 BACKGROUND_WORKER_UNAVAILABLE` instead of accepting work when no compatible idle worker is alive. `AGENT_REQUIRE_HOSTED_TASK_WORKER=true` can exclude a laptop heartbeat when offline-safe hosted execution is required.

The persistent worker has fixed idle compute cost because the Render service is resumed and polling. That continuous availability is intentional.

## Render Service Setup

The repo includes [render.yaml](/render.yaml), which can create:

```text
agent-web: npm start
agent-worker: npm run worker:cloud
```

For the primary Vercel architecture, only the `agent-worker` entry is needed on Render; the `agent-web` entry is an all-Render option. The worker Blueprint sets `autoDeployTrigger: off` so releases remain deliberate. Build the E2B template before creating the Blueprint, or replace `E2B_TEMPLATE_ID=agent-cloud-browser` with an existing compatible template. Fill in the worker secrets and keep `agent-worker` resumed.

Use [render.worker.env.example](/render.worker.env.example) as the environment contract inherited by every one-off job. It must contain the same `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `OPENROUTER_API_KEY`, `AGENT_TASK_QUEUE_NAME=production`, `AGENT_SANDBOX_PROVIDER=e2b`, `E2B_API_KEY`, and `E2B_TEMPLATE_ID=agent-cloud-browser` expected by Vercel. Keep `AGENT_E2B_VERIFY_ON_WORKER_STARTUP=true` and `AGENT_E2B_VERIFY_BROWSER_ON_WORKER_STARTUP=true`.

The base service start command remains `npm run worker:cloud` so the same service can support the persistent rollback. A Render one-off launch overrides it with `npm run worker:drain -- --run-id <run-id>`; do not change the base start command to a hard-coded task ID.

If you have a Render API key, the worker env handoff can be applied without manually pasting each value. A suspended base must use the guarded path:

```bash
RENDER_API_KEY=... npm run cloud:render-worker-env -- \
  --apply \
  --trigger-deploy \
  --wait-for-deploy \
  --safe-suspended-deploy \
  --intake-hold-url https://your-deployed-app.example
```

The command discovers the `agent-worker` background worker by name. If the account has multiple matches, pass `--service-id srv_...`. It updates only the expected worker env vars, does not print secret values, leaves unrelated values alone, and releases its hold after the exact artifact and suspension are verified.

For a manual two-phase web rollout, supply an explicit unique `--intake-hold-id`, add `--keep-intake-held`, deploy and verify Vercel, then release only that owner:

```bash
npm run cloud:render-worker-env -- \
  --apply --trigger-deploy --wait-for-deploy \
  --safe-suspended-deploy --keep-intake-held \
  --intake-hold-id rollout-unique-id \
  --intake-hold-url https://your-deployed-app.example

# After Vercel readiness succeeds:
npm run cloud:render-worker-env -- \
  --release-intake-hold \
  --intake-hold-id rollout-unique-id \
  --intake-hold-url https://your-deployed-app.example
```

The release is compare-and-set fenced: it cannot clear a different rollout's hold. If the guarded deploy fails, leave the hold in place while checking Render. Release it only after the base is confirmed `suspended`; otherwise a persistent base could claim new production work during recovery. An unguarded `--trigger-deploy` now refuses to operate on a suspended base.

If the `agent-worker` service does not exist yet, the same command can create it, but only when you explicitly opt in:

```bash
RENDER_API_KEY=... \
RENDER_OWNER_ID=... \
RENDER_REPO_URL=https://github.com/your-org/your-repo \
npm run cloud:render-worker-env -- --apply --create-if-missing --trigger-deploy
```

This creates a Render `background_worker` named `agent-worker` on the Starter plan in Singapore, with `autoDeploy=no`, build command `npm ci && npm run build`, fallback start command `npm run worker:cloud`, Node runtime, one instance, and a 300-second shutdown delay. Override those defaults only deliberately. Because creation is a billable infrastructure change, dry runs never create the worker; `--apply --create-if-missing` is required. A newly created running service is intentionally not adopted by `--safe-suspended-deploy`; suspend and verify it first.

For Vercel-hosted web deployments, check production environment drift with:

```bash
npm run cloud:vercel-env
```

The command reads Vercel production env names, compares them with the on-demand worker/E2B settings, and intentionally does not print secret values. It is a dry run by default. To apply only fixed defaults and values already present locally while provider secrets are still missing, use:

```bash
npm run cloud:vercel-env -- --apply-available
```

Do not deploy the Vercel change after `--apply-available` until the Render-first prerequisites are complete. Once all secrets exist, `cloud:finish-setup` is safer because it enforces the intended order. To create a missing Render base as part of that command, explicitly provide the workspace and repository:

```bash
npm run cloud:finish-setup -- \
  --url https://agent1-0.vercel.app \
  --build-e2b-template \
  --e2b-smoke \
  --create-render-worker \
  --render-owner-id tea_... \
  --render-repo https://github.com/your-org/your-repo
```

After the Render image is deployed and the base is confirmed suspended, the equivalent manual Vercel steps are:

```bash
npm run cloud:vercel-env -- --apply
vercel deploy --prod --yes
```

These commands configure and redeploy only the web/Workflow side. They are safe only after the suspended Render base contains the compatible exact-run worker code and matching environment.

Before deploying, run:

```bash
npm run cloud:preflight
```

`cloud:preflight` runs the safe checks in deployment order: source contract smoke, closed-tab reconnect smoke, Render Blueprint consistency, cloud readiness, oversized event replay persistence, immediate-close task history persistence, stale-worker lease recovery, cancellation terminal-state replay, graceful-shutdown worker handoff, and the local production web+worker closed-tab smoke. Pass `--skip-build` to reuse an existing `.next` build, `--source-only` when you only want the checks that do not require Turso credentials, or `--deployed-only --url ...` after deployment when you only want to verify the live cloud app.

The equivalent individual commands are:

```bash
npm run cloud:env-smoke
npm run cloud:worker-env
npm run cloud:vercel-env
npm run cloud:render-worker-env
npm run cloud:status
npm run cloud:finish-setup
npm run cloud:e2b-smoke
npm run cloud:queue
npm run cloud:smoke
npm run cloud:reconnect-smoke
npm run cloud:event-smoke
npm run cloud:render-smoke
npm run cloud:worker-template-smoke
npm run cloud:task-start-smoke
npm run cloud:worker-lease-smoke
npm run cloud:worker-cancel-smoke
npm run cloud:worker-shutdown-smoke
npm run cloud:check
```

`cloud:env-smoke` checks that production env values are real-looking and not placeholders before you apply them, including positive integer timing and retry-cap values. `cloud:worker-env` checks the same class of mistakes in the worker image before either a targeted drain or `npm run worker:cloud` can claim tasks; it requires external mode, a non-default queue, Turso, OpenRouter, durable storage, E2B credentials, and an E2B browser runtime source. `cloud:vercel-env` checks and optionally applies Vercel values; with `--verify-values` it verifies fixed non-secret values using a private pulled-env temp file, and `--replace-drift` repairs mismatches. `cloud:render-worker-env` checks and optionally applies the Render base environment, triggers the worker-image deploy, and can wait for that deploy to become live. `cloud:status` is the shortest production setup report. `cloud:finish-setup` is the post-secret Render-first finisher: it validates the environment, can write a private Render worker env file, applies and waits for the Render worker-image deploy, then applies Vercel values, deploys Vercel, waits for compatible task-executor readiness, checks production status, and runs the deployed-only preflight. `cloud:e2b-smoke` is the optional live E2B check that creates a short-lived sandbox and verifies terminal plus browser runtime. `cloud:queue` inspects the selected Turso queue and can clean terminal internal smoke jobs or release expired worker claims with explicit `--yes`.

`cloud:smoke` checks the source contract for durable background queueing, on-demand dispatch, persistent fallback guards, E2B browser/tool wiring, and documentation coverage. `cloud:reconnect-smoke` starts a background job, disconnects the first viewer stream, reconnects by `runId`, verifies later events replay by sequence, and proves a stale run cannot replay into another task. `cloud:event-smoke` writes intentionally oversized diagnostic events to an isolated queue and proves compacted tool, terminal, browser, and artifact events replay without sequence gaps. `cloud:render-smoke` checks `render.yaml` consistency, and `cloud:worker-template-smoke` checks its worker values against `render.worker.env.example`. `cloud:task-start-smoke`, `cloud:worker-lease-smoke`, `cloud:worker-cancel-smoke`, and `cloud:worker-shutdown-smoke` cover immediate-close history, stale lease recovery, cancellation terminalization, and graceful handoff. `cloud:check` validates static deployment/runtime wiring. Only `cloud:e2b-smoke` creates an E2B sandbox before the deployed smoke checks.

Useful queue inspection commands:

```bash
npm run cloud:queue -- --queue production
npm run cloud:queue -- --queue production --json
npm run cloud:queue -- --queue production --cleanup-smoke --yes
npm run cloud:queue -- --queue production --release-expired --yes
```

`--cleanup-smoke --yes` deletes only terminal diagnostic rows whose users and run IDs match the signed background-worker smoke probe. `--release-expired --yes` requeues running jobs only when their worker lease has already expired; this mirrors the worker's own stale-claim recovery and is useful after a crashed deploy leaves a job waiting for another worker.

The legacy live check combines Turso connectivity with a persistent-worker heartbeat assertion:

```bash
npm run cloud:check -- --live
```

Use it for the persistent rollback, where a missing heartbeat means `npm run worker:cloud` is not available. It is not the primary `render_job` readiness gate because a suspended base has no idle heartbeat. Use the signed `cloud:worker-ready` and `cloud:worker-smoke` checks described above for on-demand production.

For a local production-shaped run:

```bash
docker compose -f docker-compose.cloud.yml up --build
```

This compose file forces `AGENT_TASK_WORKER_MODE=external` and `AGENT_TASK_QUEUE_NAME=docker-cloud` for both services, so it exercises the real web + worker queue path without claiming jobs from the `production` queue.

## Cost Controls

Do not copy fixed dollar estimates from this document into a budget; provider prices and included quotas change. Confirm current Vercel Workflow, Render one-off, Turso, E2B, OpenRouter, and search-provider pricing before launch.

The primary topology has no intended Render idle-worker compute charge: the base stays suspended and each task pays only for its finite one-off execution. Vercel Workflow usage, Turso reads/writes, OpenRouter/search calls, and E2B runtime remain usage-based. The diagnostic deployed smoke uses Workflow and a short Render job, but deliberately avoids LLM and E2B calls.

The largest variable costs are normally model tokens, research calls, and E2B sandbox time. Keep E2B warm pooling disabled, destroy completed/reset sandboxes, bound command and task timeouts, cap claim attempts, and monitor provider dashboards. Resuming `npm run worker:cloud` for rollback changes Render back to fixed idle compute until the base is suspended again.
