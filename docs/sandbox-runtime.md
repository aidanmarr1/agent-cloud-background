# Agent Sandbox Runtime

The `agent-cloud-browser` E2B template provides a first-party, general-purpose
Linux computer for task execution. It targets the useful capabilities of the
supplied Manus environment without pretending that one cloud provider can copy
another provider's host.

## Capability profile

The image includes:

- Python 3.12 with `uv`, pip, pandas, NumPy, Matplotlib, FastAPI,
  Beautiful Soup, Playwright, OpenAI, Pydantic, Pillow, and HTTP tooling.
- Node.js 22.13.0 with npm, pnpm 11.17.0, and Yarn 1.22.22.
- Microsoft OpenJDK 21, which is an OpenJDK distribution.
- Bash, Git, GitHub CLI, curl, wget, socat, tar, gzip, zip/unzip, ffmpeg,
  ImageMagick, Tesseract, Poppler, Pandoc, Typst, D2, PlantUML, rclone,
  Google Workspace CLI (`gws`), and a MySQL-compatible command-line client.
- Chromium plus a supervised Xvfb display at `DISPLAY=:0`.
- A Vite + React + TypeScript + Tailwind starter under
  `/opt/agent/webdev/templates/web-static`.
- The task user at UID 1000 with passwordless sudo inside the isolated E2B
  microVM.

The template intentionally does not add Rust, Go, Ruby, Docker, the SQLite CLI,
or the PostgreSQL CLI. The MySQL command is Debian's compatible MariaDB-backed
client rather than Oracle's exact MySQL 8.0 build.

`gh`, `gws`, and `rclone` are installed but are not pre-authenticated. Per-user
credentials must be supplied at runtime; no account token is copied into the
shared image.

The E2B build defaults to 6 CPUs and 4096 MB RAM. Those values materially affect
E2B cost and plan eligibility; override them with `--cpu`, `--memory-mb`,
`E2B_TEMPLATE_BUILD_CPU`, or `E2B_TEMPLATE_BUILD_MEMORY_MB` when necessary.

The base filesystem is Debian 12 rather than Ubuntu 24.04. The Linux kernel,
reported CPU model, swap, and root disk capacity are provider-controlled and
cannot be made authoritative from a Dockerfile. `agent-sandbox-info --pretty`
reports the actual live values. The workspace remains
`/home/user/agent-workspaces` because that is the app's existing durable-file
contract.

## First-party commands

These commands replace the custom Manus utilities under the app's own namespace:

```bash
agent-render-diagram architecture.mmd architecture.png
agent-md-to-pdf report.md report.pdf
agent-speech-to-text recording.mp4 --output transcript.txt
agent-analyze-video demo.mp4 --output demo.analysis.md
agent-upload-file report.pdf --json
```

`agent-render-diagram` supports Mermaid, D2, PlantUML, and the first supported
diagram fence in a Markdown file. Outputs are PNG or SVG.

`agent-md-to-pdf` uses Pandoc and sandbox Chromium. It disables raw HTML and
JavaScript so an untrusted Markdown document cannot turn PDF generation into an
implicit script runner.

`agent-speech-to-text` runs locally with whisper.cpp and a bundled English base
model. It accepts audio or video because ffmpeg normalises the input first.

`agent-analyze-video` produces a bounded Markdown evidence report containing
ffprobe metadata, sampled frames, a contact sheet, OCR, and a local transcript.
When `AGENT_VISION_API_KEY` (or `OPENAI_API_KEY`) is explicitly provisioned, it
can add an OpenAI-compatible vision summary. Without a key it still produces the
local report; `--ai required` fails closed if AI analysis is mandatory.

`agent-upload-file` always stages the file under `agent-exports/`, where normal
task artifact persistence can retain it, and returns an `agent-artifact://` URI.
It returns a public URL only when the operator configures a first-party HTTPS
`AGENT_UPLOAD_ENDPOINT`; `--public` fails if that endpoint is absent. This avoids
silently sending user files to an anonymous third-party host. The runtime does
not bake credentials into the image. A bearer token can be supplied at runtime
through `AGENT_UPLOAD_TOKEN`. There is deliberately no command-line endpoint
override: task instructions cannot redirect uploads to an arbitrary host.

Use `agent-scaffold-web my-app` to copy the web starter, and
`agent-sandbox-info --pretty` to inspect the live environment.

## Build and verify

Build files are copied through the E2B SDK with only `sandbox-runtime/` as the
file context. App source, local environment files, attachments, and unrelated
workspace content are not uploaded to the template builder. The template start
command brings up Xvfb through Supervisor and waits for the display readiness
marker.

```bash
npm run sandbox:contract-smoke
npm run e2b:template:build
npm run cloud:e2b-smoke
```

The contract smoke is local and free. Template build and the live E2B smoke need
E2B credentials and can consume E2B credits. Building the source does not update
an already-published template; production receives these tools only after a
successful template rebuild under the configured `E2B_TEMPLATE_ID`.
