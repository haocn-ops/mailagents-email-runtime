#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createPrivateKey, randomBytes, sign as cryptoSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const DEFAULT_CDP_KEY_PATH =
  process.env.CDP_API_KEY_JSON_PATH || resolve(REPO_ROOT, ".secrets/cdp_api_key.json");
const DEFAULT_WALLET_JSON_PATH =
  process.env.WALLET_JSON_PATH || resolve(REPO_ROOT, ".secrets/dev-base-sepolia-wallet.json");
const DEFAULT_HOST = process.env.CDP_API_HOST || "api.cdp.coinbase.com";
const DEFAULT_NETWORK = process.env.FAUCET_NETWORK || "base-sepolia";
const DEFAULT_TOKENS = parseTokenList(process.env.FAUCET_TOKENS || "usdc");

function usage() {
  console.log(`Usage:
  node ./scripts/request_cdp_faucet.mjs [options]

Options:
  --token <symbol>           Token to request. Repeatable. Default: usdc
  --address <0x...>          Destination EVM address
  --network <name>           Faucet network. Default: base-sepolia
  --wallet-json-path <path>  Wallet JSON used to infer the address
  --cdp-key-path <path>      CDP API key JSON path
  --host <host>              CDP API host. Default: api.cdp.coinbase.com
  --balances-only            Only fetch balances, do not request faucet funds
  --with-balances            Print balances before and after faucet requests
  --dry-run                  Print planned requests without calling CDP
  --json                     Emit machine-readable JSON
  --help                     Show this help

Examples:
  npm run faucet:cdp -- --token usdc
  npm run faucet:cdp -- --token eth --token usdc --with-balances
  npm run faucet:cdp -- --balances-only
`);
}

function parseTokenList(value) {
  return [...new Set(
    String(value)
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  )];
}

function parseArgs(argv) {
  const options = {
    tokens: [],
    network: DEFAULT_NETWORK,
    host: DEFAULT_HOST,
    walletJsonPath: DEFAULT_WALLET_JSON_PATH,
    cdpKeyPath: DEFAULT_CDP_KEY_PATH,
    address: process.env.FAUCET_ADDRESS || "",
    balancesOnly: false,
    withBalances: false,
    dryRun: false,
    json: false,
    help: false,
  };
  let explicitTokenProvided = false;

  const nextValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--token") {
      explicitTokenProvided = true;
      options.tokens.push(nextValue(i, arg).toLowerCase());
      i += 1;
      continue;
    }

    if (arg === "--network") {
      options.network = nextValue(i, arg);
      i += 1;
      continue;
    }

    if (arg === "--address") {
      options.address = nextValue(i, arg);
      i += 1;
      continue;
    }

    if (arg === "--wallet-json-path") {
      options.walletJsonPath = resolve(nextValue(i, arg));
      i += 1;
      continue;
    }

    if (arg === "--cdp-key-path") {
      options.cdpKeyPath = resolve(nextValue(i, arg));
      i += 1;
      continue;
    }

    if (arg === "--host") {
      options.host = nextValue(i, arg);
      i += 1;
      continue;
    }

    if (arg === "--balances-only") {
      options.balancesOnly = true;
      continue;
    }

    if (arg === "--with-balances") {
      options.withBalances = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--help") {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  options.tokens = [
    ...new Set((explicitTokenProvided ? options.tokens : DEFAULT_TOKENS).map((token) => token.toLowerCase())),
  ];
  return options;
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString("base64url");
}

