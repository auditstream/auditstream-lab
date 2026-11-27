import { auditstream } from "@auditstream/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { attachPoolErrorHandler } from "../../shared/http.js";
import { PrismaClient } from "../generated/prisma/client.js";

export interface PrismaDatabaseHandle {
  readonly pool: pg.Pool;
  readonly prisma: PrismaClient;
  close(): Promise<void>;
}

/**
 * Creates a Prisma 7 client wired with `PrismaPg` (`max: 5`) and `@auditstream/prisma`'s
 * SQL comments plugin (never setting `statementNameGenerator` alongside SQL comments).
 */
export function createPrismaDatabase(connectionString: string, max = 5): PrismaDatabaseHandle {
  const pool = new pg.Pool({ connectionString, max });
  attachPoolErrorHandler(pool, "prisma-api");
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({
    adapter,
    comments: [auditstream()],
  });
  return {
    pool,
    prisma,
    async close(): Promise<void> {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}
