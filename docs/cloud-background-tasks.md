# Cloud Background Tasks

The app supports two task execution modes:

1. Default local mode: `/api/chat` starts the task inside the web server process.
2. External worker mode: `/api/chat` enqueues the task in Turso, and a separate worker process claims and runs it.

Use external worker mode when tasks must keep running after the user closes the website or disconnects the browser tab.

For Manus-style cloud computers, enable the optional E2B sandbox provider as well. In that mode, task file operations and terminal commands run inside E2B cloud microVM sandboxes, the sandbox ID is persisted in Turso, and the sandbox is paused after the task ends to reduce runtime cost.

## Required Services

Run two cloud processes from the same repo:

```bash
npm start
npm run worker:cloud
```

The web process serves Next.js. The cloud worker entrypoint runs `cloud:worker-env` first, then starts `scripts/task-worker.mjs`, claims queued jobs from Turso, executes the agent loop, and writes stream events/results back to Turso.

The public `/api/health` endpoint is intentionally lightweight and unauthenticated so cloud hosts can verify the web process is alive. It does not prove the worker is running; use `cloud:worker-ready` and `cloud:worker-smoke` for that.

The repo includes these deployment helpers:

- `Dockerfile`: builds one image that can run either `npm start` or `npm run worker:cloud`.
- `Procfile`: declares `web` and a guarded `worker` process type for hosts that support Procfile-style apps.
- `render.yaml`: declares a Render Blueprint with one Starter web service and one Starter background worker.
- `render.worker.env.example`: lists the exact env names and fixed values required by the long-running worker host.
- `docker-compose.cloud.yml`: runs the production-shaped web + worker pair locally with `.env.local`.
- `e2b.Dockerfile`: builds the E2B sandbox template used for Manus-style browser/terminal/file execution.
- `.node-version`: pins Node 22 for cloud builds.

## Cost Model

Provider prices change, so verify the linked pricing pages before launch. As of 2026-06-05, this setup has four cost centers:

- Web host: Vercel Hobby can host personal/prototype web traffic for free; Vercel Pro is $20/month plus additional usage, with $20 of included usage credit. This architecture avoids using Vercel for long-running agent execution; Vercel only serves the web app and enqueue/replay API routes.
- Long-running worker host: the included Render Blueprint uses a Starter background worker. Render lists Starter web/private/background worker instances at $7/month for 512 MB RAM and 0.5 CPU. If you put both web and worker on Render Starter, budget $14/month for compute before bandwidth or workspace plan costs.
- E2B sandboxes: E2B Hobby has no monthly base price and includes one-time $100 usage credits. E2B bills running sandboxes per second and points users to its usage calculator for exact CPU/RAM/runtime estimates. Hobby is enough to start if tasks fit within its limits; E2B Pro is $150/month plus usage when you need longer continuous runtimes, higher concurrency, or larger sandbox resources. Keep `AGENT_E2B_PAUSE_ON_TASK_END=false` and `AGENT_E2B_KILL_ON_RESET=true` so completed tasks are destroyed and new tasks start fresh.
- Durable queue/storage: Turso Free includes 5 GB storage, 500M rows read/month, and 10M rows written/month. The Developer plan is $4.99/month if you outgrow Free.
- Model calls: OpenRouter is pay-as-you-go by model. Input/output token prices come from the selected model catalog entry, and streaming is still billed by token.

Practical baseline for your current Vercel-web plus Render-worker setup:

```text
Prototype/personal: Vercel Hobby $0 + Render Starter worker $7/mo + Turso Free $0 + E2B usage + OpenRouter tokens
Production/commercial: Vercel Pro $20/mo + Render Starter worker $7/mo + Turso Free/Developer + E2B usage + OpenRouter tokens
```

The E2B startup verification flags create and destroy a short-lived sandbox whenever the worker starts or redeploys. That spends a small amount of E2B runtime, but it prevents a broken E2B key or template from making the worker look healthy and then failing real user tasks.

## Required Environment

Set these values on both the web process and the worker process:

