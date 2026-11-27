import { defineConfig, type PrismaConfigInternal } from "prisma/config";

const config: PrismaConfigInternal = defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/unused",
  },
});

export default config;
