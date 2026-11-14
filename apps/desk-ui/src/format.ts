// Money and small text helpers. Money is formatted from integer cents by string operations only: no floats, no Intl.

function assertMinor(minor: number): void {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error(`not a non-negative integer number of cents: ${String(minor)}`);
}

/** 70000 -> "700.00"; 5 -> "0.05"; 41260 -> "412.60". Same as contracts formatCad (no grouping). */
export function formatMinor(minor: number): string {
  assertMinor(minor);
  const digits = String(minor).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** 100000 -> "1,000.00" */
export function groupThousands(plain: string): string {
  const [whole, frac] = plain.split(".");
  let out = "";
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) out += ",";
    out += whole[i];
  }
  return frac === undefined ? out : `${out}.${frac}`;
}

/** 70000 -> "$700.00"; 100000 -> "$1,000.00" (CAD; the currency is stated once on screen, not on every figure). */
export function formatMoney(minor: number): string {
  return `$${groupThousands(formatMinor(minor))}`;
}

/** 532 -> "8 h 52" */
export function formatDelay(minutes: number | null): string {
  if (minutes === null || !Number.isSafeInteger(minutes) || minutes < 0) return "unknown";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} h ${String(m).padStart(2, "0")}`;
}

/** "7c1e5a09…" for long hashes. */
export function shortHash(hash: string, keep = 8): string {
  return hash.length > keep ? `${hash.slice(0, keep)}…` : hash;
}

/** "18:01:44" in the viewer's clock. Never throws on a bad date. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "ZT4H9X.P02.NT101-20261110.APPR_DELAY" -> "P02" */
export function passengerOfKey(effectKey: string): string {
  return effectKey.split(".")[1] ?? effectKey;
}
