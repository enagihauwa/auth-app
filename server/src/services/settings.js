import { prisma } from "../db.js";

const defaults = {
  rate_limit_enabled: "true",
};

const cache = new Map();
const pollMs = 5000;
let pollTimer = null;

async function refresh() {
  try {
    const rows = await prisma.appSettings.findMany();
    cache.clear();
    for (const row of rows) cache.set(row.key, row.value);
  } catch {
    // DB unreachable; fall back to whatever is cached / default.
  }
}

export function startupSettingsPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(refresh, pollMs);
  refresh();
  pollTimer.unref?.();
}

export async function isRateLimitEnabled() {
  if (!cache.has("rate_limit_enabled")) {
    await refresh();
  }
  return cache.get("rate_limit_enabled") !== "false";
}