```bash
TURSO_DATABASE_URL=...
TURSO_AUTH_TOKEN=...
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=google/gemini-3.1-flash-lite
OPENROUTER_REASONING_EFFORT=minimal
OPENROUTER_REASONING_EXCLUDE=true
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_REASONING_EFFORT=high
AUTH_SECRET=...
AGENT_INTERNAL_HEALTH_SECRET=...
AGENT_TASK_WORKER_MODE=external
AGENT_TASK_QUEUE_NAME=production
AGENT_TASK_WORKER_HEARTBEAT_MS=15000
AGENT_TASK_WORKER_STALE_MS=60000
AGENT_TASK_WORKER_MAX_ATTEMPTS=3
AGENT_REQUIRE_TASK_WORKER_HEARTBEAT=true
AGENT_REQUIRE_HOSTED_TASK_WORKER=true
AGENT_DEPLOYMENT_VERSION=
AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION=false
```

`AGENT_TASK_QUEUE_NAME` must match between the web process and its worker process. Use different values for production, staging, and local workers when they share the same Turso database, so a local or preview worker cannot claim production jobs, satisfy the production worker heartbeat guard, or collide with production active-task leases. Keep `AGENT_REQUIRE_HOSTED_TASK_WORKER=true` on deployed web hosts so a local laptop worker can never satisfy production readiness.

If you want the web service to reject stale workers from an older deployment, set the same `AGENT_DEPLOYMENT_VERSION` on the web and worker services, then set `AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION=true` on the web service. Use a release id, git SHA, or deployment label that you update when both services are redeployed. With that flag enabled, `/api/chat`, `cloud:worker-ready`, and `cloud:worker-smoke` accept only workers heartbeating the matching version.

Optional worker tuning:

```bash
AGENT_TASK_WORKER_ID=production-worker-1
AGENT_TASK_WORKER_POLL_MS=100
```

If you set `AGENT_TASK_WORKER_ID` manually, keep it unique per queue. Leaving it blank is fine; the worker generates a unique ID at startup.

Keep `AGENT_E2B_WARM_POOL_ENABLED=false` by default so E2B runtime starts only when a task can be billed. If you explicitly turn warm pooling on for lower startup latency, the next task that adopts the warm sandbox is charged from the sandbox's original start time.

`AGENT_TASK_WORKER_MAX_ATTEMPTS` caps repeated claims for a task whose worker keeps dying before completion. The default is `3`. When the next claim would exceed the cap, the job is marked terminal with a replayable error event and the user's active-task lease is released, preventing an infinite crash/retry loop and unbounded cloud spend.

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
- Task completion calls E2B pause by default so the sandbox can sleep until the user returns.

If the selected E2B template does not include Chromium, either set `E2B_TEMPLATE_ID` to a custom template with Chromium installed or provide a bootstrap command through `AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND`. A custom template is better for production because installing Chromium at task runtime is slower and increases sandbox runtime cost.

This repo includes [e2b.Dockerfile](/e2b.Dockerfile) for that custom template. It uses a Debian-based Node image and installs Chromium, Python, Git, curl, build tools, fonts, and the `/home/user/agent-workspaces` directory expected by the runtime.

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

This creates a short-lived E2B sandbox, verifies the expected workspace, Node, Python, Git, curl, Chromium, and the remote Chromium debugging endpoint, then destroys the sandbox. It does not call the LLM, but it may use a small amount of E2B runtime credit.

For production workers, keep `AGENT_E2B_VERIFY_ON_WORKER_STARTUP=true`. The guarded worker startup creates and destroys a short-lived E2B sandbox before the first worker heartbeat, so an invalid `E2B_API_KEY` or bad template fails before the web app sees the worker as live. Keep `AGENT_E2B_VERIFY_BROWSER_ON_WORKER_STARTUP=true` when browser tools are required; this also verifies the Chromium debugging endpoint before the worker can claim jobs. These checks spend a small amount of E2B runtime on worker deploy/restart, not per task.

## Runtime Flow

