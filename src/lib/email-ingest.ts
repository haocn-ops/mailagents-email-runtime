import { normalizeSubject, parseRawEmail } from "./email-parser";
import { enqueueDeadLetter } from "./queue";
import { nowIso } from "./time";
import { getAgentVersion, resolveAgentExecutionTarget } from "../repositories/agents";
import {
  deleteThreadIfUnreferenced,
  findThreadByReplyContext,
  getMessage,
  getOrCreateTaskForSourceMessage,
  getOrCreateThread,
  getTaskBySourceMessageId,
  insertAttachments,
  updateInboundMessageNormalized,
  updateMessageStatus,
  updateTaskStatus,
  updateThreadTimestamp,
} from "../repositories/mail";
import type { EmailIngestJob, Env } from "../types";

const RECEIVE_CAPABLE_MAILBOX_ROLES = ["primary", "shared", "receive_only"] as const;

function reasonFromError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}

function deadLetterFromError(source: string, refId: string, error: unknown) {
  return {
    source,
    refId,
    reason: reasonFromError(error),
  };
}

async function deleteR2Objects(env: Env, r2Keys: string[]): Promise<void> {
  const uniqueKeys = [...new Set(r2Keys.map((value) => value.trim()).filter(Boolean))];
  await Promise.all(uniqueKeys.map((key) => env.R2_EMAIL.delete(key).catch(() => undefined)));
}

