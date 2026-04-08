# Local Development with Docker

This guide covers running BizzAssist locally using Docker Compose, which starts the Next.js app alongside a local Supabase Postgres instance.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- Node.js 24.14.0 (only needed if you also run the app outside Docker)

## Setup

1. **Copy the example env file and fill in credentials:**

   ```bash
   cp .env.local.example .env.local
   ```

   At minimum, set these values for local Docker development:

   | Variable                   | Where to get it                                                                                        |
   | -------------------------- | ------------------------------------------------------------------------------------------------------ |
   | `SUPABASE_LOCAL_ANON_KEY`  | Run `supabase status` after `supabase start`, or use the default anon key from `supabase init`         |
   | `NEXT_PUBLIC_SUPABASE_URL` | Override not needed — `docker-compose.yml` sets this to `http://localhost:54321` for the `app` service |
   | All other keys             | See `.env.local.example` for instructions per service                                                  |

2. **Start the stack:**

   ```bash
   npm run docker:dev
   ```

   This runs `docker compose up`, which:
   - Builds the `app` container from `Dockerfile.dev` (Node 24 Alpine, hot-reload via volume mount)
   - Starts `supabase-db` (Postgres 15) on port `54322`
   - Mounts your local source tree into the container so code changes reload without rebuilding

3. **Access the app:**

   ```
   http://localhost:3000
   ```

4. **Stop the stack:**

   ```bash
   npm run docker:down
   ```

## Available Docker Commands

| Command                | What it does                                             |
| ---------------------- | -------------------------------------------------------- |
| `npm run docker:dev`   | Start all services (`docker compose up`)                 |
| `npm run docker:build` | Rebuild images without starting (`docker compose build`) |
| `npm run docker:down`  | Stop and remove containers                               |

## Database

The local Postgres instance (`supabase-db`) is exposed on port `54322` (not `5432`) to avoid conflicts with any locally-installed Postgres.

Connection string for a DB client (e.g. TablePlus):

```
host=localhost  port=54322  user=postgres  password=postgres  database=postgres
```

Run migrations against the local DB:

```bash
npm run db:migrate
```

## Notes

- `node_modules` and `.next` are excluded from the volume mount via anonymous volumes, so the container uses its own compiled dependencies and build cache.
- Secrets in `.env.local` are loaded into the `app` container via `env_file`. The `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` environment variables set in `docker-compose.yml` take precedence over any matching values in `.env.local` for the `app` service.
- For production builds, use `Dockerfile` (multi-stage) and the `Dockerfile.dev` is only for local development.
