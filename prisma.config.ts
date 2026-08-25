import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed.ts",
  },
  datasource: {
    // This URL is used by the Prisma CLI only - migrate, db execute, studio.
    // The application never reads it: src/lib/prisma.ts builds its own pg Pool
    // from DATABASE_URL, so the two paths are already independent.
    //
    // That independence is what we want on Neon. DATABASE_URL is the POOLED
    // endpoint, which is correct for serverless request handlers but cannot
    // carry DDL - pgbouncer in transaction mode does not preserve the session
    // state migrations need. So the CLI is pointed at the DIRECT endpoint
    // instead, and the app keeps its pooled one.
    //
    // Prisma 7 has no `directUrl` key here (Datasource is `{ url?,
    // shadowDatabaseUrl? }`); selecting the variable is the supported way to
    // express this. Falls back to DATABASE_URL so a single-URL setup - local
    // development, CI - still works untouched.
    url: env(process.env.DIRECT_URL ? "DIRECT_URL" : "DATABASE_URL"),
  },
});