```text
Browser starts task
  -> /api/chat validates auth, credits, and task access
  -> web process inserts queued job in Turso
  -> worker claims queued job with a lease
  -> worker runs the agent and writes SSE events to Turso
  -> browser can close/reopen and replay events by runId/seq
  -> if local run state is gone, /api/chat/active finds the active run from durable queued/running job state
```

If the browser closes, only the viewer disconnects. The worker keeps running the task. When the user reopens the task, the client first uses its local resume record; if that is missing, it asks `/api/chat/active` for the current server-side run ID. That endpoint checks durable queued/running jobs first, so it still works if the browser closed before a worker claimed the job or if the short active-task lease expired. New `/api/chat` starts also check durable queued/running jobs before accepting work, so an expired active-task lease does not allow a second background task to start while the first is still queued or running. The client then reconnects to `/api/chat?runId=...`. If the worker crashes, stale running jobs are returned to the queue after their lease expires. If the cloud host sends SIGTERM during a deploy or restart, the worker releases its current claim back to the queue immediately so a replacement worker can reclaim it without waiting for the lease timeout.

With E2B enabled, the worker also connects or creates the task's cloud sandbox before the agent loop starts. If the worker restarts, it reconnects to the persisted E2B sandbox ID from Turso; if E2B can no longer resume that sandbox, a replacement sandbox is created and durable task files are restored from object storage before contextual work continues.

## What You Need To Do

1. Create an E2B account and copy an `E2B_API_KEY`.
2. Create or reuse a Turso database and copy `TURSO_DATABASE_URL` plus `TURSO_AUTH_TOKEN`.
3. Add billing or credits to OpenRouter and copy `OPENROUTER_API_KEY`.
4. Generate `AUTH_SECRET` and `AGENT_INTERNAL_HEALTH_SECRET` with `npm run cloud:secrets`.
5. Keep the printed `AGENT_INTERNAL_HEALTH_SECRET` available locally for the deployed readiness/smoke commands.
6. Build the E2B browser template with `npm run e2b:template:build`.
7. Deploy the Next.js web process with `npm start`.
8. Deploy a separate worker process with `npm run worker:cloud`.
9. Put the same Turso, OpenRouter, auth, storage, queue, and E2B env vars on both services.
10. Set `AGENT_TASK_WORKER_MODE=external`.
11. Set `AGENT_TASK_QUEUE_NAME=production` on both services.
12. Set `AGENT_SANDBOX_PROVIDER=e2b`.
13. Start with `AGENT_E2B_PAUSE_ON_TASK_END=false` and `AGENT_E2B_KILL_ON_RESET=true` so finished sandboxes are destroyed instead of reused.
14. Run `npm run cloud:env-smoke` before copying values into Render. It catches dummy keys, placeholder URLs, the default queue name, and missing production-only settings.
15. Run `npm run cloud:worker-env` on the worker host before starting `npm run worker:cloud`. It must pass before the worker can safely claim cloud tasks.
16. If the web process is on Vercel, run `npm run cloud:vercel-env` to compare Vercel production env names against the required cloud-worker/E2B settings. It does not print secret values. Use `npm run cloud:vercel-env -- --verify-values` when you also want to compare fixed non-secret values; it pulls Vercel env into a private temp file, reports only matching/mismatching names, then deletes the temp file. After local secret values exist, run `npm run cloud:vercel-env -- --apply --verify-values --replace-drift`, then redeploy Vercel.
17. After `E2B_API_KEY` exists in `.env.local`, run `npm run cloud:finish-setup -- --url https://your-deployed-app.example --write-worker-env /tmp/agent-render-worker.env`. This validates the local cloud env, writes a private Render worker env file, applies Vercel production env, redeploys Vercel, checks production status, and runs the deployed preflight. If `RENDER_API_KEY` is also set locally, it applies the worker env directly through the Render API, triggers an `agent-worker` deploy, and waits for the signed production readiness endpoint to report a live compatible worker heartbeat before running the final status/preflight. Add `--build-e2b-template` after setting `E2B_ACCESS_TOKEN` if you want the command to build `agent-cloud-browser` first. Add `--e2b-smoke` if you also want the paid live E2B sandbox probe in the same command.
18. Run `npm run cloud:status -- --url https://your-deployed-app.example` whenever you want the shortest current-state report. It checks local prerequisites, Vercel env names, and the signed live worker readiness endpoint without printing secrets.
19. Run `npm run cloud:e2b-smoke` once after building the E2B template. It spends E2B runtime, so it is optional but strongly recommended before production.
20. Run `npm run cloud:check -- --live` after deployment and confirm the worker heartbeat passes.
21. Run `npm run cloud:worker-ready -- https://your-deployed-app.example` and confirm the deployed web process sees the production queue, Turso, E2B, and a live worker heartbeat.
22. Run `npm run cloud:worker-smoke -- https://your-deployed-app.example` and confirm a worker claims and completes the signed probe after the first stream disconnects.
23. Use `npm run cloud:queue -- --queue production` when a deploy does not behave as expected. It shows recent jobs, worker heartbeats, active-task leases, and queue-scoped cleanup actions without exposing secrets.

