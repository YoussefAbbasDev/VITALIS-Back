# VITALIS — Backend

Node.js + Express API for **VITALIS**, a mission health monitoring platform for
astronauts. The API is read-only for all monitoring telemetry and provides
role-scoped decision support for admins, medical officers, and astronauts.

- **Stack:** Node.js 22, Express 5, MySQL/MariaDB (mysql2), JWT + httpOnly
  cookies, Socket.IO (local dev only), Zod validation, PDFKit reports.
- **Deploy target:** [Vercel](https://vercel.com) serverless functions
  (`app.js` is the entry point). The database must be hosted separately.

---

## 1. Local setup

```bash
npm install
cp .env.example .env      # then edit the values
npm run dev               # http://localhost:5000
```

The API refuses to start if it cannot reach the database.

### Scripts

| Script                     | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `npm run dev`              | Start with `node --watch` (HTTP + Socket.IO)          |
| `npm start`                | Start the server once                                |
| `npm run seed`             | Seed demo users and the historical dataset            |
| `npm run seed:live`        | Append fresh live telemetry rows                      |
| `npm run check:consistency`| Verify alerts match the underlying readings           |
| `npm run create-admin`     | Create an additional admin account                    |

---

## 2. Environment variables

| Variable            | Required | Default                       | Notes |
| ------------------- | -------- | ----------------------------- | ----- |
| `NODE_ENV`          | no       | `development`                 | Use `production` on Vercel. |
| `PORT`              | no       | `5000`                        | Ignored on Vercel. |
| `CLIENT_ORIGIN`     | no       | `http://localhost:5173`       | Comma-separated CORS allow-list (production + preview URLs). |
| `DB_HOST`           | yes      | `127.0.0.1`                   | Managed MySQL host. |
| `DB_PORT`           | no       | `3306`                        | |
| `DB_USER`           | yes      | `root`                        | |
| `DB_PASSWORD`       | no       | *(empty)*                     | |
| `DB_NAME`           | yes      | `vitalis`                     | Must already exist before import. |
| `DB_SSL`            | no       | `false`                       | `true` for Aiven / Railway / PlanetScale / TiDB. |
| `DB_POOL_SIZE`      | no       | `12`                          | Capped at **5** on Vercel automatically. |
| `JWT_SECRET`        | **yes**  | —                             | At least 16 chars; use a long random string. |
| `JWT_EXPIRES_IN`    | no       | `7d`                          | |
| `COOKIE_NAME`       | no       | `vitalis_token`               | |
| `COOKIE_SAMESITE`   | no       | `lax`                         | Keep `lax` when the frontend proxies `/api`. Use `none` only for direct cross-site calls. |
| `LLM_BASE_URL`      | no       | Groq OpenAI-compatible URL    | Any OpenAI-compatible endpoint. |
| `LLM_API_KEY`       | no       | *(empty)*                     | The AI assistant stays disabled until this is set. |
| `LLM_MODEL`         | no       | `openai/gpt-oss-20b`          | |
| `VERCEL`            | auto     | —                             | Injected by Vercel; enables proxy trust and the serverless pool cap. |

---

## 3. Database

`database/vitalis.sql` is a verified `mysqldump` of the live schema and demo
dataset:

- 18 tables, 36 `INSERT` statements, **no** `CREATE DATABASE` / `USE`
  statements — safe to import into any database you have already selected.
- ~22.6 MB, UTF-8 (`utf8mb4`), `--single-transaction`.
- Contains only **bcrypt hashes** for the demo accounts (password
  `Vitalis!2026`), no plaintext secrets.

Import it into a managed database:

```bash
# 1. create the database (once) in your provider's console or CLI
mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p -e \
  "CREATE DATABASE vitalis CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 2. import
mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p \
  --default-character-set=utf8mb4 vitalis < database/vitalis.sql
```

Expected row counts after import:

| Table                 | Rows    |
| --------------------- | ------- |
| `users`               | 8       |
| `readings`            | 186,668 |
| `environment_readings`| 24,198  |
| `radiation_readings`  | 4,038   |
| `alerts`              | 6       |

The dump was re-imported into a scratch schema and validated with
`npm run check:consistency` (all checks pass), so it matches the live data.

### Demo accounts

| Email                  | Role            |
| ---------------------- | --------------- |
| `admin@vitalis.dev`    | admin           |
| `medical@vitalis.dev`  | medical officer |
| `astronaut1..6@vitalis.dev` | astronaut  |

Password for all demo accounts: `Vitalis!2026`. Change or remove these before
sharing a deployment publicly.

---

## 4. Deploying to Vercel

1. Push this repository to GitHub (see below).
2. In Vercel: **Add New → Project → Import** `VITALIS-Back`.
   Framework preset: **Other**. Root directory: `./`. No build command needed —
   Vercel detects the Express default export in `app.js`.
3. Add the environment variables from the table above (at minimum
   `JWT_SECRET`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`,
   `DB_SSL=true`, `DB_POOL_SIZE=3`, `CLIENT_ORIGIN=https://<frontend-domain>`).
4. Deploy, then check `https://<backend>.vercel.app/api/health`.

### Notes for serverless

- **Socket.IO is disabled on Vercel.** `app.js` exports the Express app only;
  `src/server.js` starts the HTTP listener and Socket.IO exclusively for local
  development (`VERCEL` is unset there).
- The frontend build sets `VITE_REALTIME_ENABLED=false` and polls every 30s.
- Vercel does **not** host MySQL. Use Aiven, Railway, PlanetScale, TiDB Cloud,
  or any reachable MySQL 8 / MariaDB 10.4+ instance.
- Keep `DB_POOL_SIZE` low (3–5); each serverless instance opens its own pool.

---

## 5. Project layout

```
app.js                  Vercel entry (default-exports the Express app)
src/server.js           Local entry: HTTP listener + Socket.IO
src/create-app.js       Express app factory (middleware, routes)
src/config/env.js       Zod-validated environment
src/db/pool.js          MySQL pool (SSL, pool caps, UTC sessions)
src/routes/             auth, admin, astronauts, alerts, checkins, crew,
                        environment, notes, reports, assistant
src/services/           alerts, mission, tokens, invites, reports, ...
src/sockets/            Socket.IO realtime layer (local only)
scripts/                seed, seed-live, check-consistency, create-admin
database/vitalis.sql    Verified dump for hosting
```

## 6. API surface

All routes are under `/api`. Authentication is a JWT in an httpOnly cookie.

| Prefix            | Access                                   |
| ----------------- | ---------------------------------------- |
| `/api/auth`       | public (login, invite acceptance, me)    |
| `/api/admin`      | admin                                    |
| `/api/astronauts` | medical officer                          |
| `/api/alerts`     | role-scoped                              |
| `/api/environment`| role-scoped (read-only telemetry)        |
| `/api/checkins`   | astronaut / medical officer              |
| `/api/notes`      | role-scoped                              |
| `/api/crew`       | role-scoped                              |
| `/api/reports`    | role-scoped, PDF export                  |
| `/api/assistant`  | role-scoped, requires `LLM_API_KEY`      |

Monitoring tables are read-only for the API; role checks, alert trust/status
logic, and the database schema are unchanged by the deployment work.

---

## 7. Push this repo

```bash
git init
git add .
git commit -m "VITALIS backend: Express API with Vercel deployment config"
git branch -M main
git remote add origin https://github.com/YoussefAbbasDev/VITALIS-Back.git
git push -u origin main
```
