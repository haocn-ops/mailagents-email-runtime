import { pruneIdempotencyKeys } from "../repositories/mail";
import type { Env } from "../types";

function parseRetentionHours(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function subtractHours(timestamp: number, hours: number): string {
  return new Date(timestamp - hours * 60 * 60 * 1000).toISOString();
}

export async function handleScheduled(event: ScheduledController, env: Env): Promise<void> {
  const completedRetentionHours = parseRetentionHours(env.IDEMPOTENCY_COMPLETED_RETENTION_HOURS, 24 * 7);
  const pendingRetentionHours = parseRetentionHours(env.IDEMPOTENCY_PENDING_RETENTION_HOURS, 1);

  await pruneIdempotencyKeys(env, {
    completedBefore: subtractHours(event.scheduledTime, completedRetentionHours),
    pendingBefore: subtractHours(event.scheduledTime, pendingRetentionHours),
  });
}

export async function runIdempotencyCleanupNow(env: Env, now = Date.now()): Promise<{
  deleted: number;
  completedRetentionHours: number;
  pendingRetentionHours: number;
}> {
  const completedRetentionHours = parseRetentionHours(env.IDEMPOTENCY_COMPLETED_RETENTION_HOURS, 24 * 7);
  const pendingRetentionHours = parseRetentionHours(env.IDEMPOTENCY_PENDING_RETENTION_HOURS, 1);
  const result = await pruneIdempotencyKeys(env, {
    completedBefore: subtractHours(now, completedRetentionHours),
    pendingBefore: subtractHours(now, pendingRetentionHours),
  });

  return {
    deleted: result.deleted,
    completedRetentionHours,
    pendingRetentionHours,
  };
}