The simplest deployment target is Render. This repo includes [render.yaml](/render.yaml), which creates:

```text
agent-web: npm start
agent-worker: npm run worker:cloud
```

Before creating the Render Blueprint, build the E2B template or replace `E2B_TEMPLATE_ID=agent-cloud-browser` in [render.yaml](/render.yaml) with a template that already exists in your E2B account.

Create a Render Blueprint from `render.yaml`, then fill in the secret values Render prompts for: `AUTH_SECRET`, `AGENT_INTERNAL_HEALTH_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `OPENROUTER_API_KEY`, and `E2B_API_KEY`. Use `npm run cloud:secrets` for the two generated app secrets.

For the worker service specifically, use [render.worker.env.example](/render.worker.env.example) as the copyable environment checklist. The worker must have the same `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `OPENROUTER_API_KEY`, `AGENT_TASK_QUEUE_NAME=production`, `AGENT_SANDBOX_PROVIDER=e2b`, `E2B_API_KEY`, and `E2B_TEMPLATE_ID=agent-cloud-browser` that the web service expects. Keep `AGENT_E2B_VERIFY_ON_WORKER_STARTUP=true` and `AGENT_E2B_VERIFY_BROWSER_ON_WORKER_STARTUP=true` so the worker verifies E2B before its first heartbeat. The worker start command must stay `npm run worker:cloud`; it runs `cloud:worker-env` first and exits before claiming tasks if any required worker-host value is missing.

If you have a Render API key, the worker env handoff can be applied without manually pasting each value:

```bash
RENDER_API_KEY=... npm run cloud:render-worker-env -- --apply --trigger-deploy
```

The command discovers the `agent-worker` background worker by name. If your account has multiple matching services, pass `--service-id srv_...`. It updates only the expected worker env vars one at a time through Render's service env-var API, does not print secret values, and leaves unrelated Render env vars alone.

If the `agent-worker` service does not exist yet, the same command can create it, but only when you explicitly opt in:

```bash
RENDER_API_KEY=... \
RENDER_OWNER_ID=... \
RENDER_REPO_URL=https://github.com/your-org/your-repo \
npm run cloud:render-worker-env -- --apply --create-if-missing --trigger-deploy
```

This creates a Render `background_worker` named `agent-worker` on the Starter plan in Singapore, with build command `npm ci && npm run build`, start command `npm run worker:cloud`, Node runtime, one instance, and a 300 second shutdown delay. You can override those defaults with `--plan`, `--region`, `--branch`, `--root-dir`, `--build-command`, and `--start-command`. Because this creates billable infrastructure, dry runs never create the worker; `--apply --create-if-missing` is required.

If you enable stale-worker rejection with `AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION=true`, put the same `AGENT_DEPLOYMENT_VERSION` value into the worker checklist before deploying the worker.

After the Render worker deploys, check it from your local shell:

```bash
npm run cloud:status -- --url https://your-deployed-app.example
npm run cloud:worker-ready -- https://your-deployed-app.example
```

