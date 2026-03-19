import { createTask, updateTaskStatus } from "../repositories/mail";
import type { AgentExecutionTarget, Env } from "../types";

export async function enqueueReplayTask(
  env: Env,
  input: {
    tenantId: string;
    mailboxId: string;
    sourceMessageId: string;
    target: AgentExecutionTarget;
  },
): Promise<{ taskId: string }> {
  const replayTask = await createTask(env, {
    tenantId: input.tenantId,
    mailboxId: input.mailboxId,
    sourceMessageId: input.sourceMessageId,
    taskType: "replay",
    priority: 50,
    status: "queued",
    assignedAgent: input.target.agentId,
  });

  try {
    await env.AGENT_EXECUTE_QUEUE.send({
      taskId: replayTask.id,
      agentId: input.target.agentId,
      agentVersionId: input.target.agentVersionId,
      deploymentId: input.target.deploymentId,
    });
  } catch (error) {
    await updateTaskStatus(env, {
      taskId: replayTask.id,
      status: "failed",
    }).catch(() => undefined);
    throw error;
  }

  return { taskId: replayTask.id };
}
