import { DraftSendValidationError, ensureDraftSendAllowed } from "../lib/draft-send-guards";
import { processEmailIngestJob, recordTaskNeedsReview } from "../lib/email-ingest";
import { deliverLocallyToMailboxes } from "../lib/internal-delivery";
import {
  getOutboundRecipientRoutingValidationError,
  normalizeRecipientAddress,
  routeOutboundRecipients,
} from "../lib/local-recipient-routing";
import { sendOutboundDraft } from "../lib/outbound-provider";
import { releaseOutboundUsageReservation, settleOutboundUsageDebit } from "../lib/outbound-billing";
import { enqueueDeadLetter } from "../lib/queue";
import { nowIso } from "../lib/time";
import { getMailboxById, resolveAgentExecutionTarget } from "../repositories/agents";
import {
} from "../repositories/billing";
import {
  findThreadByReplyContext,
  claimTaskForExecution,
  deleteThreadIfUnreferenced,
  getDraftByR2KeyForOutboundLifecycle,
  getMessage,
  getOrCreateTaskForSourceMessage,
  getOrCreateThread,
  claimOutboundJobForSend,
  getOutboundJob,
  getSuppression,
  getTask,
  getTaskBySourceMessageId,
  insertAttachments,
  listDeliveryEventsByMessageId,
  markDraftStatus,
  markMessageSent,
  updateMessageStatus,
  updateTaskAssignment,
  updateTaskStatus,
  updateInboundMessageNormalized,
  updateOutboundJobStatus,
  updateThreadTimestamp,
} from "../repositories/mail";
import type { AgentExecuteJob, DeadLetterJob, EmailIngestJob, Env, OutboundSendJob } from "../types";

class OutboundPolicyError extends Error {}
class ProviderAcceptedPersistenceError extends Error {}
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
      await processEmailIngestJob(message.body, env);
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

      const task = await getTask(env, message.body.taskId);
      if (!task) {
        message.ack();
        continue;
      }

      const sourceMessage = await getMessage(env, task.sourceMessageId);
      const resolvedExecutionTarget = await resolveAgentExecutionTarget(
        env,
        task.mailboxId,
        task.assignedAgent,
        [...RECEIVE_CAPABLE_MAILBOX_ROLES],
      );
      if (resolvedExecutionTarget?.agentId && resolvedExecutionTarget.agentId !== task.assignedAgent) {
        await updateTaskAssignment(env, {
          taskId: task.id,
          assignedAgent: resolvedExecutionTarget.agentId,
        });
      }

      const reviewReason = !sourceMessage
        ? "source_message_missing"
        : !resolvedExecutionTarget
        ? "agent_assignment_unavailable"
        : resolvedExecutionTarget.agentId !== message.body.agentId
        || resolvedExecutionTarget.agentVersionId !== message.body.agentVersionId
        || resolvedExecutionTarget.deploymentId !== message.body.deploymentId
        ? "stale_queue_assignment"
        : "agent_execution_not_implemented";

      await recordTaskNeedsReview(env, {
        taskId: task.id,
        sourceMessageId: task.sourceMessageId,
        mailboxId: task.mailboxId,
        agentId: resolvedExecutionTarget?.agentId ?? task.assignedAgent ?? message.body.agentId,
        agentVersionId: resolvedExecutionTarget?.agentVersionId,
        deploymentId: resolvedExecutionTarget?.deploymentId,
        queuedAgentId: message.body.agentId,
        queuedAgentVersionId: message.body.agentVersionId,
        queuedDeploymentId: message.body.deploymentId,
        reviewReason,
        sourceMessageStatus: sourceMessage?.status ?? null,
      });

      message.ack();
    } catch (error) {
      await updateTaskStatus(env, {
        taskId: message.body.taskId,
        status: "needs_review",
        resultR2Key: null,
      }).catch(() => undefined);
      await enqueueDeadLetter(env, deadLetterFromError("agent-execute", message.body.taskId, error));
      message.ack();
    }
  }
}