export async function recordTaskNeedsReview(env: Env, input: {
  taskId: string;
  sourceMessageId: string;
  mailboxId: string;
  agentId?: string;
  agentVersionId?: string;
  deploymentId?: string;
  queuedAgentId?: string;
  queuedAgentVersionId?: string;
  queuedDeploymentId?: string;
  reviewReason: string;
  sourceMessageStatus?: string | null;
}): Promise<string> {
  const runId = `run_${input.taskId}`;
  const timestamp = nowIso();
  const effectiveAgentId = input.agentId ?? input.queuedAgentId;
  const version = effectiveAgentId && input.agentVersionId
    ? await getAgentVersion(env, effectiveAgentId, input.agentVersionId)
    : null;
  const traceR2Key = `traces/${runId}.json`;

  await env.R2_EMAIL.put(traceR2Key, JSON.stringify({
    runId,
    taskId: input.taskId,
    sourceMessageId: input.sourceMessageId,
    mailboxId: input.mailboxId,
    queuedAgentId: input.queuedAgentId ?? null,
    queuedAgentVersionId: input.queuedAgentVersionId ?? null,
    queuedDeploymentId: input.queuedDeploymentId ?? null,
    agentId: effectiveAgentId ?? null,
    agentVersionId: input.agentVersionId ?? null,
    deploymentId: input.deploymentId ?? null,
    model: version?.model ?? "gpt-5",
    status: "needs_review",
    reviewReason: input.reviewReason,
    sourceMessageStatus: input.sourceMessageStatus ?? null,
    startedAt: timestamp,
    completedAt: timestamp,
  }, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  try {
    await env.D1_DB.prepare(
      `INSERT OR REPLACE INTO agent_runs (
        id, task_id, agent_id, model, status, trace_r2_key, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      runId,
      input.taskId,
      effectiveAgentId ?? null,
      version?.model ?? "gpt-5",
      "needs_review",
      traceR2Key,
      timestamp,
      timestamp
    ).run();

    await updateTaskStatus(env, {
      taskId: input.taskId,
      status: "needs_review",
      resultR2Key: traceR2Key,
    });
  } catch (error) {
    await env.D1_DB.prepare(
      `DELETE FROM agent_runs WHERE id = ?`
    ).bind(runId).run().catch(() => undefined);
    await deleteR2Objects(env, [traceR2Key]);
    throw error;
  }

  return traceR2Key;
}

export async function processEmailIngestJob(job: EmailIngestJob, env: Env): Promise<void> {
  const existingMessage = await getMessage(env, job.messageId);
  const rawObject = await env.R2_EMAIL.get(job.rawR2Key);
  if (!rawObject) {
    throw new Error("Raw email object not found");
  }

  const rawText = await rawObject.text();
  const parsed = parseRawEmail(rawText);
  const referencedMessageIds = [
    parsed.inReplyTo,
    ...[...parsed.references].reverse(),
  ].filter((value): value is string => Boolean(value?.trim()));
  const thread = await findThreadByReplyContext(env, {
    tenantId: job.tenantId,
    mailboxId: job.mailboxId,
    internetMessageIds: referencedMessageIds,
    subject: parsed.subject,
    participantAddress: parsed.replyTo ?? parsed.from,
  }) ?? await getOrCreateThread(env, {
    tenantId: job.tenantId,
    mailboxId: job.mailboxId,
    threadKey: parsed.threadKey,
    subjectNorm: normalizeSubject(parsed.subject),
  });

  const normalizedR2Key = `normalized/${job.messageId}.json`;
  await env.R2_EMAIL.put(normalizedR2Key, JSON.stringify({
    text: parsed.text ?? "",
    html: parsed.html ?? "",
    headers: parsed.headers,
    from: parsed.from,
    replyTo: parsed.replyTo,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
  }, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  try {
    await updateInboundMessageNormalized(env, {
      messageId: job.messageId,
      threadId: thread.id,
      normalizedR2Key,
      subject: parsed.subject,
      snippet: parsed.snippet,
      internetMessageId: parsed.messageId,
      fromAddr: parsed.replyTo ?? parsed.from,
      status: "normalized",
    });
  } catch (error) {
    await deleteR2Objects(env, [normalizedR2Key]);
    await deleteThreadIfUnreferenced(env, thread.id).catch(() => undefined);
    throw error;
  }
  await updateThreadTimestamp(env, thread.id);

  const attachmentRows = [];
  const uploadedAttachmentKeys: string[] = [];
  for (const [index, attachment] of parsed.attachments.entries()) {
    const attachmentId = `att_${job.messageId}_${index + 1}`;
    const r2Key = `attachments/${job.messageId}/${attachmentId}`;
    await env.R2_EMAIL.put(r2Key, attachment.content, {
      httpMetadata: { contentType: attachment.contentType ?? "application/octet-stream" },
    });
    uploadedAttachmentKeys.push(r2Key);
    attachmentRows.push({
      id: attachmentId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.content.byteLength,
      r2Key,
    });
  }

  let staleAttachmentKeys: string[] = [];
  try {
    staleAttachmentKeys = await insertAttachments(env, {
      messageId: job.messageId,
      attachments: attachmentRows,
    });
  } catch (error) {
    await deleteR2Objects(env, uploadedAttachmentKeys);
    throw error;
  }
  await deleteR2Objects(env, staleAttachmentKeys);

  const executionTarget = await resolveAgentExecutionTarget(env, job.mailboxId, undefined, [...RECEIVE_CAPABLE_MAILBOX_ROLES]);
  const task = executionTarget
    ? await getOrCreateTaskForSourceMessage(env, {
        tenantId: job.tenantId,
        mailboxId: job.mailboxId,
        sourceMessageId: job.messageId,
        taskType: "reply",
        priority: 50,
        status: "queued",
        assignedAgent: executionTarget.agentId,
      })
    : await getTaskBySourceMessageId(env, job.messageId, "reply");

  if (task && (task.status === "queued" || task.status === "running" || task.status === "needs_review")) {
    await updateMessageStatus(env, job.messageId, "tasked");
  } else if (
    existingMessage?.status
    && existingMessage.status !== "received"
    && existingMessage.status !== "normalized"
  ) {
    await updateMessageStatus(env, job.messageId, existingMessage.status);
  }

  if (executionTarget && task?.status === "queued") {
    try {
      await env.AGENT_EXECUTE_QUEUE.send({
        taskId: task.id,
        agentId: executionTarget.agentId,
        agentVersionId: executionTarget.agentVersionId,
        deploymentId: executionTarget.deploymentId,
      });
    } catch (error) {
      await recordTaskNeedsReview(env, {
        taskId: task.id,
        sourceMessageId: task.sourceMessageId,
        mailboxId: task.mailboxId,
        agentId: executionTarget.agentId,
        agentVersionId: executionTarget.agentVersionId,
        deploymentId: executionTarget.deploymentId,
        queuedAgentId: executionTarget.agentId,
        queuedAgentVersionId: executionTarget.agentVersionId,
        queuedDeploymentId: executionTarget.deploymentId,
        reviewReason: "agent_execute_queue_unavailable",
        sourceMessageStatus: existingMessage?.status ?? "normalized",
      });
      await enqueueDeadLetter(env, deadLetterFromError("agent-execute-dispatch", task.id, error)).catch(() => undefined);
    }
  }
}

export async function dispatchEmailIngestWithFallback(env: Env, payload: EmailIngestJob): Promise<void> {
  try {
    await env.EMAIL_INGEST_QUEUE.send(payload);
    return;
  } catch {
    await processEmailIngestJob(payload, env);
  }
}
