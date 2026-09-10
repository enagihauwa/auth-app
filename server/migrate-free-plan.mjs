// Idempotent data migration: every user who has no subscription row is on the
// free plan, matching the invariant that signup starts free and only an
// explicit, paid checkout grants Pro. Running this again is a safe no-op.
import { prisma } from "./src/db.js";

const updated = await prisma.$executeRaw`
  UPDATE users
  SET plan = 'free', updated_at = now()
  WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = users.id)
`;

console.log(`Migrated ${updated} user(s) without a subscription to plan = 'free'.`);

const inconsistent = await prisma.$queryRaw`
  SELECT u.id, u.email, u.plan
  FROM users u
  WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id)
    AND u.plan <> 'free'
`;

if (inconsistent.length === 0) {
  console.log("Consistent: every user without a subscription is on the free plan.");
} else {
  console.log(`Still inconsistent (${inconsistent.length}):`, JSON.stringify(inconsistent, null, 2));
  process.exitCode = 1;
}

await prisma.$disconnect();