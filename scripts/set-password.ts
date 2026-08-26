import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { hashPassword } from "../src/lib/auth/password";

/**
 * One-off: set a real password for an existing account.
 *
 * Existing rows carry the "mock-password-hash" placeholder, which the new
 * verifier rejects unconditionally - correct, but it locks legacy users out
 * until a password is set. This is the set-password path for the certification
 * account so access survives the auth hardening.
 *
 *   npx tsx scripts/set-password.ts <email> <password>
 */
async function main() {
  const [, , email, password] = process.argv;
  if (!email || !password) {
    console.error("usage: tsx scripts/set-password.ts <email> <password>");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("password must be at least 8 characters");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const res = await prisma.user.updateMany({
    where: { email: email.toLowerCase() },
    data: { password: hash },
  });

  if (res.count === 0) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }
  console.log(`password set for ${email} (${res.count} row). Value not printed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