The readiness response should show `liveWorkerHeartbeat=true`, `liveCloudWorkerHeartbeat=true`, and at least one worker row for `queueName=production`.

If the web app is deployed on Vercel, still run `npm run worker:cloud` on a separate long-running worker host. The browser can disconnect from the Vercel web process, but the durable background execution requires the worker process to stay alive somewhere else.

For Vercel-hosted web deployments, check production environment drift with:

```bash
npm run cloud:vercel-env
```

The command reads Vercel production env names, compares them to the cloud-worker/E2B settings required by this app, and intentionally does not print secret values. It is a dry run by default. To apply only fixed defaults and values already present locally while required provider secrets are still missing, use:

```bash
npm run cloud:vercel-env -- --apply-available
vercel deploy --prod --yes
```

After `E2B_API_KEY` and `AGENT_INTERNAL_HEALTH_SECRET` exist locally, use:

```bash
npm run cloud:finish-setup -- --url https://agent1-0.vercel.app --write-worker-env /tmp/agent-render-worker.env
```

That command applies Vercel env, redeploys, prints the production readiness result, and runs the deployed-only preflight. It also writes a private env file you can paste into the Render worker service, generated from [render.worker.env.example](/render.worker.env.example) so manual setup uses the same checklist as the Render API helper. Secret values are written only to the file path you request; they are not printed. If you want to build the E2B browser template during the same command, set `E2B_ACCESS_TOKEN` and add `--build-e2b-template`. If you want to run the optional paid E2B sandbox probe after the build, add `--e2b-smoke`.

When `cloud:finish-setup` triggers the Render worker path, it waits for `/api/internal/background-worker-ready` to report a live compatible worker before it runs `cloud:status` and the deployed-only preflight. The wait defaults to the command `--timeout-ms` value, polls every five seconds, and can be tuned with `--worker-ready-wait-ms` and `--worker-ready-poll-ms`. Use `--skip-worker-ready-wait` only when you want to inspect an expected failure immediately. If you configured the worker manually outside the Render API path, pass `--wait-for-worker-ready` to get the same bounded wait before final verification.

If you want `cloud:finish-setup` to create a missing Render worker too, set `RENDER_API_KEY`, then pass the Render workspace/repo details:

```bash
npm run cloud:finish-setup -- \
  --url https://agent1-0.vercel.app \
  --build-e2b-template \
  --e2b-smoke \
  --create-render-worker \
  --render-owner-id tea_... \
  --render-repo https://github.com/your-org/your-repo
```

The equivalent manual Vercel steps are:

```bash
npm run cloud:vercel-env -- --apply
vercel deploy --prod --yes
```

This only configures and redeploys the web process. You still need a separate long-running worker service, such as the guarded `agent-worker` service in [render.yaml](/render.yaml), using the same `AGENT_TASK_QUEUE_NAME`, Turso credentials, OpenRouter key, and E2B key.

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

