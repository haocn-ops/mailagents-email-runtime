import { parseRawEmail } from "../lib/email-parser";
import { buildRawMimeMessage } from "../lib/mime";
import { enqueueDeadLetter } from "../lib/queue";
import { sendSesRawEmail, sendSesSimpleEmail } from "../lib/ses";
import { nowIso } from "../lib/time";
import { getAgentVersion, getMailboxById, resolveAgentExecutionTarget } from "../repositories/agents";
import {
  createTask,
  getDraftByR2Key,
  getMessage,
  getOrCreateThread,
  getOutboundJob,
  insertAttachments,
  markDraftStatus,
  markMessageSent,
  updateTaskStatus,
  updateInboundMessageNormalized,
  updateOutboundJobStatus,
  updateThreadTimestamp,
} from "../repositories/mail";
import type { AgentExecuteJob, DeadLetterJob, EmailIngestJob, Env, OutboundSendJob } from "../types";

async function handleEmailIngest(batch: MessageBatch<EmailIngestJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const rawObject = await env.R2_EMAIL.get(message.body.rawR2Key);
      if (!rawObject) {
        throw new Error("Raw email object not found");
      }

      const rawText = await rawObject.text();
      const parsed = parseRawEmail(rawText);
      const thread = await getOrCreateThread(env, {
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
        status: "normalized",
      });
      await updateThreadTimestamp(env, thread.id);

      const attachmentRows = [];
      for (const attachment of parsed.attachments) {
        const r2Key = `attachments/${message.body.messageId}/${attachment.id}`;
        await env.R2_EMAIL.put(r2Key, attachment.content, {
          httpMetadata: { contentType: attachment.contentType ?? "application/octet-stream" },
        });
        attachmentRows.push({
          id: attachment.id,
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

      const executionTarget = await resolveAgentExecutionTarget(env, message.body.mailboxId);
      const task = await createTask(env, {
        tenantId: message.body.tenantId,
        mailboxId: message.body.mailboxId,
        sourceMessageId: message.body.messageId,
        taskType: "reply",
        priority: 50,
        status: "queued",
        assignedAgent: executionTarget?.agentId,
      });

      await env.D1_DB.prepare(
        "UPDATE messages SET status = ? WHERE id = ?"
      ).bind("tasked", message.body.messageId).run();

      if (executionTarget) {
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
      await updateTaskStatus(env, {
        taskId: message.body.taskId,
        status: "running",
      });

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
    try {
      outboundJob = await getOutboundJob(env, message.body.outboundJobId);
      if (!outboundJob) {
        throw new Error("Outbound job not found");
      }

      await updateOutboundJobStatus(env, {
        outboundJobId: outboundJob.id,
        status: "sending",
        lastError: null,
      });

      const draftObject = await env.R2_EMAIL.get(outboundJob.draftR2Key);
      if (!draftObject) {
        throw new Error("Draft payload not found in R2");
      }

      const draftPayload = await draftObject.json<Record<string, unknown>>();
      const draft = await getDraftByR2Key(env, outboundJob.draftR2Key);
      const outboundMessage = await getMessage(env, outboundJob.messageId);
      if (!outboundMessage) {
        throw new Error("Outbound message not found");
      }
      const mailbox = await getMailboxById(env, outboundMessage.mailboxId);
      if (!mailbox) {
        throw new Error("Mailbox not found");
      }

      const from = typeof draftPayload.from === "string" ? draftPayload.from : "";
      const to = Array.isArray(draftPayload.to) ? draftPayload.to.filter((item): item is string => typeof item === "string") : [];
      const cc = Array.isArray(draftPayload.cc) ? draftPayload.cc.filter((item): item is string => typeof item === "string") : [];
      const bcc = Array.isArray(draftPayload.bcc) ? draftPayload.bcc.filter((item): item is string => typeof item === "string") : [];
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

      const emailTags = [
        { Name: "message_id", Value: outboundJob.messageId },
        { Name: "outbound_job_id", Value: outboundJob.id },
        { Name: "tenant_id", Value: outboundMessage.tenantId },
        { Name: "mailbox_id", Value: outboundMessage.mailboxId },
      ];

      const shouldUseRaw = Boolean(inReplyTo || references.length > 0 || attachmentRefs.length > 0);

      const sendResult = shouldUseRaw
        ? await sendRawDraft(env, {
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
            configurationSetName: env.SES_CONFIGURATION_SET,
            emailTags,
          })
        : await sendSesSimpleEmail(env, {
            from,
            to,
            cc,
            bcc,
            subject,
            text,
            html,
            replyToAddresses: [mailbox.address],
            configurationSetName: env.SES_CONFIGURATION_SET,
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

      message.ack();
    } catch (error) {
      await updateOutboundJobStatus(env, {
        outboundJobId: message.body.outboundJobId,
        status: "retry",
        retryCount: outboundJob ? outboundJob.retryCount + 1 : undefined,
        lastError: error instanceof Error ? error.message : "unknown_error",
      }).catch(() => undefined);
      await enqueueDeadLetter(env, deadLetterFromError("outbound-send", message.body.outboundJobId, error));
      message.retry();
    }
  }
}

async function sendRawDraft(env: Env, input: {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references: string[];
  attachmentRefs: Array<{ filename?: unknown; contentType?: unknown; r2Key?: unknown }>;
  replyToAddresses: string[];
  configurationSetName: string;
  emailTags: Array<{ Name: string; Value: string }>;
}) {
  const attachments = [];
  for (const ref of input.attachmentRefs) {
    const r2Key = typeof ref.r2Key === "string" ? ref.r2Key : "";
    if (!r2Key) {
      continue;
    }

    const object = await env.R2_EMAIL.get(r2Key);
    if (!object) {
      throw new Error(`Attachment not found in R2: ${r2Key}`);
    }

    attachments.push({
      filename: typeof ref.filename === "string" ? ref.filename : r2Key.split("/").pop() ?? "attachment.bin",
      contentType: typeof ref.contentType === "string" ? ref.contentType : object.httpMetadata?.contentType ?? "application/octet-stream",
      content: new Uint8Array(await object.arrayBuffer()),
    });
  }

  const rawData = buildRawMimeMessage({
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    replyTo: input.replyToAddresses,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments,
  });

  return await sendSesRawEmail(env, {
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    rawData,
    configurationSetName: input.configurationSetName,
    emailTags: input.emailTags,
  });
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
