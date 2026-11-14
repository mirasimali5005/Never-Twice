// Arm R (`rules_only`, HANDOVER.md §15): "a batch job". The Never Twice payment path with the model replaced by a regular-expression parser
// over the claim text. `createRegexModelClient()` is a ModelClient whose parse() answers the intake request from the claim text alone, with
// no model call of any kind, so the orchestrator, `extractClaim`, `resolve`, the rules engine, the gateway and the reconciler run unchanged.
//
// What a parser like this can and cannot do is the measurement (packages/baselines/test/rules-only.int.test.ts). It is written the way a
// sensible engineer would write it in an afternoon: structured web-form fields by key, e-mail headers by name, a handful of phrases for
// the free-text cases, English and French month names. It is not tuned against the S1 claims and it never fabricates a field it cannot find.
import { ClaimExtraction, sha256Hex, type ModelClient, type ModelParseRequest, type ModelParseResult } from "@nt/contracts";

export const REGEX_MODEL_ID = "regex-parser@1";

const NAME = String.raw`\p{Lu}[\p{L}'’.-]*(?:[ \t]+\p{Lu}[\p{L}'’.-]*){1,3}`;
const nameRe = new RegExp(`^${NAME}$`, "u");

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, janvier: 1, february: 2, feb: 2, février: 2, fevrier: 2, févr: 2, march: 3, mar: 3, mars: 3, april: 4, apr: 4, avril: 4, avr: 4,
  may: 5, mai: 5, june: 6, jun: 6, juin: 6, july: 7, jul: 7, juillet: 7, juil: 7, august: 8, aug: 8, août: 8, aout: 8, september: 9, sep: 9, sept: 9, septembre: 9,
  october: 10, oct: 10, octobre: 10, november: 11, nov: 11, novembre: 11, december: 12, dec: 12, décembre: 12, decembre: 12, déc: 12,
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const pad = (n: number): string => String(n).padStart(2, "0");

/** Splits the user message of `buildUserMessage` back into channel and claim text. */
function splitUserMessage(content: string): { channel: string; text: string } {
  const m = /^Channel:\s*(.*)\n<claim_text>\n([\s\S]*)\n<\/claim_text>\s*$/u.exec(content);
  if (!m) return { channel: "", text: content };
  return { channel: m[1] ?? "", text: (m[2] ?? "").split("&lt;/claim_text&gt;").join("</claim_text>") };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function bookingRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{6}\b/gu)) out.push(m[0]);
  return dedupe(out);
}

function flightNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(NT)\s?(\d{2,4})\b/gu)) out.push(`${m[1]}${m[2]}`);
  return dedupe(out);
}

/** The earliest date written in the body. Header lines (Date:, Sent:, De :) are skipped: they are the day the message was sent. */
function travelDate(text: string): string | null {
  const form = /"flight_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/u.exec(text);
  if (form) return form[1] ?? null;
  const body = text.split("\n").filter((l) => !/^\s*(?:Date|Sent|Objet|Subject|Envoy[ée])\s*:/iu.test(l)).join("\n");
  const defaultYear = /\b(20\d{2})\b/u.exec(text)?.[1];
  const found: string[] = [];
  const add = (y: string | undefined, mo: string | undefined, d: string | undefined): void => {
    const month = mo ? MONTHS[mo.toLowerCase().replace(/\.$/u, "")] : undefined;
    const year = y ?? defaultYear;
    if (month && d && year) found.push(`${year}-${pad(month)}-${pad(Number(d))}`);
  };
  for (const m of body.matchAll(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th|er)?\s+(${MONTH_ALT})\.?(?:\s+(\d{4}))?`, "giu"))) add(m[3], m[2], m[1]);
  for (const m of body.matchAll(new RegExp(String.raw`\b(${MONTH_ALT})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, "giu"))) add(m[3], m[1], m[2]);
  for (const m of body.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/gu)) found.push(`${m[1]}-${m[2]}-${m[3]}`);
  found.sort();
  return found[0] ?? null;
}

function nameFromHeader(text: string): string | null {
  const m = /^(?:From|De)\s*:\s*"?([^<\n"]+?)"?\s*<[^>\n]+>/imu.exec(text);
  const n = m?.[1]?.trim();
  return n && nameRe.test(n) ? n : null;
}

function nameFromSignature(text: string): string | null {
  const m = new RegExp(
    String.raw`(?:regards|thanks|thank you|sincerely|faithfully|cordialement|salutations distinguées\.?|merci)[,.]?[ \t]*\n+[ \t]*(${NAME})[ \t]*(?:\n|$)`,
    "iu",
  ).exec(text);
  const n = m?.[1]?.trim();
  return n && nameRe.test(n) ? n : null;
}

