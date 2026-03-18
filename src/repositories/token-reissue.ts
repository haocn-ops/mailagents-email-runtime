import { createId } from "../lib/ids";
import { firstRow, execute } from "../lib/db";
import { nowIso } from "../lib/time";
import type { Env } from "../types";

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

export function getMailboxCooldownSeconds(env: Env): number {
  return parsePositiveInteger(env.PUBLIC_TOKEN_REISSUE_MAILBOX_COOLDOWN_SECONDS) ?? 15 * 60;
}

export function getIpWindowSeconds(env: Env): number {
  return parsePositiveInteger(env.PUBLIC_TOKEN_REISSUE_IP_WINDOW_SECONDS) ?? 60 * 60;
}

export function getIpMaxRequests(env: Env): number {
  return parsePositiveInteger(env.PUBLIC_TOKEN_REISSUE_IP_MAX_REQUESTS) ?? 5;
}

export async function hasRecentMailboxTokenReissue(env: Env, mailboxAddress: string, sinceIso: string): Promise<boolean> {
  const row = await firstRow<{ count: number }>(
    env.D1_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM token_reissue_requests
       WHERE mailbox_address = ? AND requested_at >= ?`
    ).bind(mailboxAddress.toLowerCase(), sinceIso)
  );

  return Number(row?.count ?? 0) > 0;
}

export async function countRecentIpTokenReissues(env: Env, requesterIpHash: string, sinceIso: string): Promise<number> {
  const row = await firstRow<{ count: number }>(
    env.D1_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM token_reissue_requests
       WHERE requester_ip_hash = ? AND requested_at >= ?`
    ).bind(requesterIpHash, sinceIso)
  );

  return Number(row?.count ?? 0);
}

export async function logTokenReissueRequest(env: Env, input: {
  mailboxAddress: string;
  requesterIpHash?: string;
}): Promise<void> {
  const timestamp = nowIso();
  await execute(env.D1_DB.prepare(
    `INSERT INTO token_reissue_requests (id, mailbox_address, requester_ip_hash, requested_at)
     VALUES (?, ?, ?, ?)`
  ).bind(
    createId("trr"),
    input.mailboxAddress.toLowerCase(),
    input.requesterIpHash ?? null,
    timestamp,
  ));
}
