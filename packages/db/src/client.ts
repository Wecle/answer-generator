import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { loadProjectEnv } from "./env";
import * as schema from "./schema";

const { Pool } = pg;

export function createDb(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    loadProjectEnv();
    databaseUrl = process.env.DATABASE_URL;
  }

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema });
}

export type DbClient = ReturnType<typeof createDb>;
