import { notFound } from "./lib/http";
import { handleEmail } from "./handlers/email";
import { handleQueue } from "./handlers/queues";
import { handleScheduled } from "./handlers/scheduled";
import {
  cleanupRedundantMailboxWorkerRules,
  ensureManagedContactAliasMailboxes,
  ensureManagedContactAliasRouting,
  shouldBootstrapContactAliasRouting,
} from "./lib/contact-aliases";
import { withSecurityHeaders, redirectToHttps } from "./lib/transport-security";
import { handleApiRequest } from "./routes/api";
import { handleMcpRequest } from "./routes/mcp";
import { handleSiteRequest } from "./routes/site";
import type { Env } from "./types";

let contactAliasRoutingBootstrapPromise: Promise<void> | null = null;
let contactAliasMailboxBootstrapPromise: Promise<void> | null = null;
let redundantMailboxRuleCleanupPromise: Promise<void> | null = null;

function ensureContactAliasMailboxesBootstrapped(env: Env): Promise<void> {
  if (!shouldBootstrapContactAliasRouting(env)) {
    return Promise.resolve();
  }

  if (!contactAliasMailboxBootstrapPromise) {
    contactAliasMailboxBootstrapPromise = ensureManagedContactAliasMailboxes(env).catch((error) => {
      contactAliasMailboxBootstrapPromise = null;
      throw error;
    });
  }

  return contactAliasMailboxBootstrapPromise;
}

function ensureContactAliasRoutingBootstrapped(env: Env): Promise<void> {
  if (!shouldBootstrapContactAliasRouting(env)) {
    return Promise.resolve();
  }

  if (!contactAliasRoutingBootstrapPromise) {
    contactAliasRoutingBootstrapPromise = ensureManagedContactAliasRouting(env).catch((error) => {
      contactAliasRoutingBootstrapPromise = null;
      throw error;
    });
  }

  return contactAliasRoutingBootstrapPromise;
}

function ensureRedundantMailboxRulesCleaned(env: Env): Promise<void> {
  if (!shouldBootstrapContactAliasRouting(env)) {
    return Promise.resolve();
  }

  if (!redundantMailboxRuleCleanupPromise) {
    redundantMailboxRuleCleanupPromise = cleanupRedundantMailboxWorkerRules(env).catch((error) => {
      redundantMailboxRuleCleanupPromise = null;
      throw error;
    });
  }

  return redundantMailboxRuleCleanupPromise;
}

function logContactAliasMaintenanceError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`[contact-aliases] ${operation} failed: ${reason}`);
}

function scheduleContactAliasMaintenance(env: Env, ctx?: ExecutionContext): void {
  if (!shouldBootstrapContactAliasRouting(env)) {
    return;
  }

  const maintenance = ensureContactAliasMailboxesBootstrapped(env)
    .then(async () => {
      await Promise.all([
        ensureContactAliasRoutingBootstrapped(env),
        ensureRedundantMailboxRulesCleaned(env),
      ]);
    })
    .catch((error) => {
      logContactAliasMaintenanceError("bootstrap", error);
    });

  if (ctx) {
    ctx.waitUntil(maintenance);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    scheduleContactAliasMaintenance(env, ctx);

    const httpsRedirect = redirectToHttps(request);
    if (httpsRedirect) {
      return httpsRedirect;
    }

    const mcpResponse = await handleMcpRequest(request, env, ctx);
    if (mcpResponse) {
      return withSecurityHeaders(mcpResponse, request);
    }

    const siteResponse = await handleSiteRequest(request, env, ctx);
    if (siteResponse) {
      return withSecurityHeaders(siteResponse, request);
    }

    const response = await handleApiRequest(request, env, ctx);
    return withSecurityHeaders(response ?? notFound(), request);
  },

  async email(message: Parameters<typeof handleEmail>[0], env: Env): Promise<void> {
    scheduleContactAliasMaintenance(env);
    await handleEmail(message, env);
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    scheduleContactAliasMaintenance(env);
    await handleQueue(batch, env);
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    scheduleContactAliasMaintenance(env);
    await handleScheduled(event, env);
  },
};
