import "dotenv/config";
import { defineConfig, env } from "prisma/config";

/**
 * Which variable holds the CLI's connection string, or none at all.
 *
 * `env()` RESOLVES immediately and throws PrismaConfigEnvError if the variable
 * is unset, so naming one unconditionally made this config file impossible to
 * load without a database URL in the environment. The previous version fell
 * back from DIRECT_URL to DATABASE_URL, which covers one of them being absent
 * and not both.
 *
 * Both are absent in exactly the two situations that matter most:
 *
 *   · CI, which has no .env and no secrets by design
 *   · a contributor who has just cloned the repository
 *
 * In both, `npm install` runs `prisma generate` from postinstall, the config
 * threw before the generator ran, and the install failed outright. That is what
 * turned the CI pipeline red on its very first run — and on every run of the
 * branch it came from, months earlier.
 *
 * `generate` needs no connection string; only migrate, studio and db execute
 * do. So when neither variable is set the datasource is simply omitted, and
 * those commands fail with Prisma's own clear message about a missing URL
 * rather than an unreadable config file.
 */
const urlVariable = process.env.DIRECT_URL
  ? "DIRECT_URL"
  : process.env.DATABASE_URL
    ? "DATABASE_URL"
    : null;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed.ts",
  },
  ...(urlVariable === null ? {} : { datasource: {
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
    // development - still works untouched.
    url: env(urlVariable),
  } }),
});
