# Answer Generator

[中文文档](README.zh-CN.md)

Answer Generator is an admin-oriented platform for batch-generating interview reference answers, reviewing them against a custom rubric, and retrying low-scoring answers until they meet the configured passing score or hit the retry limit.

It is designed as an independent service that can run next to CiviMind on the same server.

## Features

- Create answer-generation tasks with a rubric, answer duration, passing score, and retry limit.
- Add questions manually or import `.docx` files.
- Choose ordinary Word parsing or AI-assisted parsing for irregular documents.
- Compile task rubrics into generation guidance before questions can be processed.
- Generate one answer per question, then automatically review each answer.
- Retry failed answers with review feedback until they pass or reach the configured limit.
- Track live progress, current question, elapsed time, scores, retry feedback, and final status.
- Export generated answers and review results.
- Deploy through GitHub Actions with GHCR images and a self-hosted runner.

> [!NOTE]
> If `OPENAI_API_KEY` is empty, the FastAPI service falls back to deterministic local behavior. This is useful for setup checks and UI testing, while production-quality output requires a configured OpenAI-compatible model service.

## Architecture

```mermaid
flowchart LR
  Admin["Admin Browser"] --> Web["Next.js Web + BFF"]
  Web --> Postgres[(Postgres)]
  Web --> Redis[(Redis Queue)]
  Web --> API["FastAPI AI Service"]
  Worker["BullMQ Worker"] --> Redis
  Worker --> Postgres
  Worker --> API
```

| Workspace | Purpose |
| --- | --- |
| `apps/web` | Next.js admin UI and BFF API routes |
| `apps/api` | FastAPI service for Word parsing, rubric compilation, answer generation, and review |
| `apps/worker` | BullMQ worker that processes full generation jobs asynchronously |
| `packages/db` | Drizzle schema, migrations, and Postgres client |
| `packages/shared` | Shared status helpers, retry policy, answer length estimates, and export utilities |

## Requirements

- Node.js 20+
- pnpm 10.13.1
- Python 3.12 recommended for API service development
- Docker and Docker Compose
- Postgres and Redis, either local containers or external services

## Quick Start

```bash
pnpm install
pnpm api:install
cp .env.example .env
docker compose up -d postgres redis
pnpm db:migrate
```

Start the three runtime processes:

```bash
pnpm dev
pnpm dev:api
pnpm --filter @answer-generator/worker dev
```

Open [http://localhost:3000](http://localhost:3000).

The local FastAPI service runs on [http://localhost:8001](http://localhost:8001). The local Postgres and Redis ports are `5433` and `6380`.

## Environment Variables

Local development reads `.env` from the project root.

```env
DATABASE_URL=postgres://answer_generator:answer_generator@localhost:5433/answer_generator
REDIS_URL=redis://localhost:6380
AI_SERVICE_URL=http://localhost:8001
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_TIMEOUT_SECONDS=180
```

Production deployment reads `.env.production`, normally written by GitHub Actions from the `production` environment secrets and variables.

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | Required | Postgres connection string |
| `REDIS_URL` | `redis://redis:6379` | Redis connection string |
| `AI_SERVICE_URL` | `http://api:8001` | Internal FastAPI service URL |
| `OPENAI_API_KEY` | Empty | OpenAI-compatible API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model used by the AI service |
| `OPENAI_TIMEOUT_SECONDS` | `180` | Timeout for AI service model calls |
| `WORKER_CONCURRENCY` | `1` | Number of concurrent worker jobs |
| `WEB_BIND_HOST` | `0.0.0.0` | Host binding for production web service |
| `WEB_PORT` | `3011` | Public web port in production compose |

## Commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the Next.js web app |
| `pnpm dev:api` | Start FastAPI from `apps/api/.venv` |
| `pnpm --filter @answer-generator/worker dev` | Start the BullMQ worker |
| `pnpm api:install` | Create the Python virtual environment and install API dependencies |
| `pnpm db:generate` | Generate Drizzle migrations |
| `pnpm db:migrate` | Run database migrations |
| `pnpm typecheck` | Type-check all TypeScript workspaces |
| `pnpm test` | Run shared package tests and FastAPI tests |
| `pnpm build` | Build all production artifacts |

> [!TIP]
> The web app can create tasks without the worker, but generation will stay queued until `@answer-generator/worker` is running.

## Word Import

The Word import flow supports two modes:

- **普通解析**: deterministic parser for regularly formatted `.docx` files.
- **AI 解析**: model-assisted parser for documents where question titles, materials, and prompts vary by layout.

Both modes return a normalized list of question items. Materials are optional, and questions can contain multiple prompts.

## Task Lifecycle

1. Create a task and enter rubric settings.
2. The system compiles the rubric into task guidance.
3. Add questions manually or import a Word file.
4. Start the task manually.
5. The worker generates answers for each question.
6. The worker reviews generated answers against the task rubric.
7. Low-scoring answers are retried with feedback until they pass or reach the retry limit.
8. The task finishes as completed or leaves failed items for manual handling.

## Production Deployment

The repository includes a GitHub Actions workflow at `.github/workflows/deploy.yml`.

Deployment flow:

1. Run `pnpm typecheck` and `pnpm test`.
2. Build and push `web`, `task`, `api`, and `worker` images to GHCR.
3. Run on a self-hosted runner with labels:

```text
self-hosted
linux
answer-generator-prod
```

4. Write `.env.production`.
5. Start Postgres and Redis.
6. Run migrations.
7. Start `web`, `api`, and `worker`.

Required GitHub `production` secrets:

| Secret | Purpose |
| --- | --- |
| `DEPLOY_SSH_KEY` | SSH key used by the self-hosted runner checkout |
| `POSTGRES_PASSWORD` | Production Postgres password |
| `OPENAI_API_KEY` | Model service API key |

Useful GitHub `production` variables:

| Variable | Suggested value |
| --- | --- |
| `POSTGRES_USER` | `answer_generator` |
| `POSTGRES_DB` | `answer_generator` |
| `WEB_BIND_HOST` | `0.0.0.0` |
| `WEB_PORT` | `3011` |
| `WORKER_CONCURRENCY` | `1` |

After deployment, visit:

```text
http://SERVER_IP:3011
```

Make sure the server security group and firewall allow inbound TCP traffic on `3011`.

## Manual Server Operations

Manual commands are useful for initial setup, debugging, and emergency recovery:

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production -f docker-compose.prod.yml up -d postgres redis
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm migrate
docker compose --env-file .env.production -f docker-compose.prod.yml up -d web api worker
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

View logs:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 web
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 api
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 worker
```

Health check:

```bash
curl http://127.0.0.1:3011/api/health
```

## Nginx

An example reverse proxy config is available at:

```text
deploy/nginx/answer-generator.conf
```

Use it when a domain is available. Direct IP access works through `http://SERVER_IP:3011` after opening the port.

## Troubleshooting

### `DATABASE_URL is required`

The web app, worker, and migration command all need `DATABASE_URL`. Copy `.env.example` to `.env` for local development, or verify `.env.production` in production.

### `No module named uvicorn`

Install API dependencies into the project virtual environment:

```bash
pnpm api:install
pnpm dev:api
```

### Task stays queued

Start the worker:

```bash
pnpm --filter @answer-generator/worker dev
```

For production:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 worker
```

### Browser cannot access `SERVER_IP:3011`

Check the service locally on the server:

```bash
curl http://127.0.0.1:3011/api/health
sudo ss -ltnp | grep 3011
```

Then confirm cloud security group and host firewall rules allow inbound TCP `3011`.
