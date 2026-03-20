import { nowIso } from "../time";

export const X402_PAYMENT_REQUIRED_HEADER = "payment-required";
export const X402_PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const X402_PAYMENT_RESPONSE_HEADER = "payment-response";

const DEFAULT_X402_SCHEME = "exact";
const DEFAULT_X402_NETWORK_ID = "eip155:84532";
const DEFAULT_X402_ASSET = "usdc";
const DEFAULT_X402_PRICE_PER_CREDIT_USD = 0.01;
const DEFAULT_X402_UPGRADE_PRICE_USD = 10;

export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  asset: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo?: string;
  outputSchema?: string;
  extra?: Record<string, unknown>;
}

export interface X402TopupQuote {
  scheme: string;
  network: string;
  asset: string;
  credits: number;
  amountUsd: string;
  amountAtomic: string;
  description: string;
  paymentRequired: X402PaymentRequirement;
}

export interface X402UpgradeQuote {
  scheme: string;
  network: string;
  asset: string;
  targetPricingTier: string;
  amountUsd: string;
  amountAtomic: string;
  description: string;
  paymentRequired: X402PaymentRequirement;
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

function formatUsd(amount: number): string {
  return amount.toFixed(2);
}

function usdToAtomicSixDecimals(amount: number): string {
  return Math.round(amount * 1_000_000).toString();
}

export function getX402Defaults(env: {
  X402_DEFAULT_SCHEME?: string;
  X402_DEFAULT_NETWORK_ID?: string;
  X402_DEFAULT_ASSET?: string;
  X402_PAY_TO?: string;
  X402_PRICE_PER_CREDIT_USD?: string;
  X402_UPGRADE_PRICE_USD?: string;
}) {
  return {
    scheme: env.X402_DEFAULT_SCHEME?.trim() || DEFAULT_X402_SCHEME,
    network: env.X402_DEFAULT_NETWORK_ID?.trim() || DEFAULT_X402_NETWORK_ID,
    asset: env.X402_DEFAULT_ASSET?.trim() || DEFAULT_X402_ASSET,
    payTo: env.X402_PAY_TO?.trim() || undefined,
    pricePerCreditUsd: parsePositiveNumber(env.X402_PRICE_PER_CREDIT_USD) ?? DEFAULT_X402_PRICE_PER_CREDIT_USD,
    upgradePriceUsd: parsePositiveNumber(env.X402_UPGRADE_PRICE_USD) ?? DEFAULT_X402_UPGRADE_PRICE_USD,
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
  const amountUsd = input.credits * defaults.pricePerCreditUsd;
  const amountUsdFormatted = formatUsd(amountUsd);
  const amountAtomic = usdToAtomicSixDecimals(amountUsd);
  const description = `Top up ${input.credits} Mailagents credits for tenant ${input.tenantId}`;

  return {
    scheme: defaults.scheme,
    network: defaults.network,
    asset: defaults.asset,
    credits: input.credits,
    amountUsd: amountUsdFormatted,
    amountAtomic,
    description,
    paymentRequired: {
      scheme: defaults.scheme,
      network: defaults.network,
      asset: defaults.asset,
      maxAmountRequired: amountAtomic,
      resource: `${input.apiBaseUrl}/v1/billing/topup`,
      description,
      mimeType: "application/json",
      payTo: defaults.payTo,
      outputSchema: "https://api.mailagents.net/schemas/billing/topup-result.json",
      extra: {
        tenantId: input.tenantId,
        tenantDid: input.tenantDid,
        credits: input.credits,
        quotedAt: nowIso(),
      },
    },
  };
}

export function buildX402UpgradeQuote(env: {
  X402_DEFAULT_SCHEME?: string;
  X402_DEFAULT_NETWORK_ID?: string;
  X402_DEFAULT_ASSET?: string;
  X402_PAY_TO?: string;
  X402_PRICE_PER_CREDIT_USD?: string;
  X402_UPGRADE_PRICE_USD?: string;
}, input: {
  targetPricingTier: string;
  tenantId: string;
  tenantDid?: string;
  apiBaseUrl: string;
}): X402UpgradeQuote {
  const defaults = getX402Defaults(env);
  const amountUsdFormatted = formatUsd(defaults.upgradePriceUsd);
  const amountAtomic = usdToAtomicSixDecimals(defaults.upgradePriceUsd);
  const description = `Upgrade tenant ${input.tenantId} to ${input.targetPricingTier}`;

  return {
    scheme: defaults.scheme,
    network: defaults.network,
    asset: defaults.asset,
    targetPricingTier: input.targetPricingTier,
    amountUsd: amountUsdFormatted,
    amountAtomic,
    description,
    paymentRequired: {
      scheme: defaults.scheme,
      network: defaults.network,
      asset: defaults.asset,
      maxAmountRequired: amountAtomic,
      resource: `${input.apiBaseUrl}/v1/billing/upgrade-intent`,
      description,
      mimeType: "application/json",
      payTo: defaults.payTo,
      outputSchema: "https://api.mailagents.net/schemas/billing/upgrade-result.json",
      extra: {
        tenantId: input.tenantId,
        tenantDid: input.tenantDid,
        targetPricingTier: input.targetPricingTier,
        quotedAt: nowIso(),
      },
    },
  };
}

export function encodePaymentRequiredHeader(requirement: X402PaymentRequirement): string {
  return toBase64(JSON.stringify(requirement));
}

export function encodePaymentResponseHeader(payload: unknown): string {
  return toBase64(JSON.stringify(payload));
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
