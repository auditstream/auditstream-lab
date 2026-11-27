import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(currentDir, "../../../drizzle");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
try {
  await migrate(drizzle({ client: pool }), { migrationsFolder });
  console.log(`Applied Drizzle migrations from ${migrationsFolder}`);
} finally {
  await pool.end();
}