`cloud:env-smoke` checks that production env values are real-looking and not placeholders before you paste them into Render, including positive integer worker timing and retry-cap values. `cloud:worker-env` checks the same class of mistakes on the actual worker host or container before `npm run worker:cloud` starts the raw worker; it requires external mode, a non-default queue, Turso, OpenRouter, durable storage, E2B credentials, and an E2B browser runtime source. `cloud:vercel-env` checks and optionally applies Vercel web env vars, including the same queue namespace and retry cap used by the worker; with `--verify-values` it also verifies fixed non-secret values using a private pulled-env temp file and `--replace-drift` repairs existing mismatches. `cloud:render-worker-env` checks and optionally applies Render worker env vars through the Render API, then can trigger the worker deploy. `cloud:status` is the shortest production setup report: it checks local prerequisites, Vercel production env names and fixed-value drift, and the signed deployed worker readiness endpoint, then prints the next required action without exposing secret values. `cloud:finish-setup` is the post-secret finisher: once `E2B_API_KEY` exists locally, it validates the cloud env, can write a private Render worker env file, applies Vercel production env, repairs Vercel fixed-value drift, redeploys Vercel, applies/deploys the Render worker when `RENDER_API_KEY` is present, waits for a compatible hosted worker heartbeat when it triggers that worker path, checks production status, and runs the deployed-only preflight. `cloud:e2b-smoke` is the optional live E2B check that creates a short-lived sandbox and verifies terminal plus browser runtime. `cloud:queue` inspects the Turso queue for the selected namespace and can clean terminal internal smoke jobs or release expired worker claims with explicit `--yes`. `cloud:smoke` checks the source contract for background queueing, hosted worker heartbeat enforcement, E2B browser/tool wiring, and documentation coverage. `cloud:reconnect-smoke` executes the task-job stream behavior directly: it starts a background job, disconnects the first viewer stream, reconnects by `runId`, verifies later events replay by sequence, and verifies a stale run cannot replay into another task. `cloud:event-smoke` writes intentionally oversized diagnostic events to Turso on an isolated `event-smoke-*` queue and proves compacted tool, terminal, browser, and artifact events replay without sequence gaps. `cloud:render-smoke` parses `render.yaml` and fails if the web and worker services drift on queue, storage, sandbox, model, or required secret settings. `cloud:worker-template-smoke` compares the `agent-worker` env in `render.yaml` with `render.worker.env.example`, requiring fixed values to match and Render secrets to stay blank in the checklist. `cloud:task-start-smoke` writes a diagnostic conversation row to Turso and proves a task started by `/api/chat` remains visible in account history even if the tab closes before client sync, while still allowing the richer client conversation body to replace the server placeholder later. `cloud:worker-lease-smoke` writes a diagnostic job to Turso on an isolated `lease-smoke-*` queue, lets the first worker lease expire, and proves a replacement worker can reclaim and finish the same job. `cloud:worker-cancel-smoke` writes a diagnostic job on an isolated `cancel-smoke-*` queue, simulates a dead worker that owns the job, cancels it, and proves reconnecting users receive a terminal `Task stopped` event, the active-task lease is released, and the same user can start a replacement task immediately instead of waiting on a stale running row. `cloud:worker-shutdown-smoke` writes a diagnostic job on an isolated `shutdown-smoke-*` queue, simulates SIGTERM while the first worker owns the job, and proves a replacement worker can reclaim immediately without a terminal error from the stopping worker. `cloud:check` checks the environment, package scripts, deployment files, worker queue wiring, E2B provider wiring, and whether `execute_command` is exposed in E2B mode. Only `cloud:e2b-smoke` creates an E2B sandbox before the live/deployed checks.

Useful queue inspection commands:

```bash
npm run cloud:queue -- --queue production
npm run cloud:queue -- --queue production --json
npm run cloud:queue -- --queue production --cleanup-smoke --yes
npm run cloud:queue -- --queue production --release-expired --yes
```

`--cleanup-smoke --yes` deletes only terminal diagnostic rows whose users and run IDs match the signed background-worker smoke probe. `--release-expired --yes` requeues running jobs only when their worker lease has already expired; this mirrors the worker's own stale-claim recovery and is useful after a crashed deploy leaves a job waiting for another worker.

To also test live Turso connectivity:

```bash
npm run cloud:check -- --live
```

The live check also verifies that at least one worker process has written a recent heartbeat to Turso. If it fails with no recent worker heartbeat, the web app may enqueue tasks correctly but closed-tab tasks will not actually progress until `npm run worker:cloud` is running.

To verify deployed closed-tab behavior without spending LLM or E2B credits:

```bash
npm run cloud:preflight -- --deployed-only --url https://your-deployed-app.example
```

Or run just the deployed checks:

```bash
npm run cloud:worker-ready -- https://your-deployed-app.example
npm run cloud:worker-smoke -- https://your-deployed-app.example
```

Run those commands from a shell that has the same `AGENT_INTERNAL_HEALTH_SECRET` used by the deployed web service. The scripts can fall back to `AUTH_SECRET`, but production deployments should use a separate internal health secret so smoke tests do not need your session-signing secret. The scripts sign their requests locally so the internal endpoints stay hidden from the public internet. For slow hosts, run `npm run cloud:worker-smoke -- https://your-deployed-app.example --timeout-ms=180000`.

