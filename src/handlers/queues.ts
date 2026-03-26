import { parseRawEmail } from "../lib/email-parser";
import { sendOutboundDraft } from "../lib/outbound-provider";
import { releaseOutboundUsageReservation, settleOutboundUsageDebit } from "../lib/outbound-billing";
import { enqueueDeadLetter } from "../lib/queue";
import { nowIso } from "../lib/time";
import { getAgentVersion, getMailboxById, resolveAgentExecutionTarget } from "../repositories/agents";
import {
} from "../repositories/billing";
import {
  findThreadByReplyContext,
  claimTaskForExecution,
  getDraftByR2Key,
  getMessage,
  getOrCreateTaskForSourceMessage,
  getOrCreateThread,
  getOutboundJob,
  getSuppression,
  getTaskBySourceMessageId,
  insertAttachments,
  listDeliveryEventsByMessageId,
  markDraftStatus,
  markMessageSent,
  updateMessageStatus,
  updateTaskStatus,
  updateInboundMessageNormalized,
  updateOutboundJobStatus,
  updateThreadTimestamp,
} from "../repositories/mail";
import type { AgentExecuteJob, DeadLetterJob, EmailIngestJob, Env, OutboundSendJob } from "../types";

class OutboundPolicyError extends Error {}
const RECEIVE_CAPABLE_MAILBOX_ROLES = ["primary", "shared", "receive_only"] as const;

type TerminalDeliveryOutcome = "sent" | "failed" | null;

function getOutboundSendMaxRetries(env: Env): number {
  const raw = env.OUTBOUND_SEND_MAX_RETRIES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
}

function getOutboundSendInDoubtGraceMs(env: Env): number {
  const raw = env.OUTBOUND_SEND_IN_DOUBT_GRACE_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
  return seconds * 1000;
}

function getTerminalDeliveryOutcome(events: Array<{ eventType: string }>): TerminalDeliveryOutcome {
  if (events.some((event) => event.eventType === "delivery")) {
    return "sent";
  }

  if (events.some((event) => event.eventType === "bounce" || event.eventType === "complaint" || event.eventType === "reject")) {
    return "failed";
  }

  return null;
}

function normalizeRecipientAddress(value: string): string {
  return value.trim().toLowerCase();
}

async function getSuppressedRecipients(env: Env, recipients: string[]): Promise<string[]> {
  const uniqueRecipients = [...new Set(recipients.map(normalizeRecipientAddress).filter(Boolean))];
  const suppressed: string[] = [];

  for (const recipient of uniqueRecipients) {
    if (await getSuppression(env, recipient)) {
      suppressed.push(recipient);
    }
  }

  return suppressed;
}

