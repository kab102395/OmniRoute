const USD_TICKS_PER_DOLLAR = 10_000_000_000;

export interface UsdTickAmount {
  amountUsd: number;
  amountUsdExact: string;
}

/** Convert provider-reported integer USD ticks without losing their decimal value. */
export function parseUsdTicks(value: unknown): UsdTickAmount | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;

  const wholeDollars = Math.floor(value / USD_TICKS_PER_DOLLAR);
  const fractionalTicks = value % USD_TICKS_PER_DOLLAR;
  const fractionalUsd = fractionalTicks.toString().padStart(10, "0").replace(/0+$/, "");

  return {
    amountUsd: value / USD_TICKS_PER_DOLLAR,
    amountUsdExact: fractionalUsd ? `${wholeDollars}.${fractionalUsd}` : String(wholeDollars),
  };
}
