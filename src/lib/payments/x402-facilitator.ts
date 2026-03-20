import type { Env } from "../../types";
import type { X402PaymentRequirement } from "./x402";

const DEFAULT_VERIFY_PATH = "/verify";
const DEFAULT_SETTLE_PATH = "/settle";
const LOCAL_MOCK_FACILITATOR_URL = "mock://local";

export interface X402FacilitatorConfig {
  baseUrl: string;
  verifyUrl: string;
  settleUrl: string;
  authToken?: string;
}

export interface X402FacilitatorVerificationSuccess {
  type: "verify";
  isValid: true;
  scheme: string;
  network: string;
  asset?: string;
  resource?: string;
  paymentReference?: string;
  raw?: Record<string, unknown>;
}

export interface X402FacilitatorVerificationFailure {
  type: "verify";
  isValid: false;
  scheme: string;
  network: string;
  error: string;
  paymentReference?: string;
  raw?: Record<string, unknown>;
}

export type X402FacilitatorVerificationResponse =
  | X402FacilitatorVerificationSuccess
  | X402FacilitatorVerificationFailure;

export interface X402FacilitatorSettlementSuccess {
  type: "settle";
  settled: true;
  scheme: string;
  network: string;
  asset?: string;
  amount?: string;
  settlementReference?: string;
  transactionHash?: string;
  raw?: Record<string, unknown>;
}

export interface X402FacilitatorSettlementFailure {
  type: "settle";
  settled: false;
  scheme: string;
  network: string;
  error: string;
  settlementReference?: string;
  raw?: Record<string, unknown>;
}

export type X402FacilitatorSettlementResponse =
  | X402FacilitatorSettlementSuccess
  | X402FacilitatorSettlementFailure;

interface X402FacilitatorBaseResult<TResponse> {
  status: number;
  response: TResponse;
}

export type X402FacilitatorVerificationResult =
  | (X402FacilitatorBaseResult<X402FacilitatorVerificationSuccess> & {
    ok: true;
    paymentReference?: string;
  })
  | (X402FacilitatorBaseResult<X402FacilitatorVerificationFailure> & {
    ok: false;
    error: string;
    paymentReference?: string;
  });

export type X402FacilitatorSettlementResult =
  | (X402FacilitatorBaseResult<X402FacilitatorSettlementSuccess> & {
    ok: true;
    settlementReference?: string;
  })
  | (X402FacilitatorBaseResult<X402FacilitatorSettlementFailure> & {
    ok: false;
    error: string;
    settlementReference?: string;
  });

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isLocalMockUrl(value: string | undefined): boolean {
  return value?.trim() === LOCAL_MOCK_FACILITATOR_URL;
}

