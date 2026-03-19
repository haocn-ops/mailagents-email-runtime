#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const wranglerHome = path.resolve(process.cwd(), ".wrangler/backfill-home");
const wranglerConfigHome = path.join(wranglerHome, ".config");

const ENVIRONMENTS = {
  local: {
    database: "mailagents-local",
    bucket: "mailagents-local-email",
    wranglerArgs: ["--local"],
  },
  dev: {
    database: "mailagents-dev",
    bucket: "mailagents-dev-email",
    wranglerArgs: ["--remote", "--env", "dev"],
  },
  staging: {
    database: "mailagents-staging",
    bucket: "mailagents-staging-email",
    wranglerArgs: ["--remote", "--env", "staging"],
  },
  production: {
    database: "mailagents-production",
    bucket: "mailagents-production-email",
    wranglerArgs: ["--remote", "--env", "production"],
  },
};

function parseArgs(argv) {
  const options = {
    env: "local",
    mode: "dry-run",
    limit: 100,
    mailbox: undefined,
    messageId: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--env":
        options.env = argv[index + 1] ?? options.env;
        index += 1;
        break;
      case "--apply":
        options.mode = "apply";
        break;
      case "--dry-run":
        options.mode = "dry-run";
        break;
      case "--limit":
        options.limit = Number.parseInt(argv[index + 1] ?? `${options.limit}`, 10);
        index += 1;
        break;
      case "--mailbox":
        options.mailbox = argv[index + 1] ?? undefined;
        index += 1;
        break;
      case "--message-id":
        options.messageId = argv[index + 1] ?? undefined;
        index += 1;
        break;
      default:
        if (token.startsWith("--")) {
          throw new Error(`Unknown argument: ${token}`);
        }
    }
  }

  if (!ENVIRONMENTS[options.env]) {
    throw new Error(`Unsupported env: ${options.env}`);
  }

  if (!Number.isFinite(options.limit) || options.limit <= 0) {
    throw new Error(`Invalid limit: ${options.limit}`);
  }

  return options;
}

async function runWrangler(args, { allowFailure = false } = {}) {
  try {
    await mkdir(wranglerConfigHome, { recursive: true });
    const { stdout, stderr } = await execFileAsync("wrangler", args, {
      cwd: process.cwd(),
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: wranglerHome,
        XDG_CONFIG_HOME: wranglerConfigHome,
      },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const stdout = error.stdout ?? "";
    const stderr = error.stderr ?? "";

    if (allowFailure) {
      return {
        stdout,
        stderr: stderr || error.message,
        code: error.code ?? 1,
      };
    }

    const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    throw new Error(details ? `${error.message}\n${details}` : error.message);
  }
}

async function queryMessages(config, options) {
  const conditions = [
    "direction = 'inbound'",
    "raw_r2_key IS NOT NULL",
    "subject LIKE '=?%'",
  ];

  if (options.mailbox) {
    conditions.push(`mailbox_id = '${escapeSqlString(options.mailbox)}'`);
  }

  if (options.messageId) {
    conditions.push(`id = '${escapeSqlString(options.messageId)}'`);
  }

  const sql = `
    SELECT id, mailbox_id, subject, raw_r2_key, created_at
    FROM messages
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ${options.limit}
  `;

  const result = await runWrangler([
    "d1",
    "execute",
    config.database,
    ...config.wranglerArgs,
    "--json",
    "--command",
    sql,
  ]);

  const parsed = JSON.parse(result.stdout);
  return parsed?.[0]?.results ?? [];
}

async function fetchRawEmail(config, rawR2Key) {
  const result = await runWrangler([
    "r2",
    "object",
    "get",
    `${config.bucket}/${rawR2Key}`,
    ...config.wranglerArgs,
    "--pipe",
  ]);

  return result.stdout;
}

function escapeSqlString(value) {
  return value.replaceAll("'", "''");
}

function parseHeadersBlock(rawHeaders) {
  const unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, " ");
  const headers = {};

  for (const line of unfolded.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[key] = value;
  }

  return headers;
}

function extractRawSubject(rawEmail) {
  const marker = rawEmail.search(/\r?\n\r?\n/);
  const rawHeaders = marker === -1 ? rawEmail : rawEmail.slice(0, marker);
  return parseHeadersBlock(rawHeaders).subject;
}

function decodeQuotedPrintableBytes(input) {
  const bytes = [];

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === "=" && /^[A-Fa-f0-9]{2}$/.test(input.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(input.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    bytes.push(char.charCodeAt(0));
  }

  return Uint8Array.from(bytes);
}

function decodeHeaderEncodedWord(input) {
  const collapsed = input.replace(
    /(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?[^?]*\?=)/g,
    "$1"
  );

  return collapsed.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, value) => {
    try {
      const normalizedCharset = charset.trim().toLowerCase();
      const decoder = new TextDecoder(
        normalizedCharset === "utf8" ? "utf-8" : normalizedCharset,
        { fatal: false, ignoreBOM: false }
      );

      if (encoding.toLowerCase() === "b") {
        const binary = atob(value.replace(/\s+/g, ""));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return decoder.decode(bytes);
      }

      const qValue = value.replace(/_/g, " ");
      return decoder.decode(decodeQuotedPrintableBytes(qValue));
    } catch {
      return match;
    }
  });
}

async function updateSubject(config, messageId, subject) {
  const sql = `
    UPDATE messages
    SET subject = '${escapeSqlString(subject)}'
    WHERE id = '${escapeSqlString(messageId)}'
  `;

  await runWrangler([
    "d1",
    "execute",
    config.database,
    ...config.wranglerArgs,
    "--yes",
    "--command",
    sql,
  ]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = ENVIRONMENTS[options.env];
  const rows = await queryMessages(config, options);
  const updates = [];

  for (const row of rows) {
    const rawSubject = row.subject;
    if (!rawSubject || !rawSubject.startsWith("=?")) {
      continue;
    }

    const rawEmail = await fetchRawEmail(config, row.raw_r2_key);
    const sourceSubject = extractRawSubject(rawEmail);
    const decodedSubject = sourceSubject ? decodeHeaderEncodedWord(sourceSubject) : undefined;

    if (!decodedSubject || decodedSubject === rawSubject) {
      continue;
    }

    updates.push({
      id: row.id,
      mailboxId: row.mailbox_id,
      createdAt: row.created_at,
      currentSubject: rawSubject,
      decodedSubject,
    });
  }

  console.log(JSON.stringify({
    env: options.env,
    mode: options.mode,
    scanned: rows.length,
    updates: updates.length,
    items: updates,
  }, null, 2));

  if (options.mode !== "apply") {
    return;
  }

  for (const item of updates) {
    await updateSubject(config, item.id, item.decodedSubject);
  }

  console.log(`Applied ${updates.length} subject updates in ${options.env}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
