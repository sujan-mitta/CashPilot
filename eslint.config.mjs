import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma client is code-generated; it is not ours to lint.
    "generated/**",
  ]),
  {
    // Test doubles deliberately model partial shapes - a fake Prisma client
    // implements the four methods a test exercises, not the full surface. Typing
    // those fully would mean re-declaring the generated client by hand, which
    // adds no safety and rots on every schema change.
    //
    // This is scoped to tests and fixtures ONLY. Production source stays strict:
    // every `any` there is real debt and is meant to show up in lint.
    files: ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx", "scripts/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
