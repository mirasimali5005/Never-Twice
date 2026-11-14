// Claim intake (HANDOVER.md §13; AGENT_TASKS.md E3): one ModelClient.parse per claim, no tools, one retry, then HELD EXTRACTION_FAILED.
// The claim text is untrusted data. The output schema has no field that can carry an amount, a key or an instruction.
import { readFileSync } from "node:fs";
import { ClaimExtraction, type ModelClient, type ModelFailure } from "@nt/contracts";

/** Must change whenever the prompt file or the ClaimExtraction schema changes (it is part of the cassette hash). */
export const INTAKE_PROMPT_VERSION = "intake@1";
export const INTAKE_SYSTEM_PROMPT = readFileSync(new URL("./prompts/intake.system.md", import.meta.url), "utf8");

export type IntakeClaim = { claim_id: string; channel: string; text: string };

export type IntakeResult =
  | {
      kind: "EXTRACTED";
      extraction: ClaimExtraction;
      requestSha256: string;
      /** quotes the model returned that are not verbatim substrings of the claim text; the field they were in is now null */
      discarded_quotes: string[];
      /** 1, or 2 when the first call failed and the retry succeeded */
      attempts: number;
      source: "live" | "cassette";
    }
  | { kind: "HELD"; reason_code: "EXTRACTION_FAILED"; cause: string; failure: ModelFailure | "THREW"; attempts: number };

const OPEN = "<claim_text>";
const CLOSE = "</claim_text>";
const ESCAPED_CLOSE = "&lt;/claim_text&gt;";

/** The user message: `Channel: <channel>` then the text inside tags. No run id, no claim id. Any closing tag in the text is escaped. */
export function buildUserMessage(channel: string, text: string): string {
  return `Channel: ${channel}\n${OPEN}\n${text.split(CLOSE).join(ESCAPED_CLOSE)}\n${CLOSE}`;
}

/** NFC-normalise and collapse whitespace runs, for the substring test. */
export function normaliseForQuote(s: string): string {
  return s.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function quoteInText(quote: string, normalisedText: string): boolean {
  const q = normaliseForQuote(quote.split(ESCAPED_CLOSE).join(CLOSE));
  return q.length > 0 && normalisedText.includes(q);
}

/**
 * Discard any quote that is not verbatim in the claim text. A payee-change request whose quote is discarded stays requested (a hold is
 * the safe side). A hardship proposal whose quote is discarded is dropped (kind NONE, so no goodwill is proposed).
 */
export function verifyQuotes(extraction: ClaimExtraction, claimText: string): { extraction: ClaimExtraction; discarded: string[] } {
  const text = normaliseForQuote(claimText);
  const discarded: string[] = [];
  const out: ClaimExtraction = structuredClone(extraction);

  const pq = out.payee_change_request.quote;
  if (pq !== null && !quoteInText(pq, text)) {
    discarded.push(pq);
    out.payee_change_request.quote = null;
  }
  const hq = out.hardship.quote;
  if (hq !== null && !quoteInText(hq, text)) {
    discarded.push(hq);
    out.hardship = { kind: "NONE", quote: null };
  } else if (out.hardship.kind === "NONE") {
    out.hardship.quote = null;
  }
  return { extraction: out, discarded };
}

/**
 * One parse call (effort low, no tools); on any failure one retry, in every mode (in replay the retry reads the same cassette and misses
 * again, harmlessly); then HELD EXTRACTION_FAILED. Nothing downstream runs on a partial output.
 */
export async function extractClaim(client: ModelClient, claim: IntakeClaim): Promise<IntakeResult> {
  const req = {
    promptVersion: INTAKE_PROMPT_VERSION,
    system: INTAKE_SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: buildUserMessage(claim.channel, claim.text) }],
    schema: ClaimExtraction,
    maxTokens: 2000,
    effort: "low" as const,
  };
  let last = "";
  let lastFailure: ModelFailure | "THREW" = "THREW";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await client.parse(req);
      if (r.ok) {
        const { extraction, discarded } = verifyQuotes(r.output, claim.text);
        return { kind: "EXTRACTED", extraction, requestSha256: r.requestSha256, discarded_quotes: discarded, attempts: attempt, source: r.source };
      }
      last = `${r.failure}: ${r.detail}`;
      lastFailure = r.failure;
    } catch (e) {
      last = `threw: ${(e as Error).message}`;
      lastFailure = "THREW";
    }
  }
  return { kind: "HELD", reason_code: "EXTRACTION_FAILED", cause: last, failure: lastFailure, attempts: 2 };
}