function normalizePath(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractErrorMessage(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) {
    return undefined;
  }

  for (const key of ["error", "message", "reason"]) {
    const value = asString(data[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function extractReference(data: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!data) {
    return undefined;
  }

  for (const key of keys) {
    const value = asString(data[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

async function parseFacilitatorResponse(response: Response): Promise<Record<string, unknown> | undefined> {
  const raw = await response.text();
  if (!raw.trim()) {
    return undefined;
  }

  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return { raw };
  }
}

function buildRequestHeaders(config: X402FacilitatorConfig): Headers {
  const headers = new Headers({
    "content-type": "application/json",
  });

  if (config.authToken) {
    headers.set("authorization", `Bearer ${config.authToken}`);
  }

  return headers;
}

async function postToFacilitator(
  url: string,
  config: X402FacilitatorConfig,
  body: Record<string, unknown>,
): Promise<{ status: number; data?: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: buildRequestHeaders(config),
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    data: await parseFacilitatorResponse(response),
  };
}

function mockDecision(value: string | undefined, successKeyword: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return normalized === successKeyword;
}

function mockReference(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function buildMockVerifyResult(env: Env, input: {
  paymentPayload: Record<string, unknown> | string;
  paymentRequirements: X402PaymentRequirement;
}): X402FacilitatorVerificationResult {
  if (!mockDecision(env.X402_FACILITATOR_MOCK_VERIFY_RESULT, "valid")) {
    return {
      ok: false,
      status: 402,
      error: "Mock facilitator rejected the payment payload during verification",
      paymentReference: undefined,
      response: {
        type: "verify",
        isValid: false,
        scheme: input.paymentRequirements.scheme,
        network: input.paymentRequirements.network,
        error: "Mock facilitator rejected the payment payload during verification",
        raw: {
          isValid: false,
          error: "Mock facilitator rejected the payment payload during verification",
          scheme: input.paymentRequirements.scheme,
          network: input.paymentRequirements.network,
        },
      },
    };
  }

  const paymentReference = mockReference("pay");
  return {
    ok: true,
    status: 200,
    paymentReference,
    response: {
      type: "verify",
      isValid: true,
      scheme: input.paymentRequirements.scheme,
      network: input.paymentRequirements.network,
      asset: input.paymentRequirements.asset,
      resource: input.paymentRequirements.resource,
      paymentReference,
      raw: {
        isValid: true,
        scheme: input.paymentRequirements.scheme,
        network: input.paymentRequirements.network,
        asset: input.paymentRequirements.asset,
        resource: input.paymentRequirements.resource,
        paymentPayload: typeof input.paymentPayload === "string" ? input.paymentPayload : "object",
        paymentReference,
      },
    },
  };
}

function buildMockSettleResult(env: Env, input: {
  paymentRequirements: X402PaymentRequirement;
}): X402FacilitatorSettlementResult {
  if (!mockDecision(env.X402_FACILITATOR_MOCK_SETTLE_RESULT, "success")) {
    return {
      ok: false,
      status: 402,
      error: "Mock facilitator rejected the payment during settlement",
      settlementReference: undefined,
      response: {
        type: "settle",
        settled: false,
        scheme: input.paymentRequirements.scheme,
        network: input.paymentRequirements.network,
        error: "Mock facilitator rejected the payment during settlement",
        raw: {
          settled: false,
          error: "Mock facilitator rejected the payment during settlement",
          scheme: input.paymentRequirements.scheme,
          network: input.paymentRequirements.network,
        },
      },
    };
  }

  const settlementReference = mockReference("stl");
  const transactionHash = mockReference("tx");
  return {
    ok: true,
    status: 200,
    settlementReference,
    response: {
      type: "settle",
      settled: true,
      scheme: input.paymentRequirements.scheme,
      network: input.paymentRequirements.network,
      asset: input.paymentRequirements.asset,
      amount: input.paymentRequirements.maxAmountRequired,
      settlementReference,
      transactionHash,
      raw: {
        settled: true,
        scheme: input.paymentRequirements.scheme,
        network: input.paymentRequirements.network,
        asset: input.paymentRequirements.asset,
        amount: input.paymentRequirements.maxAmountRequired,
        transactionHash,
        settlementReference,
      },
    },
  };
}

function parseVerifyDecision(data: Record<string, unknown> | undefined, status: number): boolean {
  if (typeof data?.isValid === "boolean") {
    return data.isValid;
  }
  if (typeof data?.valid === "boolean") {
    return data.valid;
  }
  if (typeof data?.verified === "boolean") {
    return data.verified;
  }
  if (typeof data?.success === "boolean") {
    return data.success;
  }
  return status >= 200 && status < 300;
}

function parseSettleDecision(data: Record<string, unknown> | undefined, status: number): boolean {
  if (typeof data?.settled === "boolean") {
    return data.settled;
  }
  if (typeof data?.success === "boolean") {
    return data.success;
  }
  return status >= 200 && status < 300;
}

function normalizeVerificationResponse(
  input: {
    data?: Record<string, unknown>;
    status: number;
    paymentRequirements: X402PaymentRequirement;
  },
): X402FacilitatorVerificationResult {
  const paymentReference = extractReference(input.data, ["paymentReference", "paymentId", "reference"]);
  const scheme = asString(input.data?.scheme) ?? input.paymentRequirements.scheme;
  const network = asString(input.data?.network) ?? input.paymentRequirements.network;
  const isValid = parseVerifyDecision(input.data, input.status);

  if (!isValid) {
    const error = extractErrorMessage(input.data) ?? `Facilitator verification failed with status ${input.status}`;
    return {
      ok: false,
      status: input.status,
      error,
      paymentReference,
      response: {
        type: "verify",
        isValid: false,
        scheme,
        network,
        error,
        paymentReference,
        raw: input.data,
      },
    };
  }

  return {
    ok: true,
    status: input.status,
    paymentReference,
    response: {
      type: "verify",
      isValid: true,
      scheme,
      network,
      asset: asString(input.data?.asset) ?? input.paymentRequirements.asset,
      resource: asString(input.data?.resource) ?? input.paymentRequirements.resource,
      paymentReference,
      raw: input.data,
    },
  };
}

function normalizeSettlementResponse(
  input: {
    data?: Record<string, unknown>;
    status: number;
    paymentRequirements: X402PaymentRequirement;
  },
): X402FacilitatorSettlementResult {
  const settlementReference = extractReference(input.data, [
    "settlementReference",
    "transactionHash",
    "txHash",
    "signature",
    "reference",
    "id",
  ]);
  const scheme = asString(input.data?.scheme) ?? input.paymentRequirements.scheme;
  const network = asString(input.data?.network) ?? input.paymentRequirements.network;
  const settled = parseSettleDecision(input.data, input.status);

  if (!settled) {
    const error = extractErrorMessage(input.data) ?? `Facilitator settlement failed with status ${input.status}`;
    return {
      ok: false,
      status: input.status,
      error,
      settlementReference,
      response: {
        type: "settle",
        settled: false,
        scheme,
        network,
        error,
        settlementReference,
        raw: input.data,
      },
    };
  }

  return {
    ok: true,
    status: input.status,
    settlementReference,
    response: {
      type: "settle",
      settled: true,
      scheme,
      network,
      asset: asString(input.data?.asset) ?? input.paymentRequirements.asset,
      amount: asString(input.data?.amount) ?? input.paymentRequirements.maxAmountRequired,
      transactionHash: extractReference(input.data, ["transactionHash", "txHash", "signature"]),
      settlementReference,
      raw: input.data,
    },
  };
}

export function parseStoredX402VerificationResponse(value: unknown): X402FacilitatorVerificationResponse | undefined {
  const data = asRecord(value);
  if (!data || data.type !== "verify" || typeof data.isValid !== "boolean" || typeof data.scheme !== "string" || typeof data.network !== "string") {
    return undefined;
  }

  if (data.isValid) {
    return {
      type: "verify",
      isValid: true,
      scheme: data.scheme,
      network: data.network,
      asset: asString(data.asset),
      resource: asString(data.resource),
      paymentReference: asString(data.paymentReference),
      raw: asRecord(data.raw),
    };
  }

  const error = asString(data.error);
  if (!error) {
    return undefined;
  }

  return {
    type: "verify",
    isValid: false,
    scheme: data.scheme,
    network: data.network,
    error,
    paymentReference: asString(data.paymentReference),
    raw: asRecord(data.raw),
  };
}

export function parseStoredX402SettlementResponse(value: unknown): X402FacilitatorSettlementResponse | undefined {
  const data = asRecord(value);
  if (!data || data.type !== "settle" || typeof data.settled !== "boolean" || typeof data.scheme !== "string" || typeof data.network !== "string") {
    return undefined;
  }

  if (data.settled) {
    return {
      type: "settle",
      settled: true,
      scheme: data.scheme,
      network: data.network,
      asset: asString(data.asset),
      amount: asString(data.amount),
      settlementReference: asString(data.settlementReference),
      transactionHash: asString(data.transactionHash),
      raw: asRecord(data.raw),
    };
  }

  const error = asString(data.error);
  if (!error) {
    return undefined;
  }

  return {
    type: "settle",
    settled: false,
    scheme: data.scheme,
    network: data.network,
    error,
    settlementReference: asString(data.settlementReference),
    raw: asRecord(data.raw),
  };
}

export function getX402FacilitatorConfig(env: Env): X402FacilitatorConfig | null {
  const base = env.X402_FACILITATOR_URL?.trim();
  if (!base) {
    return null;
  }

  const baseUrl = trimTrailingSlash(base);
  return {
    baseUrl,
    verifyUrl: `${baseUrl}${normalizePath(env.X402_FACILITATOR_VERIFY_PATH, DEFAULT_VERIFY_PATH)}`,
    settleUrl: `${baseUrl}${normalizePath(env.X402_FACILITATOR_SETTLE_PATH, DEFAULT_SETTLE_PATH)}`,
    authToken: env.X402_FACILITATOR_AUTH_TOKEN?.trim() || undefined,
  };
}

export async function verifyX402Payment(
  env: Env,
  input: {
    paymentPayload: Record<string, unknown> | string;
    paymentRequirements: X402PaymentRequirement;
  },
): Promise<X402FacilitatorVerificationResult> {
  if (isLocalMockUrl(env.X402_FACILITATOR_URL)) {
    return buildMockVerifyResult(env, input);
  }

  const config = getX402FacilitatorConfig(env);
  if (!config) {
    throw new Error("X402 facilitator is not configured");
  }

  const raw = await postToFacilitator(config.verifyUrl, config, {
    paymentPayload: input.paymentPayload,
    paymentRequirements: input.paymentRequirements,
  });
  return normalizeVerificationResponse({
    ...raw,
    paymentRequirements: input.paymentRequirements,
  });
}

export async function settleX402Payment(
  env: Env,
  input: {
    paymentPayload: Record<string, unknown> | string;
    paymentRequirements: X402PaymentRequirement;
  },
): Promise<X402FacilitatorSettlementResult> {
  if (isLocalMockUrl(env.X402_FACILITATOR_URL)) {
    return buildMockSettleResult(env, input);
  }

  const config = getX402FacilitatorConfig(env);
  if (!config) {
    throw new Error("X402 facilitator is not configured");
  }

  const raw = await postToFacilitator(config.settleUrl, config, {
    paymentPayload: input.paymentPayload,
    paymentRequirements: input.paymentRequirements,
  });
  return normalizeSettlementResponse({
    ...raw,
    paymentRequirements: input.paymentRequirements,
  });
}
