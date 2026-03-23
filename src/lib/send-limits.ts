import type { PricingTier } from "../types";

export interface EffectiveSendLimits {
  dailySendLimit: number | null;
  hourlySendLimit: number | null;
  windowModel: "rolling" | null;
}

export function getEffectiveSendLimits(pricingTier: PricingTier): EffectiveSendLimits {
  if (pricingTier === "free") {
    return {
      dailySendLimit: 10,
      hourlySendLimit: 1,
      windowModel: "rolling",
    };
  }

  return {
    dailySendLimit: null,
    hourlySendLimit: null,
    windowModel: null,
  };
}