async function handleEmailIngest(batch: MessageBatch<EmailIngestJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const existingMessage = await getMessage(env, message.body.messageId);
      const rawObject = await env.R2_EMAIL.get(message.body.rawR2Key);
      if (!rawObject) {
        throw new Error("Raw email object not found");
      }

      const rawText = await rawObject.text();
      const parsed = parseRawEmail(rawText);
      const referencedMessageIds = [
        parsed.inReplyTo,
        ...[...parsed.references].reverse(),
      ].filter((value): value is string => Boolean(value?.trim()));
      // Prefer an existing thread referenced by email headers before falling back to parser-derived keys.
      const thread = await findThreadByReplyContext(env, {
        tenantId: message.body.tenantId,
        mailboxId: message.body.mailboxId,
        internetMessageIds: referencedMessageIds,
        subject: parsed.subject,
        participantAddress: parsed.replyTo ?? parsed.from,
      }) ?? await getOrCreateThread(env, {
        tenantId: message.body.tenantId,
        mailboxId: message.body.mailboxId,
        threadKey: parsed.threadKey,
        subjectNorm: parsed.subject?.replace(/^(re|fwd|fw):\s*/gi, "").trim().toLowerCase(),
      });

      const normalizedR2Key = `normalized/${message.body.messageId}.json`;
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

      await updateInboundMessageNormalized(env, {
        messageId: message.body.messageId,
        threadId: thread.id,
        normalizedR2Key,
        subject: parsed.subject,
        snippet: parsed.snippet,
        internetMessageId: parsed.messageId,
        fromAddr: parsed.replyTo ?? parsed.from,
        status: "normalized",
      });
      await updateThreadTimestamp(env, thread.id);

      const attachmentRows = [];
      for (const [index, attachment] of parsed.attachments.entries()) {
        const attachmentId = `att_${message.body.messageId}_${index + 1}`;
        const r2Key = `attachments/${message.body.messageId}/${attachmentId}`;
        await env.R2_EMAIL.put(r2Key, attachment.content, {
          httpMetadata: { contentType: attachment.contentType ?? "application/octet-stream" },
        });
        attachmentRows.push({
          id: attachmentId,
          filename: attachment.filename,
          contentType: attachment.contentType,
          sizeBytes: attachment.content.byteLength,
          r2Key,
        });
      }
      await insertAttachments(env, {
        messageId: message.body.messageId,
        attachments: attachmentRows,
      });

      const executionTarget = await resolveAgentExecutionTarget(env, message.body.mailboxId, undefined, [...RECEIVE_CAPABLE_MAILBOX_ROLES]);
      const task = executionTarget
        ? await getOrCreateTaskForSourceMessage(env, {
            tenantId: message.body.tenantId,
            mailboxId: message.body.mailboxId,
            sourceMessageId: message.body.messageId,
            taskType: "reply",
            priority: 50,
            status: "queued",
            assignedAgent: executionTarget.agentId,
          })
        : await getTaskBySourceMessageId(env, message.body.messageId, "reply");

      if (task && (task.status === "queued" || task.status === "running" || task.status === "needs_review")) {
        await updateMessageStatus(env, message.body.messageId, "tasked");
      } else if (
        existingMessage?.status
        && existingMessage.status !== "received"
        && existingMessage.status !== "normalized"
      ) {
        await updateMessageStatus(env, message.body.messageId, existingMessage.status);
      }

      if (executionTarget && task?.status === "queued") {
        await env.AGENT_EXECUTE_QUEUE.send({
          taskId: task.id,
          agentId: executionTarget.agentId,
          agentVersionId: executionTarget.agentVersionId,
          deploymentId: executionTarget.deploymentId,
        });
      }

      message.ack();
    } catch (error) {
      await enqueueDeadLetter(env, deadLetterFromError("email-ingest", message.body.messageId, error));
      message.retry();
    }
  }
}