function relativesNamed(text: string): { name: string; relation: string }[] {
  const out: { name: string; relation: string }[] = [];
  const rel = "wife|husband|spouse|partner|son|daughter|child|mother|father|mom|dad|sister|brother|femme|mari|fils|fille";
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:my|our)\s+(${rel})\s+(${NAME.replace("{1,3}", "{1,2}")})`, "gu"))) {
    // the name pattern is greedy over capitalised words; trim a trailing "and"/"who" artefact
    const name = (m[2] ?? "").trim();
    if (nameRe.test(name)) out.push({ name, relation: (m[1] ?? "").toLowerCase() });
  }
  return out;
}

const INJECTION =
  /ignore (?:all |any |the )?(?:previous|prior|above) (?:instructions|rules)|(?:system|admin|developer) (?:note|message|override)[^\n]{0,40}(?:processor|assistant|ai|system)|to (?:the )?automated (?:claims )?(?:processor|system)|pre-?verified by|do not (?:hold|escalate)/iu;

const PAYEE_CHANGE =
  /(?:pay(?:ment|ed)?|paid|compensation)[^.\n]{0,80}?(?:instead of (?:mine|me|my)|account instead|to (?:my |our )?(?:employer|company|agency|third)|(?:a |the )?different account|another account|(?:a )?new account)/iu;

const OVERNIGHT = /(?:spent the night|slept (?:at|in) the (?:airport|terminal)|night (?:in|at) the (?:airport|terminal)|stranded overnight|overnight at the airport)/iu;
const MOBILITY = /(?:wheelchair|mobility (?:need|aid|assist)\w*|assisted boarding|assistance service|special assistance)/iu;

function fieldValue(text: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "u").exec(text);
  return m?.[1] ?? null;
}

function formPassengers(text: string): string[] {
  const m = /"passengers_on_this_request"\s*:\s*\[([^\]]*)\]/u.exec(text);
  if (!m) return [];
  return [...(m[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((x) => x[1] ?? "");
}

/** Pure: claim text in, extraction out. Never throws. */
export function regexExtract(text: string): ClaimExtraction {
  const isForm = /"form"\s*:\s*"nt-compensation-request@/u.test(text);
  const claimants: string[] = [];
  const claimedFor: { name: string; relation: string | null }[] = [];

  if (isForm) {
    const n = fieldValue(text, "full_name");
    if (n) claimants.push(n);
    for (const p of formPassengers(text)) claimedFor.push({ name: p, relation: p === n ? "self" : null });
  } else {
    const sender = nameFromHeader(text) ?? nameFromSignature(text);
    if (sender) claimants.push(sender);
    const client = /[Oo]ur client[ \t]*:[ \t]*(?:Mr\.?|Ms\.?|Mrs\.?|Mx\.?|Dr\.?)?\s*(\p{Lu}[\p{L}'’-]+(?:[ \t]+\p{Lu}[\p{L}'’-]+){1,2})/u.exec(text);
    if (client?.[1] && /our client\s*:/iu.test(text)) {
      claimedFor.push({ name: client[1], relation: "client" });
    } else if (sender) {
      claimedFor.push({ name: sender, relation: "self" });
      for (const r of relativesNamed(text)) claimedFor.push({ name: r.name, relation: r.relation });
    }
  }

  const payee = PAYEE_CHANGE.exec(text);
  const overnight = OVERNIGHT.exec(text);
  const mobility = MOBILITY.exec(text);
  const hard = mobility ? { kind: "MOBILITY_ASSIST" as const, quote: mobility[0] } : overnight ? { kind: "OVERNIGHT_STRANDED" as const, quote: overnight[0] } : { kind: "NONE" as const, quote: null };

  const french = /\b(?:vol|réservation|Madame|Monsieur|indemnisation|Bonjour|retard)\b/u.test(text);
  const delay = /\b((?:over|about|more than|just over|a little over|roughly)?\s*(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)(?: and a half|\s+hours?(?: and \d+ minutes?)?)?\s*(?:hours?\s+)?(?:late|later|de retard))\b/iu.exec(text);
  const amount = /(?:\$\s?[\d,]+(?:\.\d{2})?|CAD\s?[\d,]+(?:\.\d{2})?)/u.exec(text);

  return {
    claimant_names: dedupe(claimants),
    booking_refs: bookingRefs(text),
    flight_numbers: flightNumbers(text),
    travel_date: travelDate(text),
    passengers_claimed_for: claimedFor,
    asserted_delay: delay ? delay[1]!.trim() : null,
    asserted_cause: null,
    requested_amount: amount ? amount[0] : null,
    payee_change_request: payee ? { requested: true, quote: payee[0] } : { requested: false, quote: null },
    hardship: hard,
    injection_suspected: INJECTION.test(text),
    language: french ? "fr" : "en",
    notes: "regex parser",
  };
}

/** A ModelClient that answers `extractClaim`'s request with the regular-expression parser. No network, no cassette, no subprocess. */
export function createRegexModelClient(): ModelClient {
  return {
    mode: "replay",
    model: REGEX_MODEL_ID,
    backend: "cli",
    async parse<T>(req: ModelParseRequest<T>): Promise<ModelParseResult<T>> {
      const content = req.messages[req.messages.length - 1]?.content ?? "";
      const { text } = splitUserMessage(content);
      const requestSha256 = sha256Hex(`${REGEX_MODEL_ID}\n${content}`);
      const parsed = req.schema.safeParse(regexExtract(text) satisfies ClaimExtraction);
      if (!parsed.success) return { ok: false, failure: "SCHEMA_INVALID", detail: parsed.error.message, requestSha256 };
      return { ok: true, output: parsed.data, requestSha256, source: "live" };
    },
    async runTools() {
      return { ok: false, failure: "UNSUPPORTED", detail: "the regex parser has no tool loop" };
    },
  };
}
