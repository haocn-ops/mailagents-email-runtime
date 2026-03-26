import { nowIso } from "../time";

export const X402_PAYMENT_REQUIRED_HEADER = "payment-required";
export const X402_PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const X402_PAYMENT_RESPONSE_HEADER = "payment-response";
export const X402_VERSION = 2;

const DEFAULT_X402_SCHEME = "exact";
const DEFAULT_X402_NETWORK_ID = "eip155:84532";
const DEFAULT_X402_ASSET = "usdc";
const DEFAULT_X402_PRICE_PER_CREDIT_USD = 0.01;
const DEFAULT_X402_UPGRADE_PRICE_USD = 10;
const DEFAULT_X402_UPGRADE_INCLUDED_CREDITS = 10000;
const DEFAULT_X402_TIMEOUT_SECONDS = 300;
const BASE_SEPOLIA_USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
  // Legacy aliases retained for internal compatibility and older docs.
  maxAmountRequired?: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  outputSchema?: string;
}

export interface X402PaymentRequired {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirement[];
  extensions?: Record<string, unknown>;
}

export interface X402PaymentPayload {
  x402Version: typeof X402_VERSION;
  resource?: X402ResourceInfo;
  accepted: X402PaymentRequirement;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface X402TopupQuote {
  scheme: string;
  network: string;
  asset: string;
  assetSymbol: string;
  credits: number;
  amountUsd: string;
  amountAtomic: string;
  description: string;
  paymentRequirements: X402PaymentRequirement;
  paymentRequired: X402PaymentRequired;
}

export interface X402UpgradeQuote {
  scheme: string;
  network: string;
  asset: string;
  assetSymbol: string;
  targetPricingTier: string;
  includedCredits: number;
  amountUsd: string;
  amountAtomic: string;
  description: string;
  paymentRequirements: X402PaymentRequirement;
  paymentRequired: X402PaymentRequired;
}

export interface ParsedX402PaymentProof {
  raw: string;
  parsed?: Record<string, unknown>;
}

function toBase64(input: string): string {
  return btoa(input);
}

function fromBase64(input: string): string {
  return atob(input);
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) {
    return "0.00";
  }

  if (amount >= 0.01) {
    return amount.toFixed(2);
  }

  return amount.toFixed(6).replace(/(?:\.0+|(\.\d+?)0+)$/, "$1");
}

function usdToAtomicSixDecimals(amount: number): string {
  return Math.round(amount * 1_000_000).toString();
}

function normalizeSymbol(value: string): string {
  return value.trim().toLowerCase();
}

function resolveAssetIdentifier(input: {
  network: string;
  asset: string;
}): { asset: string; assetSymbol: string; extra?: Record<string, unknown> } {
  const symbol = normalizeSymbol(input.asset);
  if (input.network === DEFAULT_X402_NETWORK_ID && symbol === "usdc") {
    return {
      asset: BASE_SEPOLIA_USDC_ADDRESS,
      assetSymbol: "usdc",
      extra: {
        assetTransferMethod: "eip3009",
        name: "USDC",
        version: "2",
      },
    };
  }

  return {
    asset: input.asset,
    assetSymbol: symbol,
  };
}

function buildPaymentRequirement(input: {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo?: string;
  resource: X402ResourceInfo;
  outputSchema?: string;
  extra?: Record<string, unknown>;
}): X402PaymentRequirement {
  const payTo = input.payTo?.trim();
  if (!payTo) {
    throw new Error("X402 pay-to address is not configured");
  }

  return {
    scheme: input.scheme,
    network: input.network,
    asset: input.asset,
    amount: input.amount,
    payTo,
    maxTimeoutSeconds: DEFAULT_X402_TIMEOUT_SECONDS,
    extra: input.extra,
    maxAmountRequired: input.amount,
    resource: input.resource.url,
    description: input.resource.description,
    mimeType: input.resource.mimeType,
    outputSchema: input.outputSchema,
  };
}

function buildPaymentRequiredResponse(input: {
  resource: X402ResourceInfo;
  paymentRequirements: X402PaymentRequirement;
}): X402PaymentRequired {
  return {
    x402Version: X402_VERSION,
    resource: input.resource,
    accepts: [input.paymentRequirements],
  };
}

export function getX402Defaults(env: {
  X402_DEFAULT_SCHEME?: string;
  X402_DEFAULT_NETWORK_ID?: string;
  X402_DEFAULT_ASSET?: string;
  X402_PAY_TO?: string;
  X402_PRICE_PER_CREDIT_USD?: string;
  X402_UPGRADE_PRICE_USD?: string;
  X402_UPGRADE_INCLUDED_CREDITS?: string;
}) {
  return {
    scheme: env.X402_DEFAULT_SCHEME?.trim() || DEFAULT_X402_SCHEME,
    network: env.X402_DEFAULT_NETWORK_ID?.trim() || DEFAULT_X402_NETWORK_ID,
    asset: env.X402_DEFAULT_ASSET?.trim() || DEFAULT_X402_ASSET,
    payTo: env.X402_PAY_TO?.trim() || undefined,
    pricePerCreditUsd: parsePositiveNumber(env.X402_PRICE_PER_CREDIT_USD) ?? DEFAULT_X402_PRICE_PER_CREDIT_USD,
    upgradePriceUsd: parsePositiveNumber(env.X402_UPGRADE_PRICE_USD) ?? DEFAULT_X402_UPGRADE_PRICE_USD,
    upgradeIncludedCredits: parsePositiveInteger(env.X402_UPGRADE_INCLUDED_CREDITS) ?? DEFAULT_X402_UPGRADE_INCLUDED_CREDITS,
  };
}