async function handleAgentExecute(batch: MessageBatch<AgentExecuteJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const claimed = await claimTaskForExecution(env, message.body.taskId);
      if (!claimed) {
        message.ack();
        continue;
      }

      const runId = `run_${message.body.taskId}`;
      const timestamp = nowIso();
      const version = message.body.agentVersionId
        ? await getAgentVersion(env, message.body.agentId, message.body.agentVersionId)
        : null;
      const traceR2Key = `traces/${runId}.json`;

      await env.R2_EMAIL.put(traceR2Key, JSON.stringify({
        runId,
        taskId: message.body.taskId,
        agentId: message.body.agentId,
        agentVersionId: message.body.agentVersionId ?? null,
        deploymentId: message.body.deploymentId ?? null,
        model: version?.model ?? "gpt-5",
        status: "completed",
        startedAt: timestamp,
        completedAt: timestamp,
      }, null, 2), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });

      await env.D1_DB.prepare(
        `INSERT OR REPLACE INTO agent_runs (
          id, task_id, agent_id, model, status, trace_r2_key, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        runId,
        message.body.taskId,
        message.body.agentId,
        version?.model ?? "gpt-5",
        "completed",
        traceR2Key,
        timestamp,
        timestamp
      ).run();

      await updateTaskStatus(env, {
        taskId: message.body.taskId,
        status: "done",
        resultR2Key: traceR2Key,
      });

      message.ack();
    } catch (error) {
      await updateTaskStatus(env, {
        taskId: message.body.taskId,
        status: "failed",
      }).catch(() => undefined);
      await enqueueDeadLetter(env, deadLetterFromError("agent-execute", message.body.taskId, error));
      message.retry();
    }
  }
}

async function handleOutboundSend(batch: MessageBatch<OutboundSendJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    let outboundJob = null as Awaited<ReturnType<typeof getOutboundJob>> | null;
    let draft = null as Awaited<ReturnType<typeof getDraftByR2Key>> | null;
    let to: string[] = [];
    let cc: string[] = [];
    let bcc: string[] = [];
    try {
      outboundJob = await getOutboundJob(env, message.body.outboundJobId);
      if (!outboundJob) {
        throw new Error("Outbound job not found");
      }

      const draftObject = await env.R2_EMAIL.get(outboundJob.draftR2Key);
      if (!draftObject) {
        throw new Error("Draft payload not found in R2");
      }

      const draftPayload = await draftObject.json<Record<string, unknown>>();
      draft = await getDraftByR2Key(env, outboundJob.draftR2Key);
      const outboundMessage = await getMessage(env, outboundJob.messageId);
      if (!outboundMessage) {
        throw new Error("Outbound message not found");
      }
      const deliveryEvents = await listDeliveryEventsByMessageId(env, outboundMessage.id);
      const deliveryOutcome = getTerminalDeliveryOutcome(deliveryEvents);

      if (outboundJob.status === "sent") {
        to = Array.isArray(draftPayload.to) ? draftPayload.to.filter((item): item is string => typeof item === "string") : [];
        cc = Array.isArray(draftPayload.cc) ? draftPayload.cc.filter((item): item is string => typeof item === "string") : [];
        bcc = Array.isArray(draftPayload.bcc) ? draftPayload.bcc.filter((item): item is string => typeof item === "string") : [];
        try {
          await settleOutboundUsageDebit(env, {
            tenantId: outboundMessage.tenantId,
            messageId: outboundJob.messageId,
            outboundJobId: outboundJob.id,
            draftId: draft?.id,
            draftCreatedVia: draft?.createdVia,
            sourceMessageId: draft?.sourceMessageId,
            to,
            cc,
            bcc,
          });
          message.ack();
        } catch (billingError) {
          await enqueueDeadLetter(env, deadLetterFromError("outbound-billing", outboundJob.id, billingError));
          message.retry();
        }
        continue;
      }

      if (
        outboundJob.status === "sending"
        && (
          outboundMessage.providerMessageId
          || outboundMessage.sentAt
          || outboundMessage.status === "replied"
          || deliveryOutcome === "sent"
        )
      ) {
        to = Array.isArray(draftPayload.to) ? draftPayload.to.filter((item): item is string => typeof item === "string") : [];
        cc = Array.isArray(draftPayload.cc) ? draftPayload.cc.filter((item): item is string => typeof item === "string") : [];
        bcc = Array.isArray(draftPayload.bcc) ? draftPayload.bcc.filter((item): item is string => typeof item === "string") : [];

        await updateOutboundJobStatus(env, {
          outboundJobId: outboundJob.id,
          status: "sent",
          lastError: null,
          nextRetryAt: null,
        });

        if (draft) {
          await markDraftStatus(env, draft.id, "sent");
        }

        try {
          await settleOutboundUsageDebit(env, {
            tenantId: outboundMessage.tenantId,
            messageId: outboundJob.messageId,
            outboundJobId: outboundJob.id,
            draftId: draft?.id,
            draftCreatedVia: draft?.createdVia,
            sourceMessageId: draft?.sourceMessageId,
            to,
            cc,
            bcc,
          });
          message.ack();
        } catch (billingError) {
          await enqueueDeadLetter(env, deadLetterFromError("outbound-billing", outboundJob.id, billingError));
          message.retry();
        }
        continue;
      }

      if (
        outboundJob.status === "sending"
        && (outboundMessage.status === "failed" || deliveryOutcome === "failed")
      ) {
        await updateOutboundJobStatus(env, {
          outboundJobId: outboundJob.id,
          status: "failed",
          lastError: deliveryOutcome === "failed" ? "provider_delivery_failed" : "send_failed",
          nextRetryAt: null,
        });
        if (draft) {
          await markDraftStatus(env, draft.id, "failed").catch(() => undefined);
          to = Array.isArray(draftPayload.to) ? draftPayload.to.filter((item): item is string => typeof item === "string") : [];
          cc = Array.isArray(draftPayload.cc) ? draftPayload.cc.filter((item): item is string => typeof item === "string") : [];
          bcc = Array.isArray(draftPayload.bcc) ? draftPayload.bcc.filter((item): item is string => typeof item === "string") : [];
          await releaseOutboundUsageReservation(env, {
            tenantId: draft.tenantId,
            outboundJobId: outboundJob.id,
            sourceMessageId: draft.sourceMessageId,
            draftCreatedVia: draft.createdVia,
            to,
            cc,
            bcc,
          }).catch(() => undefined);
        }
        message.ack();
        continue;
      }

      if (outboundJob.status === "sending") {
        const sendingAgeMs = Date.now() - Date.parse(outboundJob.updatedAt);
        if (Number.isFinite(sendingAgeMs) && sendingAgeMs < getOutboundSendInDoubtGraceMs(env)) {
          message.retry();
          continue;
        }

        await updateOutboundJobStatus(env, {
          outboundJobId: outboundJob.id,
          status: "failed",
          lastError: "send_attempt_uncertain_manual_review_required",
          nextRetryAt: null,
        });
        await updateMessageStatus(env, outboundJob.messageId, "failed").catch(() => undefined);
        if (draft) {
          await markDraftStatus(env, draft.id, "failed").catch(() => undefined);
        }
        await enqueueDeadLetter(
          env,
          deadLetterFromError(
            "outbound-send",
            outboundJob.id,
            new Error("send_attempt_uncertain_manual_review_required")
          )
        );
        message.ack();
        continue;
      }

      await updateOutboundJobStatus(env, {
        outboundJobId: outboundJob.id,
        status: "sending",
        lastError: null,
      });
      const mailbox = await getMailboxById(env, outboundMessage.mailboxId);
      if (!mailbox) {
        throw new Error("Mailbox not found");
      }

      const from = typeof draftPayload.from === "string" ? draftPayload.from : "";
      to = Array.isArray(draftPayload.to) ? draftPayload.to.filter((item): item is string => typeof item === "string") : [];
      cc = Array.isArray(draftPayload.cc) ? draftPayload.cc.filter((item): item is string => typeof item === "string") : [];
      bcc = Array.isArray(draftPayload.bcc) ? draftPayload.bcc.filter((item): item is string => typeof item === "string") : [];
      const subject = typeof draftPayload.subject === "string" ? draftPayload.subject : "";
      const text = typeof draftPayload.text === "string" ? draftPayload.text : undefined;
      const html = typeof draftPayload.html === "string" ? draftPayload.html : undefined;
      const inReplyTo = typeof draftPayload.inReplyTo === "string" ? draftPayload.inReplyTo : undefined;
      const references = Array.isArray(draftPayload.references)
        ? draftPayload.references.filter((item): item is string => typeof item === "string")
        : [];
      const attachmentRefs = Array.isArray(draftPayload.attachments)
        ? draftPayload.attachments.filter((item): item is { filename?: unknown; contentType?: unknown; r2Key?: unknown } => typeof item === "object" && item !== null)
        : [];
      const suppressedRecipients = await getSuppressedRecipients(env, [...to, ...cc, ...bcc]);
      if (suppressedRecipients.length > 0) {
        const label = suppressedRecipients.length === 1 ? "recipient is" : "recipients are";
        throw new OutboundPolicyError(`Suppressed ${label} blocked: ${suppressedRecipients.join(", ")}`);
      }

      const emailTags = [
        { Name: "message_id", Value: outboundJob.messageId },
        { Name: "outbound_job_id", Value: outboundJob.id },
        { Name: "tenant_id", Value: outboundMessage.tenantId },
        { Name: "mailbox_id", Value: outboundMessage.mailboxId },
      ];

      const sendResult = await sendOutboundDraft(env, {
        from,
        to,
        cc,
        bcc,
        subject,
        text,
        html,
        inReplyTo,
        references,
        attachmentRefs,
        replyToAddresses: [mailbox.address],
        emailTags,
      });

      await markMessageSent(env, {
        messageId: outboundJob.messageId,
        providerMessageId: sendResult.messageId,
        status: "replied",
      });

      await updateOutboundJobStatus(env, {
        outboundJobId: outboundJob.id,
        status: "sent",
        lastError: null,
        nextRetryAt: null,
      });

      if (draft) {
        await markDraftStatus(env, draft.id, "sent");
      }

      try {
        await settleOutboundUsageDebit(env, {
          tenantId: outboundMessage.tenantId,
          messageId: outboundJob.messageId,
          outboundJobId: outboundJob.id,
          draftId: draft?.id,
          draftCreatedVia: draft?.createdVia,
          sourceMessageId: draft?.sourceMessageId,
          to,
          cc,
          bcc,
        });
      } catch (billingError) {
        await enqueueDeadLetter(env, deadLetterFromError("outbound-billing", outboundJob.id, billingError));
        message.retry();
        continue;
      }

      message.ack();
    } catch (error) {
      const nextRetryCount = outboundJob ? outboundJob.retryCount + 1 : undefined;
      const maxRetries = getOutboundSendMaxRetries(env);
      const exhausted = error instanceof OutboundPolicyError
        || (nextRetryCount !== undefined && nextRetryCount > maxRetries);

      await updateOutboundJobStatus(env, {
        outboundJobId: message.body.outboundJobId,
        status: exhausted ? "failed" : "retry",
        retryCount: nextRetryCount,
        lastError: error instanceof Error ? error.message : "unknown_error",
      }).catch(() => undefined);
      if (outboundJob && exhausted) {
        await updateMessageStatus(env, outboundJob.messageId, "failed").catch(() => undefined);
      }
      if (draft && exhausted) {
        await markDraftStatus(env, draft.id, "failed").catch(() => undefined);
      }
      if (outboundJob && exhausted && draft) {
        await releaseOutboundUsageReservation(env, {
          tenantId: draft.tenantId,
          outboundJobId: outboundJob.id,
          sourceMessageId: draft.sourceMessageId,
          draftCreatedVia: draft.createdVia,
          to,
          cc,
          bcc,
        }).catch(() => undefined);
      }
      await enqueueDeadLetter(env, deadLetterFromError("outbound-send", message.body.outboundJobId, error));
      if (exhausted) {
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}

function deadLetterFromError(source: string, refId: string, error: unknown): DeadLetterJob {
  return {
    source,
    refId,
    reason: error instanceof Error ? error.message : "unknown_error",
  };
}

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const normalizedQueue = normalizeQueueName(batch.queue);

  switch (normalizedQueue) {
    case "email-ingest":
      await handleEmailIngest(batch as MessageBatch<EmailIngestJob>, env);
      return;
    case "agent-execute":
      await handleAgentExecute(batch as MessageBatch<AgentExecuteJob>, env);
      return;
    case "outbound-send":
      await handleOutboundSend(batch as MessageBatch<OutboundSendJob>, env);
      return;
    default:
      for (const message of batch.messages) {
        await enqueueDeadLetter(env, {
          source: batch.queue,
          refId: "unknown",
          reason: "unsupported_queue",
        });
        message.ack();
      }
  }
}

function normalizeQueueName(queueName: string): string {
  if (queueName.endsWith("email-ingest")) {
    return "email-ingest";
  }

  if (queueName.endsWith("agent-execute")) {
    return "agent-execute";
  }

  if (queueName.endsWith("outbound-send")) {
    return "outbound-send";
  }

  if (queueName.endsWith("dead-letter")) {
    return "dead-letter";
  }

  return queueName;
}
