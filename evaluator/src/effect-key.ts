// The evaluator's own effect-key builder (HANDOVER §9.1). Not imported from packages/contracts.
// effect_key = `${booking_ref}.${passenger_id}.${disruption_id}.${entitlement_type}`
// disruption_id = `${flight_no}-${yyyymmdd of scheduled departure}`

export const EFFECT_KEY_RE = /^[A-Z0-9._-]+$/;
export const RUN_ID_RE = /^r[0-9a-z]{7}$/;
export const GROUP_ID_RE = /^g[0-9a-z]{7}$/;

export function disruptionId(flightNo: string, localDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(localDate);
  if (!m) throw new Error(`disruptionId: bad date ${JSON.stringify(localDate)}`);
  return `${flightNo}-${m[1]}${m[2]}${m[3]}`;
}

export function effectKey(p: { bookingRef: string; passengerId: string; disruptionId: string; entitlementType: string }): string {
  const key = `${p.bookingRef}.${p.passengerId}.${p.disruptionId}.${p.entitlementType}`;
  if (!EFFECT_KEY_RE.test(key)) throw new Error(`effectKey: invalid characters in ${JSON.stringify(key)}`);
  return key;
}

export function markerOf(runId: string, key: string): string {
  return `${runId}:${key}`;
}
