# Turso and Auth Setup

This app is ready for Turso and Auth.js, but real secrets must stay in `.env.local`.
Do not paste database tokens into chat, screenshots, source files, or `.env.example`.

## 1. Log in to Turso

The Turso CLI is installed locally. Run:

```bash
turso auth login
```

Then verify:

```bash
turso auth whoami
```

## 2. Create the database

Create a Turso database for this app:

```bash
turso db create agent --wait
```

Get the database URL:

```bash
turso db show agent --url
```

Create an application token:

```bash
turso db tokens create agent
```

## 3. Add local environment values

Generate the Auth.js secret. This writes the secret into `.env.local` for this Next.js app:

```bash
npx auth secret
```

Then add the Turso values and trust-host flag to `.env.local` only:

```bash
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your-token
AUTH_TRUST_HOST=true
```

## 4. Restart and verify

Restart the dev server after editing `.env.local`, then open:

```text
http://127.0.0.1:3000/api/db/health
```

Expected result after the database values are valid:

```json
{"ok":true,"configured":true,"rows":1}
```