export function buildX402TopupQuote(env: {
  X402_DEFAULT_SCHEME?: string;
  X402_DEFAULT_NETWORK_ID?: string;
  X402_DEFAULT_ASSET?: string;
  X402_PAY_TO?: string;
  X402_PRICE_PER_CREDIT_USD?: string;
  X402_UPGRADE_PRICE_USD?: string;
}, input: {
  credits: number;
  tenantId: string;
  tenantDid?: string;
  apiBaseUrl: string;
}): X402TopupQuote {
  const defaults = getX402Defaults(env);
  const assetDefaults = resolveAssetIdentifier({
    network: defaults.network,
    asset: defaults.asset,
  });
  const amountUsd = input.credits * defaults.pricePerCreditUsd;
  const amountUsdFormatted = formatUsd(amountUsd);
  const amountAtomic = usdToAtomicSixDecimals(amountUsd);
  const description = `Top up ${input.credits} Mailagents credits for tenant ${input.tenantId}`;
  const resource = {
    url: `${input.apiBaseUrl}/v1/billing/topup`,
    description,
    mimeType: "application/json",
  };
  const paymentRequirements = buildPaymentRequirement({
    scheme: defaults.scheme,
    network: defaults.network,
    asset: assetDefaults.asset,
    amount: amountAtomic,
    payTo: defaults.payTo,
    resource,
    outputSchema: "https://api.mailagents.net/schemas/billing/topup-result.json",
    extra: {
      ...assetDefaults.extra,
      tenantId: input.tenantId,
      tenantDid: input.tenantDid,
      credits: input.credits,
      quotedAt: nowIso(),
    },
  });

  return {
    scheme: defaults.scheme,
    network: defaults.network,
    asset: assetDefaults.asset,
    assetSymbol: assetDefaults.assetSymbol,
    credits: input.credits,
    amountUsd: amountUsdFormatted,
    amountAtomic,
    description,
    paymentRequirements,
    paymentRequired: buildPaymentRequiredResponse({
      resource,
      paymentRequirements,
    }),
  };
}

export function buildX402UpgradeQuote(env: {
  X402_DEFAULT_SCHEME?: string;
  X402_DEFAULT_NETWORK_ID?: string;
  X402_DEFAULT_ASSET?: string;
  X402_PAY_TO?: string;
  X402_PRICE_PER_CREDIT_USD?: string;
  X402_UPGRADE_PRICE_USD?: string;
  X402_UPGRADE_INCLUDED_CREDITS?: string;
}, input: {
  targetPricingTier: string;
  tenantId: string;
  tenantDid?: string;
  apiBaseUrl: string;
}): X402UpgradeQuote {
  const defaults = getX402Defaults(env);
  const assetDefaults = resolveAssetIdentifier({
    network: defaults.network,
    asset: defaults.asset,
  });
  const amountUsdFormatted = formatUsd(defaults.upgradePriceUsd);
  const amountAtomic = usdToAtomicSixDecimals(defaults.upgradePriceUsd);
  const description = `Upgrade tenant ${input.tenantId} to ${input.targetPricingTier} and grant ${defaults.upgradeIncludedCredits} Mailagents credits`;
  const resource = {
    url: `${input.apiBaseUrl}/v1/billing/upgrade-intent`,
    description,
    mimeType: "application/json",
  };
  const paymentRequirements = buildPaymentRequirement({
    scheme: defaults.scheme,
    network: defaults.network,
    asset: assetDefaults.asset,
    amount: amountAtomic,
    payTo: defaults.payTo,
    resource,
    outputSchema: "https://api.mailagents.net/schemas/billing/upgrade-result.json",
    extra: {
      ...assetDefaults.extra,
      tenantId: input.tenantId,
      tenantDid: input.tenantDid,
      targetPricingTier: input.targetPricingTier,
      includedCredits: defaults.upgradeIncludedCredits,
      quotedAt: nowIso(),
    },
  });

  return {
    scheme: defaults.scheme,
    network: defaults.network,
    asset: assetDefaults.asset,
    assetSymbol: assetDefaults.assetSymbol,
    targetPricingTier: input.targetPricingTier,
    includedCredits: defaults.upgradeIncludedCredits,
    amountUsd: amountUsdFormatted,
    amountAtomic,
    description,
    paymentRequirements,
    paymentRequired: buildPaymentRequiredResponse({
      resource,
      paymentRequirements,
    }),
  };
}

export function encodePaymentRequiredHeader(payload: X402PaymentRequired): string {
  return toBase64(JSON.stringify(payload));
}

export function encodePaymentResponseHeader(payload: unknown): string {
  return toBase64(JSON.stringify(payload));
}

export function getX402RequirementAmount(requirement: X402PaymentRequirement): string {
  return requirement.amount;
}

export function getX402RequirementResource(requirement: X402PaymentRequirement): string | undefined {
  return requirement.resource;
}

export function isX402PaymentPayload(value: unknown): value is X402PaymentPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.x402Version === X402_VERSION
    && record.accepted !== null
    && typeof record.accepted === "object"
    && !Array.isArray(record.accepted)
    && record.payload !== null
    && typeof record.payload === "object"
    && !Array.isArray(record.payload);
}

export function parseX402PaymentProof(raw: string | null): ParsedX402PaymentProof | null {
  if (!raw?.trim()) {
    return null;
  }

  const trimmed = raw.trim();
  try {
    const decoded = fromBase64(trimmed);
    const parsed = JSON.parse(decoded) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        raw: trimmed,
        parsed: parsed as Record<string, unknown>,
      };
    }
  } catch {
    // Fall through and keep the raw proof only.
  }

  return { raw: trimmed };
}
