/**
 * Precision-Safe Financial Arithmetic
 * Avoids IEEE-754 floating-point errors for blockchain amounts.
 * Stores values as integer base units (satoshis, wei, sun, lamports, drops).
 */

export const ASSET_DECIMALS: Record<string, number> = {
  BTC: 8,
  SAT: 0,
  ETH: 18,
  WEI: 0,
  GWEI: 9,
  USDT: 6,
  USDC: 6,
  BNB: 18,
  MATIC: 18,
  POL: 18,
  TRX: 6,
  SUN: 0,
  SOL: 9,
  LAMPORTS: 0,
  XRP: 6,
  DROPS: 0,
  LTC: 8,
  DOGE: 8,
};

/**
 * Converts a raw base-unit integer string to a formatted decimal display string.
 * Example: ("150000000", 8) -> "1.5"
 * Example: ("1000000000000000000", 18) -> "1.0"
 */
export function formatBaseUnitToDisplay(rawAmount: string | bigint | number, decimals: number): string {
  try {
    const rawStr = BigInt(rawAmount.toString()).toString();
    const isNegative = rawStr.startsWith('-');
    const cleanRaw = isNegative ? rawStr.slice(1) : rawStr;

    if (decimals === 0) {
      return (isNegative ? '-' : '') + cleanRaw;
    }

    if (cleanRaw.length <= decimals) {
      const padded = cleanRaw.padStart(decimals, '0');
      const formatted = `0.${padded}`.replace(/0+$/, '').replace(/\.$/, '');
      return (isNegative ? '-' : '') + (formatted === '' ? '0' : formatted);
    }

    const wholePart = cleanRaw.slice(0, cleanRaw.length - decimals);
    const fractionPart = cleanRaw.slice(cleanRaw.length - decimals);
    const trimmedFraction = fractionPart.replace(/0+$/, '');

    const result = trimmedFraction.length > 0 ? `${wholePart}.${trimmedFraction}` : wholePart;
    return (isNegative ? '-' : '') + result;
  } catch {
    return '0';
  }
}

/**
 * Converts a human-entered decimal string to a raw base-unit integer string.
 * Example: ("1.5", 8) -> "150000000"
 */
export function parseDisplayToBaseUnit(displayAmount: string, decimals: number): string {
  try {
    const sanitized = displayAmount.trim().replace(/,/g, '');
    if (!sanitized || sanitized === '0') return '0';

    const isNegative = sanitized.startsWith('-');
    const clean = isNegative ? sanitized.slice(1) : sanitized;

    const parts = clean.split('.');
    const whole = parts[0] || '0';
    let fraction = parts[1] || '';

    if (fraction.length > decimals) {
      // truncate excess decimal precision safely
      fraction = fraction.slice(0, decimals);
    } else {
      fraction = fraction.padEnd(decimals, '0');
    }

    const baseUnitBigInt = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction || '0');
    return (isNegative ? '-' : '') + baseUnitBigInt.toString();
  } catch {
    return '0';
  }
}

/**
 * Safe integer additions of raw amounts
 */
export function addRawAmounts(amountA: string, amountB: string): string {
  try {
    return (BigInt(amountA || '0') + BigInt(amountB || '0')).toString();
  } catch {
    return '0';
  }
}

/**
 * Safe comparisons
 */
export function compareRawAmounts(amountA: string, amountB: string): number {
  try {
    const a = BigInt(amountA || '0');
    const b = BigInt(amountB || '0');
    if (a > b) return 1;
    if (a < b) return -1;
    return 0;
  } catch {
    return 0;
  }
}