async function handleOutboundSend(batch: MessageBatch<OutboundSendJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    let outboundJob = null as Awaited<ReturnType<typeof getOutboundJob>> | null;
    let draft = null as Awaited<ReturnType<typeof getDraftByR2KeyForOutboundLifecycle>> | null;
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
      draft = await getDraftByR2KeyForOutboundLifecycle(env, outboundJob.draftR2Key);
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
          if (outboundMessage.status !== "replied") {
            await updateMessageStatus(env, outboundJob.messageId, "replied");
          }
          if (draft && draft.status !== "sent") {
            await markDraftStatus(env, draft.id, "sent");
          }
        } catch (recoveryError) {
          await enqueueDeadLetter(
            env,
            deadLetterFromError(
              "outbound-send",
              outboundJob.id,
              new Error(`sent_recovery_incomplete:${recoveryError instanceof Error ? recoveryError.message : "unknown_error"}`)
            )
          );
          message.retry();
          continue;
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

        try {
          await updateMessageStatus(env, outboundJob.messageId, "replied");

          if (draft) {
            await markDraftStatus(env, draft.id, "sent");
          }

          await updateOutboundJobStatus(env, {
            outboundJobId: outboundJob.id,
            status: "sent",
            lastError: null,
            nextRetryAt: null,
          });
        } catch (recoveryError) {
          await enqueueDeadLetter(
            env,
            deadLetterFromError(
              "outbound-send",
              outboundJob.id,
              new Error(`sending_recovery_sent_incomplete:${recoveryError instanceof Error ? recoveryError.message : "unknown_error"}`)
            )
          );
          message.retry();
          continue;
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
        try {
          await updateMessageStatus(env, outboundJob.messageId, "failed");
          if (draft) {
            await markDraftStatus(env, draft.id, "failed");
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
            });
          }
          await updateOutboundJobStatus(env, {
            outboundJobId: outboundJob.id,
            status: "failed",
            lastError: deliveryOutcome === "failed" ? "provider_delivery_failed" : "send_failed",
            nextRetryAt: null,
          });
        } catch (recoveryError) {
          await enqueueDeadLetter(
            env,
            deadLetterFromError(
              "outbound-send",
              outboundJob.id,
              new Error(`sending_recovery_failed_incomplete:${recoveryError instanceof Error ? recoveryError.message : "unknown_error"}`)
            )
          );
          message.retry();
          continue;
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

        to = Array.isArray(draftPayload.to) ? draftPayload.to.filter((item): item is string => typeof item === "string") : [];
        cc = Array.isArray(draftPayload.cc) ? draftPayload.cc.filter((item): item is string => typeof item === "string") : [];
        bcc = Array.isArray(draftPayload.bcc) ? draftPayload.bcc.filter((item): item is string => typeof item === "string") : [];

        await updateOutboundJobStatus(env, {
          outboundJobId: outboundJob.id,
          status: "failed",
          lastError: "send_attempt_uncertain_manual_review_required",
          nextRetryAt: null,
        });
        await updateMessageStatus(env, outboundJob.messageId, "failed").catch(() => undefined);
        if (draft) {
          await markDraftStatus(env, draft.id, "failed").catch(() => undefined);
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

      const claimed = await claimOutboundJobForSend(env, outboundJob.id);
      if (!claimed) {
        message.ack();
        continue;
      }
      outboundJob = await getOutboundJob(env, outboundJob.id);
      if (!outboundJob) {
        throw new Error("Outbound job disappeared after claim");
      }
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
      if (draft) {
        await ensureDraftSendAllowed(env, {
          tenantId: draft.tenantId,
          agentId: draft.agentId,
          mailboxId: draft.mailboxId,
          draftR2Key: draft.draftR2Key,
          threadId: draft.threadId ?? undefined,
          sourceMessageId: draft.sourceMessageId ?? undefined,
        });
      }
      const routedRecipients = await routeOutboundRecipients(env, { to, cc, bcc });
      const internalRecipients = [
        ...routedRecipients.toInternal,
        ...routedRecipients.ccInternal,
        ...routedRecipients.bccInternal,
      ];
      const externalRecipients = [
        ...routedRecipients.toExternal,
        ...routedRecipients.ccExternal,
        ...routedRecipients.bccExternal,
      ];
      const suppressedRecipients = await getSuppressedRecipients(env, externalRecipients);
      if (suppressedRecipients.length > 0) {
        const label = suppressedRecipients.length === 1 ? "recipient is" : "recipients are";
        throw new OutboundPolicyError(`Suppressed ${label} blocked: ${suppressedRecipients.join(", ")}`);
      }
      const routingValidationError = getOutboundRecipientRoutingValidationError(routedRecipients);
      if (routingValidationError) {
        throw new OutboundPolicyError(routingValidationError);
      }

      const emailTags = [
        { Name: "message_id", Value: outboundJob.messageId },
        { Name: "outbound_job_id", Value: outboundJob.id },
        { Name: "tenant_id", Value: outboundMessage.tenantId },
        { Name: "mailbox_id", Value: outboundMessage.mailboxId },
      ];
      let providerMessageId = `internal-${outboundJob.id}`;

      if (internalRecipients.length > 0) {
        await deliverLocallyToMailboxes(env, {
          outboundJobId: outboundJob.id,
          from,
          to,
          cc,
          subject,
          text,
          html,
          inReplyTo,
          references,
          attachmentRefs,
          recipients: internalRecipients,
        });
      }

      if (externalRecipients.length > 0) {
        const sendResult = await sendOutboundDraft(env, {
          from,
          to: routedRecipients.toExternal,
          cc: routedRecipients.ccExternal,
          bcc: routedRecipients.bccExternal,
          subject,
          text,
          html,
          inReplyTo,
          references,
          attachmentRefs,
          replyToAddresses: [mailbox.address],
          emailTags,
        });
        providerMessageId = sendResult.messageId;
      }

      try {
        await updateOutboundJobStatus(env, {
          outboundJobId: outboundJob.id,
          status: "sent",
          lastError: null,
          nextRetryAt: null,
        });

        await markMessageSent(env, {
          messageId: outboundJob.messageId,
          providerMessageId,
          status: "replied",
        });

        if (draft) {
          await markDraftStatus(env, draft.id, "sent");
        }
      } catch (error) {
        await enqueueDeadLetter(
          env,
          deadLetterFromError(
            "outbound-send",
            outboundJob.id,
            new ProviderAcceptedPersistenceError(
              `provider_accepted_persistence_incomplete:${providerMessageId}:${error instanceof Error ? error.message : "unknown_error"}`
            )
          )
        );
        message.ack();
        continue;
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
        || error instanceof DraftSendValidationError
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
