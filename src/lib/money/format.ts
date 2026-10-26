/**
 * Minor units -> display string.
 *
 * This is the only file in the module permitted to produce floating-point
 * output, and it never feeds one back into arithmetic: the string it returns is
 * for humans (UI, logs, audit rows) and no caller may parse it back into a
 * calculation. Every computation in the system reads `MinorUnits` directly.
 */

import type { MinorUnits } from './types';
import { fromMinorUnits } from './parse';
import { USDC_DECIMALS } from './constants';

export interface FormatOptions {
  /** Fractional digits to show. Defaults to the asset's own scale. */
  decimals?: number;
}

/**
 * Format minor units as a decimal string for display.
 *
 * The division and remainder are taken in `BigInt` and only rendered at the
 * end, so no float participates in the value itself. Trailing zeros are
 * trimmed, so 1_000_000n reads as "1" rather than "1.000000".
 *
 * Render-only: the result must never be re-parsed into money math.
 */
export function formatMinorUnits(value: MinorUnits, options: FormatOptions = {}): string {
  const decimals = options.decimals ?? USDC_DECIMALS;
  const units = fromMinorUnits(value);

  const negative = units < BigInt(0);
  const magnitude = negative ? -units : units;

  const scale = BigInt(10) ** BigInt(USDC_DECIMALS);
  const whole = magnitude / scale;
  const fraction = magnitude % scale;

  const sign = negative ? '-' : '';
  const wholeText = sign + whole.toString();
  const fractionText = fraction.toString().padStart(USDC_DECIMALS, '0');

  if (decimals <= 0) {
    return wholeText;
  }

  const shown = fractionText.slice(0, decimals).padEnd(decimals, '0').replace(/0+$/, '');

  return shown.length > 0 ? `${wholeText}.${shown}` : wholeText;
}

/** Format minor units at the asset's full scale, with trailing zeros trimmed. */
export function formatUsdc(value: MinorUnits): string {
  return formatMinorUnits(value, { decimals: USDC_DECIMALS });
}
