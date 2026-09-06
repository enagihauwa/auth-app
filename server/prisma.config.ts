import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";
import { PrismaPg } from "@prisma/adapter-pg";

try {
  process.loadEnvFile(fileURLToPath(new URL("./.env", import.meta.url)));
} catch {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  } catch {
    // Fall back to the default development URL below.
  }
}

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://auth_app:auth_app_dev_password@127.0.0.1:5432/auth_db";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
  migrate: {
    adapter: () => new PrismaPg({ connectionString: databaseUrl }),
  },
});