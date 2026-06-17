# Answer Generator

[English](README.md)

Answer Generator 是一个独立的管理员后台，用于批量生成面试参考答案，并按自定义评分标准自动审核、低分重试、保存任务记录。

它可以作为独立平台部署，也可以和 CiviMind 部署在同一台服务器上运行。

## 功能特性

- 新建答案生成任务，配置评分标准、答题时间、通过分数和重试次数。
- 支持手动新增题目，也支持上传 `.docx` 文档批量导入。
- Word 导入支持普通解析和 AI 解析两种模式。
- 创建或修改任务后，先分析评分标准并整合生成任务核心提示词。
- 每道题独立生成参考答案。
- 答案生成后自动按任务评分标准审核。
- 分数未达标时，根据审核意见继续重试，直到通过或达到重试上限。
- 支持查看当前生成题目、生成进度、耗时、得分、重试意见和最终状态。
- 支持导出生成结果。
- 支持通过 GitHub Actions 构建镜像并自动部署到服务器。

> [!NOTE]
> `OPENAI_API_KEY` 为空时，FastAPI 会使用本地确定性逻辑，适合部署自检和页面联调。生产环境需要配置 OpenAI 兼容模型服务。

## 架构

```mermaid
flowchart LR
  Admin["管理员浏览器"] --> Web["Next.js Web + BFF"]
  Web --> Postgres[(Postgres)]
  Web --> Redis[(Redis 队列)]
  Web --> API["FastAPI AI 服务"]
  Worker["BullMQ Worker"] --> Redis
  Worker --> Postgres
  Worker --> API
```

| 工作区 | 说明 |
| --- | --- |
| `apps/web` | Next.js 管理后台与 BFF API |
| `apps/api` | FastAPI AI 服务，负责 Word 解析、评分标准分析、答案生成和答案审核 |
| `apps/worker` | BullMQ 异步 Worker，消费整批生成任务 |
| `packages/db` | Drizzle schema、数据库迁移和 Postgres 客户端 |
| `packages/shared` | 共享状态、重试策略、字数估算和导出工具 |

## 环境要求

- Node.js 20+
- pnpm 10.13.1
- Python 3.12，推荐用于 API 服务开发
- Docker 和 Docker Compose
- Postgres 与 Redis，可以使用本地容器或外部服务

## 快速开始

```bash
pnpm install
pnpm api:install
cp .env.example .env
docker compose up -d postgres redis
pnpm db:migrate
```

启动三个运行进程：

```bash
pnpm dev
pnpm dev:api
pnpm --filter @answer-generator/worker dev
```

