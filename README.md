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

第一版可与现有 CiviMind 同服部署，共用 Postgres 和 Redis。请使用独立 database/schema、独立 Redis key prefix、独立域名或 Nginx path。Worker 并发建议从 `1` 开始，避免管理员批量任务挤占服务器资源。