function validateAddress(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`Invalid EVM address: ${address}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function resolveAddress(address, walletJsonPath) {
  if (address) {
    validateAddress(address);
    return address;
  }

  const wallet = await readJson(walletJsonPath);
  if (!wallet.address) {
    throw new Error(`Wallet JSON missing address: ${walletJsonPath}`);
  }

  validateAddress(wallet.address);
  return wallet.address;
}

function createSigningKey(privateKeyValue) {
  if (privateKeyValue.includes("BEGIN")) {
    const key = createPrivateKey(privateKeyValue);
    if (key.asymmetricKeyType === "ec") {
      return { alg: "ES256", key };
    }
    if (key.asymmetricKeyType === "ed25519") {
      return { alg: "EdDSA", key };
    }
    throw new Error(`Unsupported PEM key type: ${key.asymmetricKeyType || "unknown"}`);
  }

  const decoded = Buffer.from(privateKeyValue, "base64");
  if (decoded.length !== 64) {
    throw new Error("Invalid Ed25519 secret: expected base64-decoded length 64");
  }

  const seed = decoded.subarray(0, 32);
  const publicKey = decoded.subarray(32);
  const key = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: seed.toString("base64url"),
      x: publicKey.toString("base64url"),
    },
    format: "jwk",
  });

  return { alg: "EdDSA", key };
}

function generateJwt({ apiKeyId, apiKeySecret, method, host, path, expiresIn = 120 }) {
  const { alg, key } = createSigningKey(apiKeySecret);
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg,
    kid: apiKeyId,
    typ: "JWT",
    nonce: randomBytes(16).toString("hex"),
  };
  const payload = {
    sub: apiKeyId,
    iss: "cdp",
    aud: ["cdp_service"],
    uris: [`${method.toUpperCase()} ${host}${path}`],
    iat: now,
    nbf: now,
    exp: now + expiresIn,
  };

  const signingInput =
    `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature =
    alg === "ES256"
      ? cryptoSign("sha256", Buffer.from(signingInput), {
          key,
          dsaEncoding: "ieee-p1363",
        })
      : cryptoSign(null, Buffer.from(signingInput), key);

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function cdpRequest({ apiKeyId, apiKeySecret, host, method, path, body }) {
  const jwt = generateJwt({
    apiKeyId,
    apiKeySecret,
    method,
    host,
    path,
  });

  const response = await fetch(`https://${host}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json = null;

  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    json,
    text,
  };
}

function normalizeBalanceEntry(entry) {
  return {
    symbol: entry?.token?.symbol || null,
    name: entry?.token?.name || null,
    network: entry?.token?.network || null,
    contractAddress: entry?.token?.contractAddress || null,
    amountAtomic: entry?.amount?.amount || null,
    decimals: entry?.amount?.decimals ?? null,
  };
}

function filterBalances(balances, tokens) {
  if (!Array.isArray(balances)) {
    return [];
  }

  const wanted = new Set(tokens.map((token) => token.toUpperCase()));
  return balances
    .map(normalizeBalanceEntry)
    .filter((entry) => !wanted.size || wanted.has(String(entry.symbol || "").toUpperCase()));
}

function summarizeError(result) {
  return (
    result.json?.errorMessage ||
    result.json?.error ||
    result.json?.message ||
    result.text ||
    `HTTP ${result.status}`
  );
}

function maskKeyId(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return value;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function printHumanSummary(summary) {
  console.log(`address: ${summary.address}`);
  console.log(`network: ${summary.network}`);
  console.log(`cdpKeyId: ${maskKeyId(summary.cdpKeyId)}`);

  if (summary.beforeBalances) {
    console.log("balances_before:");
    for (const balance of summary.beforeBalances) {
      console.log(
        `  - ${balance.symbol || "?"}: amount=${balance.amountAtomic} decimals=${balance.decimals}`,
      );
    }
  }

  if (summary.requests.length) {
    console.log("requests:");
    for (const request of summary.requests) {
      if (request.dryRun) {
        console.log(`  - ${request.token}: dry-run`);
        continue;
      }
      console.log(
        `  - ${request.token}: status=${request.status}` +
          (request.transactionHash ? ` tx=${request.transactionHash}` : "") +
          (request.error ? ` error=${request.error}` : ""),
      );
    }
  }

  if (summary.afterBalances) {
    console.log("balances_after:");
    for (const balance of summary.afterBalances) {
      console.log(
        `  - ${balance.symbol || "?"}: amount=${balance.amountAtomic} decimals=${balance.decimals}`,
      );
    }
  }
}

async function loadCdpKey(path) {
  const payload = await readJson(path);
  if (!payload.id || !payload.privateKey) {
    throw new Error(`CDP key JSON must include id and privateKey: ${path}`);
  }
  return payload;
}

async function fetchBalances({ apiKeyId, apiKeySecret, host, network, address, tokens }) {
  const result = await cdpRequest({
    apiKeyId,
    apiKeySecret,
    host,
    method: "GET",
    path: `/platform/v2/evm/token-balances/${network}/${address}`,
  });

  if (!result.ok) {
    throw new Error(`Failed to fetch balances: ${summarizeError(result)}`);
  }

  return filterBalances(result.json?.balances || [], tokens);
}

async function requestFaucet({ apiKeyId, apiKeySecret, host, network, address, token }) {
  const result = await cdpRequest({
    apiKeyId,
    apiKeySecret,
    host,
    method: "POST",
    path: "/platform/v2/evm/faucet",
    body: {
      network,
      address,
      token,
    },
  });

  return {
    token,
    status: result.status,
    ok: result.ok,
    transactionHash: result.json?.transactionHash || null,
    error: result.ok ? null : summarizeError(result),
    response: result.json || result.text || null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    usage();
    return;
  }

  const cdpKey = await loadCdpKey(options.cdpKeyPath);
  const address = await resolveAddress(options.address, options.walletJsonPath);
  const tokens = options.balancesOnly ? [] : options.tokens;

  if (!options.balancesOnly && tokens.length === 0) {
    throw new Error("At least one --token is required unless --balances-only is set");
  }

  const summary = {
    address,
    network: options.network,
    cdpKeyId: cdpKey.id,
    beforeBalances: null,
    requests: [],
    afterBalances: null,
  };

  if (options.withBalances || options.balancesOnly) {
    summary.beforeBalances = await fetchBalances({
      apiKeyId: cdpKey.id,
      apiKeySecret: cdpKey.privateKey,
      host: options.host,
      network: options.network,
      address,
      tokens: options.balancesOnly ? [] : tokens,
    });
  }

  if (!options.balancesOnly) {
    for (const token of tokens) {
      if (options.dryRun) {
        summary.requests.push({
          token,
          dryRun: true,
          path: "/platform/v2/evm/faucet",
          body: {
            network: options.network,
            address,
            token,
          },
        });
        continue;
      }

      const result = await requestFaucet({
        apiKeyId: cdpKey.id,
        apiKeySecret: cdpKey.privateKey,
        host: options.host,
        network: options.network,
        address,
        token,
      });
      summary.requests.push(result);
    }
  }

  if (options.withBalances || options.balancesOnly) {
    summary.afterBalances = await fetchBalances({
      apiKeyId: cdpKey.id,
      apiKeySecret: cdpKey.privateKey,
      host: options.host,
      network: options.network,
      address,
      tokens: options.balancesOnly ? [] : tokens,
    });
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  printHumanSummary(summary);

  const failed = summary.requests.find((request) => request.ok === false);
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
