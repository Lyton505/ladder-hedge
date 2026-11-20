/**
 * Display formatting helpers shared by the presentational components.
 *
 * Every helper is pure and locale-pinned to en-US for numbers so that server
 * and client renders produce identical text.
 */

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * 60;

/** Options for {@link formatUsd}. */
export interface FormatUsdOptions {
  /** Number of decimal places. Defaults to 2. */
  decimals?: number;
  /** When true, positive values get a leading "+". Defaults to false. */
  signed?: boolean;
}

/**
 * Formats a dollar amount, for example `-$51.20` or `$1,234.50`.
 *
 * Values that round to zero are shown as `$0.00` (never `-$0.00`).
 *
 * @param {number} value - The amount in dollars.
 * @param {FormatUsdOptions} [options] - Decimal places and sign handling.
 * @returns {string} The formatted amount, or an en dash when value is not finite.
 */
export function formatUsd(value: number, options: FormatUsdOptions = {}): string {
  if (!Number.isFinite(value)) {
    return "–";
  }
  const decimals = options.decimals ?? 2;
  const smallestShown = 0.5 * Math.pow(10, -decimals);
  const safeValue = Math.abs(value) < smallestShown ? 0 : value;
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const text = formatter.format(safeValue);
  if (options.signed === true && safeValue > 0) {
    return `+${text}`;
  }
  return text;
}

/**
 * Formats a fraction as a percentage, for example `0.0329` as `3.29%`.
 *
 * @param {number} fraction - The value as a fraction of one.
 * @param {number} [decimals=2] - Number of decimal places.
 * @returns {string} The formatted percentage, or an en dash when fraction is not finite.
 */
export function formatPercent(fraction: number, decimals: number = 2): string {
  if (!Number.isFinite(fraction)) {
    return "–";
  }
  const formatter = new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return formatter.format(fraction);
}

/**
 * Formats a contract or asset quantity with grouping and up to `maxDecimals` decimals,
 * for example `3.58`, `20` or `1,250.5`.
 *
 * @param {number} value - The quantity.
 * @param {number} [maxDecimals=2] - Largest number of decimal places shown.
 * @returns {string} The formatted quantity, or an en dash when value is not finite.
 */
export function formatQuantity(value: number, maxDecimals: number = 2): string {
  if (!Number.isFinite(value)) {
    return "–";
  }
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
  return formatter.format(value);
}

/**
 * Formats the time left until an expiry, for example `2h 05m`, `1d 03h` or `45m`.
 *
 * @param {string} expiryIso - ISO 8601 expiry time.
 * @param {number} nowMs - The current time in epoch milliseconds.
 * @returns {string} `expired` when the expiry is not in the future, `unknown` when
 *   the expiry cannot be parsed, otherwise the remaining time.
 */
export function formatCountdown(expiryIso: string, nowMs: number): string {
  const expiryMs = Date.parse(expiryIso);
  if (Number.isNaN(expiryMs) || !Number.isFinite(nowMs)) {
    return "unknown";
  }
  const remainingMs = expiryMs - nowMs;
  if (remainingMs <= 0) {
    return "expired";
  }
  const totalMinutes = Math.floor(remainingMs / MS_PER_MINUTE);
  if (totalMinutes < 1) {
    return "under 1m";
  }
  const days = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const hours = Math.floor((totalMinutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  if (days > 0) {
    return `${days}d ${String(hours).padStart(2, "0")}h`;
  }
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${minutes}m`;
}

/**
 * Formats a ladder strike, dropping cents when the strike is a whole number,
 * for example `$72`, `$97,000` or `$2.75`.
 *
 * @param {number} strike - The strike in dollars.
 * @returns {string} The formatted strike.
 */
export function formatStrike(strike: number): string {
  const decimals = Number.isInteger(strike) ? 0 : 2;
  return formatUsd(strike, { decimals });
}

/**
 * Formats a price interval of the expiry price, for example `below $68`,
 * `$68 to $69` or `$75 and above`.
 *
 * @param {number | null} lower - Inclusive lower bound, or null when unbounded below.
 * @param {number | null} upper - Exclusive upper bound, or null when unbounded above.
 * @returns {string} A readable interval label.
 */
export function formatPriceInterval(lower: number | null, upper: number | null): string {
  if (lower === null && upper === null) {
    return "any price";
  }
  if (lower === null && upper !== null) {
    return `below ${formatStrike(upper)}`;
  }
  if (lower !== null && upper === null) {
    return `${formatStrike(lower)} and above`;
  }
  return `${formatStrike(lower as number)} to ${formatStrike(upper as number)}`;
}

/**
 * Formats an ISO time as a short local date and time, for example `Fri 12:00 AM EST`.
 *
 * The output depends on the viewer's time zone, so render it inside an element
 * with `suppressHydrationWarning`.
 *
 * @param {string} iso - ISO 8601 time.
 * @returns {string} The local time, or `unknown time` when iso cannot be parsed.
 */
export function formatLocalDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return "unknown time";
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return formatter.format(new Date(ms));
}

/**
 * Formats an ISO time as a local clock time, for example `11:42:05 PM`.
 *
 * The output depends on the viewer's time zone, so render it inside an element
 * with `suppressHydrationWarning`.
 *
 * @param {string} iso - ISO 8601 time.
 * @returns {string} The local clock time, or `unknown time` when iso cannot be parsed.
 */
export function formatClockTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return "unknown time";
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  return formatter.format(new Date(ms));
}

/**
 * Shortens a transaction signature or hash for display, for example `5Kx9...Qe2a`.
 *
 * @param {string} value - The full signature or hash.
 * @param {number} [edge=4] - Characters kept at each end.
 * @returns {string} The shortened value, or the input when it is already short.
 */
export function formatShortHash(value: string, edge: number = 4): string {
  if (value.length <= edge * 2 + 3) {
    return value;
  }
  return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}