`cloud:worker-ready` calls the signed `/api/internal/background-worker-ready` endpoint. It does not enqueue a job. It verifies the deployed web process is in external-worker mode, Turso is reachable, the queue name is visible, E2B is configured for browser/tool execution, and a recent worker heartbeat exists for the same queue.

The worker heartbeat includes its own runtime capabilities. Readiness requires an E2B-capable worker, not just any process polling Turso. A passing worker heartbeat must report `AGENT_TASK_WORKER_MODE=external`, `AGENT_SANDBOX_PROVIDER=e2b`, an `E2B_API_KEY`, and either `E2B_TEMPLATE_ID` or `AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND` on the worker host.

`cloud:worker-smoke` calls the signed `/api/internal/background-worker-smoke` endpoint. The endpoint enqueues a safe diagnostic job in Turso, verifies the server can rediscover that active run by task ID before any viewer stream state is required, opens an event stream until the worker claims it, intentionally disconnects that first viewer stream, reconnects with `afterSeq`, and waits for the same worker job to finish. A passing response proves the deployed web process, Turso queue, active-run rediscovery, live worker, persisted SSE replay, and disconnect-safe worker execution are connected. Successful smoke jobs delete their diagnostic job/event rows before returning; failed probes try to cancel and clean up before reporting the failure.

At runtime, the web process also checks this heartbeat before accepting an external-worker task. With `AGENT_REQUIRE_TASK_WORKER_HEARTBEAT=true`, a task request returns `503 BACKGROUND_WORKER_UNAVAILABLE` instead of silently queueing work when no worker is alive. With `AGENT_REQUIRE_HOSTED_TASK_WORKER=true`, deployed web hosts reject local-only worker heartbeats instead of starting tasks that will fail when your laptop disconnects. Set these to `false` only if your platform has a separate queue-triggered worker startup mechanism.

For a local production-shaped run:

```bash
docker compose -f docker-compose.cloud.yml up --build
```

This compose file forces `AGENT_TASK_WORKER_MODE=external` and `AGENT_TASK_QUEUE_NAME=docker-cloud` for both services, so it exercises the real web + worker queue path without claiming jobs from the `production` queue.

## Cost Notes

Pricing changes, so verify these before adding a payment method. As of 2026-06-05, the expected MVP cost is:

- Web and worker hosting: about $14/month on [Render](https://render.com/pricing) if you run one Starter web service and one Starter background worker. Render lists Starter compute at $7/month each. If 512 MB is too tight, two Standard services are about $50/month.
- Turso: likely $0 at low volume. [Turso's free tier](https://turso.tech/pricing) lists 5 GB storage, 500M monthly row reads, and 10M monthly row writes. Paid plans currently start at the Developer tier.
- OpenRouter/Gemini 3.1 Flash Lite: depends on model usage. The default `.env.example` model, `google/gemini-3.1-flash-lite`, is listed at $0.25 per 1M input tokens, $0.025 per 1M cache-read input tokens, and $1.50 per 1M output tokens.
- E2B: $0 base on Hobby, with a one-time $100 usage credit for new users. Pro is $150/month plus usage. E2B bills per second while a sandbox is running, and its current docs direct you to the usage calculator for exact CPU/RAM/runtime estimates.

Illustrative E2B budgeting examples at roughly $0.12 per sandbox running hour:

```text
100 tasks x 15 minutes = 25 running hours  -> about $2.93 E2B usage
300 tasks x 15 minutes = 75 running hours  -> about $8.78 E2B usage
1,000 tasks x 15 minutes = 250 running hours -> about $29.25 E2B usage
```

The expensive part is usually LLM usage plus sandbox runtime. Keep `AGENT_E2B_PAUSE_ON_TASK_END=false`, keep command timeouts bounded, and start with E2B's default CPU/RAM before paying for heavier sandbox resources.
