# Answer Generator Platform Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent administrator platform for batch interview-answer generation, AI review, retry control, and export-ready storage.

**Architecture:** A lightweight monorepo hosts a Next.js admin app, a FastAPI AI service, shared TypeScript domain utilities, and a Drizzle Postgres schema package. Next.js owns admin workflows and persistence, FastAPI owns document parsing plus answer generation/review loops, and Redis/BullMQ is reserved for production async execution.

**Tech Stack:** Next.js, TypeScript, Drizzle, Postgres, Redis/BullMQ, FastAPI, Pydantic, pytest, Vitest, pnpm.

---

## Chunk 1: Foundation

### Task 1: Workspace Scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `README.md`

- [x] **Step 1: Create monorepo config**
- [x] **Step 2: Add root scripts for lint, test, build, dev**
- [x] **Step 3: Document local and Docker startup**

### Task 2: Shared Domain Logic

**Files:**
- Create: `packages/shared/src/answer-length.ts`
- Create: `packages/shared/src/retry-policy.ts`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/tests/*.test.ts`

- [x] **Step 1: Write Vitest coverage for answer-length and retry policy**
- [x] **Step 2: Implement deterministic helper functions**
- [x] **Step 3: Export package entrypoint**

### Task 3: Database Schema

**Files:**
- Create: `packages/db/src/schema.ts`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/index.ts`

- [x] **Step 1: Model generation jobs, items, attempts, reviews, and imports**
- [x] **Step 2: Add Drizzle config**

## Chunk 2: Services

### Task 4: FastAPI AI Service

**Files:**
- Create: `apps/api/app/main.py`
- Create: `apps/api/app/models.py`
- Create: `apps/api/app/services/*.py`
- Create: `apps/api/tests/*.py`

- [x] **Step 1: Add parse, generate, review, and run-item endpoints**
- [x] **Step 2: Add retry cap and final manual-review state**
- [x] **Step 3: Add pytest tests for successful and failed review loops**

### Task 5: Next.js Admin App

**Files:**
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/globals.css`
- Create: `apps/web/app/api/*/route.ts`

- [x] **Step 1: Build admin dashboard UI**
- [x] **Step 2: Add route handlers for health, job creation, and document parsing proxy**
- [x] **Step 3: Keep API calls compatible with standalone deployment**

## Chunk 3: Deployment

### Task 6: Docker and Docs

**Files:**
- Create: `docker-compose.yml`
- Create: `apps/web/Dockerfile`
- Create: `apps/api/Dockerfile`
- Create: `apps/api/requirements.txt`

- [x] **Step 1: Wire Postgres, Redis, Web, and API services**
- [x] **Step 2: Add env examples and deployment notes**
- [x] **Step 3: Run unit tests and type/build checks**
