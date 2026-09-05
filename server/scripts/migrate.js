import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

const { rows } = await pool.query("SELECT filename FROM schema_migrations");
const applied = new Set(rows.map((r) => r.filename));

for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip  ${file}`);
    continue;
  }
  const sql = await readFile(join(migrationsDir, file), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log(`apply ${file}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`fail  ${file}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

await pool.end();