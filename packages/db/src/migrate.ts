import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadProjectEnv } from "./env";

const { Client } = pg;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
loadProjectEnv(repoRoot);

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const migrationsDir = path.join(packageRoot, "migrations");
const journalPath = path.join(migrationsDir, "meta", "_journal.json");
const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};

const client = new Client({ connectionString: databaseUrl });

await client.connect();

try {
  await client.query(`
    create table if not exists answer_generator_migrations (
      tag text primary key,
      applied_at timestamp with time zone not null default now()
    )
  `);

  for (const entry of journal.entries) {
    const alreadyApplied = await hasMigration(entry.tag);
    if (alreadyApplied) {
      console.log(`✓ ${entry.tag} already applied`);
      continue;
    }

    if (entry.tag === "0000_neat_enchantress" && await initialSchemaExists()) {
      await markMigration(entry.tag);
      console.log(`✓ ${entry.tag} recorded from existing schema`);
      continue;
    }

    const sqlPath = path.join(migrationsDir, `${entry.tag}.sql`);
    const sql = fs.readFileSync(sqlPath, "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    await client.query("begin");
    try {
      for (const statement of statements) {
        await client.query(statement);
      }
      await markMigration(entry.tag);
      await client.query("commit");
      console.log(`✓ ${entry.tag} applied`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client.end();
}

async function hasMigration(tag: string) {
  const result = await client.query("select 1 from answer_generator_migrations where tag = $1", [tag]);
  return (result.rowCount ?? 0) > 0;
}

async function markMigration(tag: string) {
  await client.query(
    "insert into answer_generator_migrations (tag) values ($1) on conflict (tag) do nothing",
    [tag]
  );
}

async function initialSchemaExists() {
  const result = await client.query(
    "select to_regclass('public.answer_generation_jobs') as jobs_table"
  );
  return result.rows[0]?.jobs_table === "answer_generation_jobs";
}
