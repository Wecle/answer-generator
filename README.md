# Answer Generator

独立的管理员后台，用于批量生成公务员面试参考答案、按评分标准自动审核、低分重试，并保存完整任务记录。

## 模块

| 路径 | 说明 |
| --- | --- |
| `apps/web` | Next.js 管理后台与 BFF API |
| `apps/api` | FastAPI AI 能力服务：Word 解析、答案生成、答案审核 |
| `apps/worker` | BullMQ 异步任务 Worker，执行整批任务并写回结果 |
| `packages/db` | Drizzle Postgres schema 与数据库客户端 |
| `packages/shared` | 共享类型、答题字数估算、重试策略 |

## 本地启动

首次启动先安装 Node 和 Python 依赖。FastAPI 使用项目内虚拟环境 `apps/api/.venv`，避免本机 `python3` 指向不同版本导致 `uvicorn` 缺失。

```bash
pnpm install
pnpm api:install
cp .env.example .env
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev:api
pnpm dev
pnpm --filter @answer-generator/worker dev
```

Web 默认运行在 `http://localhost:3000`，FastAPI 默认运行在 `http://localhost:8001`。

点击“开始任务”后必须有 Worker 常驻消费 Redis 队列。未启动 Worker 时，任务会进入队列，页面会提示启动命令：

```bash
pnpm --filter @answer-generator/worker dev
```

Next.js、FastAPI、Worker 和迁移脚本都会读取项目根目录 `.env`。

## Python 虚拟环境

`pnpm api:install` 会执行：

```bash
/usr/bin/python3 -m venv apps/api/.venv
apps/api/.venv/bin/python -m pip install -r apps/api/requirements.txt
```

`pnpm dev:api` 会固定使用：

```bash
apps/api/.venv/bin/python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8001
```

如果遇到 `No module named uvicorn`，重新执行：

```bash
pnpm api:install
pnpm dev:api
```

## 常用命令

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm api:install
pnpm db:generate
pnpm db:migrate
pnpm --filter @answer-generator/worker dev
```

## AI 配置

设置 `OPENAI_API_KEY` 后 FastAPI 会调用 OpenAI 兼容接口。未设置 key 时会使用本地确定性生成器，适合部署自检和页面联调。

## 部署建议

推荐使用 GitHub Actions 自动部署，方式与 CiviMind 一致：GitHub 构建镜像并推送到 GHCR，服务器上的自托管 runner 拉取镜像、执行迁移、启动服务。服务器手动命令主要用于首次排障和紧急回滚。

生产服务通过 Docker Compose 编排：

| 服务 | 说明 |
| --- | --- |
| `web` | Next.js 管理后台与 BFF API，默认绑定 `127.0.0.1:3001` |
| `api` | FastAPI AI 服务，供 web 和 worker 内网调用 |
| `worker` | BullMQ Worker，消费 Redis 队列并执行批量生成 |
| `migrate` | 一次性数据库迁移任务 |
| `postgres` | 独立 Postgres 数据卷 |
| `redis` | 独立 Redis 数据卷 |

### GitHub Actions 部署

已提供 `.github/workflows/deploy.yml`，流程参考 CiviMind：

1. `test`：安装依赖、执行 `pnpm typecheck` 和 `pnpm test`
2. `build`：构建并推送 `web`、`task`、`api`、`worker` 镜像到 GHCR
3. `deploy`：在自托管 runner 上写入 `.env.production`，拉取镜像、执行迁移、启动服务

触发方式：

- 推送到 `main`
- 在 Actions 页面手动执行 `Deploy Answer Generator`

自托管 runner 需要标签：

```text
self-hosted
linux
answer-generator-prod
```

服务器需要提前准备 Docker、Docker Compose、GitHub self-hosted runner、Nginx。首次部署完成后，后续发布只需要推送代码到 `main`，Actions 会自动完成构建和部署。

GitHub Environment `production` 需要配置：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| Secret | `DEPLOY_SSH_KEY` | 部署机拉取仓库用的私钥 |
| Secret | `POSTGRES_PASSWORD` | 生产数据库密码 |
| Secret | `OPENAI_API_KEY` | OpenAI 兼容接口密钥 |
| Variable | `POSTGRES_USER` | 默认 `answer_generator` |
| Variable | `POSTGRES_DB` | 默认 `answer_generator` |
| Variable | `REDIS_URL` | 默认 `redis://redis:6379` |
| Variable | `AI_SERVICE_URL` | 默认 `http://api:8001` |
| Variable | `OPENAI_BASE_URL` | 默认 `https://api.openai.com/v1` |
| Variable | `OPENAI_MODEL` | 默认 `gpt-4o-mini` |
| Variable | `WORKER_CONCURRENCY` | 默认 `1` |

### 服务器手动兜底

用于排查 Actions、镜像、环境变量或服务器网络问题：

```bash
cp .env.production.example .env.production
vim .env.production
docker compose --env-file .env.production -f docker-compose.prod.yml build
docker compose --env-file .env.production -f docker-compose.prod.yml up -d postgres redis
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm migrate
docker compose --env-file .env.production -f docker-compose.prod.yml up -d web api worker
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

默认 web 端口为 `127.0.0.1:3001`，适合同服部署在 CiviMind 旁边，再用 Nginx 按独立域名反代。需要改端口时设置：

```bash
WEB_PORT=3002 docker compose --env-file .env.production -f docker-compose.prod.yml up -d web
```

Nginx 示例在：

```bash
deploy/nginx/answer-generator.conf
```

复制后把 `server_name` 改为实际域名，并按服务器习惯启用配置。

### 与 CiviMind 同服

当前生产 compose 使用项目独立的 Postgres/Redis 容器和数据卷，Web 端口默认 `3001`，可以和 CiviMind 的 `3000` 同服运行。Worker 并发建议从 `1` 开始，避免批量生成任务挤占服务器资源。