打开 [http://localhost:3000](http://localhost:3000)。

本地 FastAPI 服务运行在 [http://localhost:8001](http://localhost:8001)。本地 Postgres 和 Redis 端口分别是 `5433` 和 `6380`。

## 环境变量

本地开发读取项目根目录的 `.env`。

```env
DATABASE_URL=postgres://answer_generator:answer_generator@localhost:5433/answer_generator
REDIS_URL=redis://localhost:6380
AI_SERVICE_URL=http://localhost:8001
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

生产部署读取 `.env.production`。GitHub Actions 部署时会根据 `production` 环境的 secrets 和 variables 自动写入。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 必填 | Postgres 连接字符串 |
| `REDIS_URL` | `redis://redis:6379` | Redis 连接字符串 |
| `AI_SERVICE_URL` | `http://api:8001` | 内部 FastAPI 服务地址 |
| `OPENAI_API_KEY` | 空 | OpenAI 兼容接口密钥 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容接口地址 |
| `OPENAI_MODEL` | `gpt-4o-mini` | AI 服务使用的模型 |
| `WORKER_CONCURRENCY` | `1` | Worker 并发任务数 |
| `WEB_BIND_HOST` | `0.0.0.0` | 生产 Web 服务绑定地址 |
| `WEB_PORT` | `3011` | 生产 Web 服务公网端口 |

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动 Next.js Web |
| `pnpm dev:api` | 使用 `apps/api/.venv` 启动 FastAPI |
| `pnpm --filter @answer-generator/worker dev` | 启动 BullMQ Worker |
| `pnpm api:install` | 创建 Python 虚拟环境并安装 API 依赖 |
| `pnpm db:generate` | 生成 Drizzle 迁移 |
| `pnpm db:migrate` | 执行数据库迁移 |
| `pnpm typecheck` | 执行 TypeScript 类型检查 |
| `pnpm test` | 执行共享包测试和 FastAPI 测试 |
| `pnpm build` | 构建生产产物 |

> [!TIP]
> Web 可以创建任务，但生成流程需要 Worker 消费 Redis 队列。Worker 未启动时，任务会停留在队列中。

## Word 导入

Word 导入支持两种模式：

- **普通解析**：适合格式稳定、标题和题目结构清晰的 `.docx` 文档。
- **AI 解析**：适合排版差异较大、材料和问题边界不固定的文档。

解析结果会统一转成题目列表。材料可以为空，问题可以包含多个子问题。

## 任务流程

1. 新建任务并填写评分标准。
2. 系统分析评分标准并生成任务核心提示词。
3. 手动新增题目或上传 Word 文档。
4. 人为点击开始任务。
5. Worker 逐题生成参考答案。
6. Worker 按任务评分标准审核答案。
7. 未通过的答案带着审核意见继续生成下一轮。
8. 全部通过后任务完成，达到重试上限的题目进入人工处理。

## 生产部署

仓库已包含 GitHub Actions 部署流程：`.github/workflows/deploy.yml`。

部署流程：

1. 执行 `pnpm typecheck` 和 `pnpm test`。
2. 构建 `web`、`task`、`api`、`worker` 镜像并推送到 GHCR。
3. 在自托管 runner 上执行部署，runner 需要以下标签：

```text
self-hosted
linux
answer-generator-prod
```

4. 写入 `.env.production`。
5. 启动 Postgres 和 Redis。
6. 执行数据库迁移。
7. 启动 `web`、`api` 和 `worker`。

GitHub `production` 环境需要配置的 secrets：

| Secret | 说明 |
| --- | --- |
| `DEPLOY_SSH_KEY` | 自托管 runner checkout 仓库使用的 SSH 私钥 |
| `POSTGRES_PASSWORD` | 生产 Postgres 密码 |
| `OPENAI_API_KEY` | 模型服务 API key |

常用 GitHub `production` variables：

| Variable | 建议值 |
| --- | --- |
| `POSTGRES_USER` | `answer_generator` |
| `POSTGRES_DB` | `answer_generator` |
| `WEB_BIND_HOST` | `0.0.0.0` |
| `WEB_PORT` | `3011` |
| `WORKER_CONCURRENCY` | `1` |

部署完成后访问：

```text
http://服务器IP:3011
```

服务器安全组和防火墙需要放行 TCP `3011`。

## 服务器手动操作

手动命令适合首次部署、排障和紧急恢复：

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production -f docker-compose.prod.yml up -d postgres redis
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm migrate
docker compose --env-file .env.production -f docker-compose.prod.yml up -d web api worker
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

查看日志：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 web
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 api
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 worker
```

健康检查：

```bash
curl http://127.0.0.1:3011/api/health
```

## Nginx

示例反向代理配置在：

```text
deploy/nginx/answer-generator.conf
```

有域名时可以使用 Nginx 代理。使用公网 IP 访问时，开放 `3011` 端口即可。

## 常见问题

### `DATABASE_URL is required`

Web、Worker 和迁移命令都需要 `DATABASE_URL`。本地开发请复制 `.env.example` 为 `.env`，生产环境检查 `.env.production`。

### `No module named uvicorn`

重新安装 API 虚拟环境依赖：

```bash
pnpm api:install
pnpm dev:api
```

### 任务一直在队列中

启动 Worker：

```bash
pnpm --filter @answer-generator/worker dev
```

生产环境查看 Worker 日志：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 worker
```

### 浏览器无法访问 `服务器IP:3011`

先在服务器上检查本机访问：

```bash
curl http://127.0.0.1:3011/api/health
sudo ss -ltnp | grep 3011
```

再确认云服务器安全组和主机防火墙已放行 TCP `3011`。
