#!/usr/bin/env bash

set -euo pipefail

TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

npx tsc --noEmit false --outDir "$TMP_DIR/build" >/dev/null

node - <<'NODE' "$TMP_DIR/build"
import fs from "node:fs/promises";
import path from "node:path";

const buildDir = process.argv[2];

async function rewriteImports(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteImports(fullPath);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }

    const source = await fs.readFile(fullPath, "utf8");
    const rewritten = source.replace(
      /(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
      (match, prefix, specifier, suffix) => specifier.endsWith(".js") ? match : `${prefix}${specifier}.js${suffix}`
    );

    if (rewritten !== source) {
      await fs.writeFile(fullPath, rewritten);
    }
  }
}

await rewriteImports(buildDir);
NODE

node --experimental-specifier-resolution=node - <<'NODE' "$TMP_DIR/build"
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const buildDir = process.argv[2];
const mailRepoUrl = pathToFileURL(path.join(buildDir, "repositories", "mail.js")).href;
const { findThreadByInternetMessageIds, findThreadByReplyContext } = await import(mailRepoUrl);

function createEnv({ referenceMatches = [], fallbackRows = [] }) {
  return {
    D1_DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async run() {
                if (sql.includes("LEFT JOIN threads t")) {
                  const [mailboxId] = args;
                  return {
                    results: fallbackRows
                      .filter((item) => item.mailboxId === mailboxId)
                      .map((item) => ({
                        message_id: item.messageId,
                        tenant_id: item.tenantId,
                        mailbox_id: item.mailboxId,
                        thread_id: item.threadId ?? null,
                        internet_message_id: item.internetMessageId ?? null,
                        provider_message_id: item.providerMessageId ?? null,
                        to_addr: item.toAddr,
                        subject: item.subject,
                        created_at: item.createdAt ?? "2026-03-26T00:00:00.000Z",
                        thread_row_id: item.threadId ?? null,
                        thread_key: item.threadKey ?? null,
                        subject_norm: item.subjectNorm ?? null,
                        thread_status: "open",
                      })),
                  };
                }

                if (sql.includes("FROM messages m") && sql.includes("JOIN threads t") && sql.includes("m.internet_message_id = ?")) {
                  const [mailboxId, internetMessageId] = args;
                  const hit = referenceMatches.find((item) => item.mailboxId === mailboxId && item.internetMessageId === internetMessageId);
                  if (!hit) {
                    return { results: [] };
                  }

                  return {
                    results: [{
                      id: hit.threadId,
                      tenant_id: hit.tenantId,
                      mailbox_id: hit.mailboxId,
                      thread_key: hit.threadKey,
                      subject_norm: hit.subjectNorm,
                      status: "open",
                    }],
                  };
                }

                if (!sql.includes("FROM messages m")) {
                  return { results: [] };
                }

                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

const env = createEnv({
  referenceMatches: [
    {
      tenantId: "tnt_1",
      mailboxId: "mbx_1",
      internetMessageId: "<parent@example.test>",
      threadId: "thr_existing",
      threadKey: "welcome-subject",
      subjectNorm: "welcome subject",
    },
  ],
  fallbackRows: [
    {
      tenantId: "tnt_1",
      mailboxId: "mbx_1",
      messageId: "msg_outbound",
      threadId: "thr_outbound_existing",
      providerMessageId: "provider-123",
      toAddr: "sender@example.test",
      subject: "Welcome Subject",
      subjectNorm: "welcome subject",
      threadKey: "outbound:msg_outbound",
    },
  ],
});

const replyMatch = await findThreadByInternetMessageIds(env, {
  tenantId: "tnt_1",
  mailboxId: "mbx_1",
  internetMessageIds: ["<parent@example.test>", "<older@example.test>"],
});

assert.equal(replyMatch?.id, "thr_existing");

const fallbackReferenceMatch = await findThreadByInternetMessageIds(env, {
  tenantId: "tnt_1",
  mailboxId: "mbx_1",
  internetMessageIds: ["", "   ", "<missing@example.test>", "<parent@example.test>"],
});

assert.equal(fallbackReferenceMatch?.id, "thr_existing");

const missingMatch = await findThreadByInternetMessageIds(env, {
  tenantId: "tnt_1",
  mailboxId: "mbx_1",
  internetMessageIds: ["<missing@example.test>"],
});

assert.equal(missingMatch, null);

const fallbackReplyMatch = await findThreadByReplyContext(env, {
  tenantId: "tnt_1",
  mailboxId: "mbx_1",
  internetMessageIds: ["<unknown@example.test>"],
  subject: "Re: Welcome Subject",
  participantAddress: "sender@example.test",
});

assert.equal(fallbackReplyMatch?.id, "thr_outbound_existing");

const ambiguousEnv = createEnv({
  fallbackRows: [
    {
      tenantId: "tnt_1",
      mailboxId: "mbx_1",
      messageId: "msg_one",
      threadId: "thr_one",
      toAddr: "sender@example.test",
      subject: "Welcome Subject",
      subjectNorm: "welcome subject",
      threadKey: "outbound:msg_one",
    },
    {
      tenantId: "tnt_1",
      mailboxId: "mbx_1",
      messageId: "msg_two",
      threadId: "thr_two",
      toAddr: "sender@example.test",
      subject: "Welcome Subject",
      subjectNorm: "welcome subject",
      threadKey: "outbound:msg_two",
    },
  ],
});

const ambiguousFallbackMatch = await findThreadByReplyContext(ambiguousEnv, {
  tenantId: "tnt_1",
  mailboxId: "mbx_1",
  internetMessageIds: ["<unknown@example.test>"],
  subject: "Re: Welcome Subject",
  participantAddress: "sender@example.test",
});

assert.equal(ambiguousFallbackMatch, null);

console.log("reply threading regression check passed");
NODE
