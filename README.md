# Never Twice

**The claims desk that refuses to guess.**

An airline claims desk for statutory passenger compensation under Canada's Air Passenger Protection Regulations (SOR/2019-150), built on MongoDB Atlas. AI agents read messy claims; a deterministic rules engine fixes the amount; a gateway reserves the payment in MongoDB in one transaction before anything is sent. When a payment's outcome is unknown after a crash or a lost response, the desk **investigates the payment provider's own records**, confirms only on matching evidence, re-sends only the identical request under the same key when a recorded licence allows it, and otherwise **parks the payment for a person instead of guessing**. A separate auditor with no access to the system's database grades every dollar.

> The model proposes and investigates. Deterministic code authorizes and verifies.

Built for the MongoDB "Agents in Context" hackathon, Toronto, 14 November 2026 — Statement Three, *Finish the Job* (with elements of Statement One, *Agents You Can Audit*).

## What was built today, what was prepared, what is simulated

- **Built during the build period (10:45 onwards), with AI coding agents** (Claude Code, Opus 5.5 and Sonnet 5.5, directed by the entrant): all code in this repository. The commit history shows when each part landed.
- **Prepared before the event, with AI assistance, and not in this repository:** design documents, the test plan and the fixture specification.
- **Simulated:** the compensation payout provider (`apps/provider-sim`), so that lost responses, dropped requests and late commits can be produced on cue. It is labelled as a simulator everywhere.
- **Real:** MongoDB Atlas (the hackathon sandbox), Stripe **test mode** for the ticket-refund leg, the Anthropic model through the local `claude` command, Voyage AI embeddings and Atlas Vector Search.
- **Synthetic:** the airline (fictional Northern Tern Airlines), every passenger, booking, payee token and claim. No real money and no real personal data.

## The demonstration

One group of three runs on the same claims, the same provider faults and the same kill:

| Arm | What it is |
|---|---|
| `nt` | Never Twice |
| `control` | An ordinary agent: fresh idempotency key per attempt, a 2xx means paid, resume by re-running unfinished claims |
| `nt_mutant` | Never Twice with one labelled mutation (M2: mark unknown outcomes confirmed without evidence) — a test of the auditor |

A judge picks a passenger; the process is killed (a real `SIGKILL`) right after the provider applied that payment and before the system recorded it. Two other payments are left in doubt by the fault schedule: a dropped request on a rail that honours idempotency keys, and a late commit on a keyless legacy rail.

## Measured results (14 November 2026, Atlas sandbox, simulator, Stripe test mode)

Only numbers that were measured are in this table. Nothing here is a projection.

| What | Result |
|---|---|
| S0 (5 claims), kill at P02 — `nt` | **SAFETY: PASS**. P02 confirmed from provider evidence with no re-send; P13 confirmed after one same-key re-send under a recorded licence; P11 (keyless rail, no evidence) parked as "would not guess"; the 412.60 ticket refund confirmed and read by the auditor from Stripe |
| S0, same kill — `control` | **SAFETY: FAIL, check C1**: Daniel Whitlock (P02) paid **twice** (1,400.00 against 700.00 owed) while its report said once |
| S0 — `nt_mutant` | **SAFETY: FAIL, check C5**: "claimed paid, provider has no such payment" for P13 and P11 |
| Late commit released after the run | `nt`: the watcher confirmed P11 from the new provider object (5 of 5 owed paid, still PASS). `control`: P11 paid twice too (1,800.00 against 900.00) |
| S1 (17 claims), 7 full cycles, judge kill at P05, P02, P01, P03, P06, P07 | `nt` PASS in all 7; `control` FAIL (C1) in all 7; `nt_mutant` FAIL (C5) in all 7. All 17 claims matched the expected outcomes: duplicate agency letter merged into one payment, payee-change request held, French claim resolved, prompt-injection claim held with no effect, goodwill pool never above 500.00 |
| Claim intake (17 claims, live model) | 17 of 17 resolved to the right booking and passengers; median 3.6 s per claim |
| Live AI investigation | about 8 s per in-doubt payment; decisions are made by fixed code, never by the model |
| Vector Search over past investigations (n = 6 investigations with recall, 6 without) | The top recalled record was always the matching past case. **No measurable benefit on S0**: decisions identical, 5.33 vs 4.67 queries, 7.66 s vs 7.60 s mean |
| Kill sweep: 7 crash points × 3 provider faults × 3 positions = 63 cells, a real `SIGKILL` each | **53 PASS, 0 FAIL**; in the other 10 the kill cannot fire by construction (e.g. a rejected request never reaches the after-response barrier) and all 10 were still audited SAFETY PASS. No provider payment was duplicated in any cell. Enumeration of instrumented crash points, not a proof. Details: `out/sweeps/kill-sweep.md` |
| Four arms on S1, kill at P02 (`nt`, `control`, `documented` = stable key per entitlement + retries + checkpoints, `rules_only` = regex parser instead of the model) | Before the keyless late commit lands: `nt` PASS, `documented` **PASS**, `rules_only` PASS, `control` FAIL (P02 paid three times). After it lands: `nt` PASS 10 of 10 (watcher confirms P11 from evidence), `rules_only` PASS, **`documented` FAIL (P11 paid twice while reporting complete)**, `control` FAIL. So documented practice is as safe as Never Twice until a keyless rail commits late — and it completes more before that, because it re-sends where Never Twice parks |
| Model vs regex intake on S1 | **No difference measured**: the regex parser resolved the same 17 of 17 claims as the model (the shared deterministic resolver does most of the work), and never paid a wrong passenger. Caveat: the regex was written after reading the S1 claims, so this is an upper bound for unseen text. On S1 the model's measured contribution is in the investigation, not the intake |
| Goodwill-cap concurrency sweep (N = 1, 5, 10, 25, 50 concurrent proposals; pool at 60% of demand) | **0 violations in 50 runs at each N** (250 runs; ≈95% upper bound 3/50 = 6% per N — sampled evidence, not a proof). With the guard removed (M1) the cap was exceeded in 5 of 5 runs at every N |
| Mutation sweep (each mutation at one code site) | **5 of 5 caught**: M1 → C6 and invariant P2; M2 → C5; M3 (re-send on "not found" without a licence) → C1 + C4, end to end through the real reconciler; M4 (rebuilt request) → C2 + C4; M5 (random intent id) → invariant P1 + C1. The unmutated arm stayed green throughout |
| Automated tests | 759 unit, 167 integration, 19 end-to-end (S0 demo, safety), 61 evaluator self-tests (planted defects EM1–EM9 each turn exactly their check red), 40 dependency-boundary tests |

Confirmed means: the provider holds one payment object matching marker, amount, currency and payee. It does not mean the passenger has received the money.

## How it works

- **One identity per entitlement.** The effect key is built from the booking, passenger, disruption and entitlement type — never from claim text or model output. The payment intent's `_id` is that key, so a second intent for the same entitlement cannot exist.
- **One transaction.** The payment intent, its audit event and any goodwill reservation commit together in one MongoDB transaction before anything is sent. A durable "dispatching" mark is majority-acknowledged before the first byte.
- **Every state change is a compare-and-set** on state and lease epoch, with its audit event in the same transaction. Leases are compared on the database clock.
- **Recovery (Witness).** The AI investigator chooses which provider records to read through read-only tools; a fixed matcher and a fixed decision table decide: confirm on evidence, re-send the frozen request under the same key while the provider still remembers it, or quarantine. Absence of evidence is never treated as proof.
- **The auditor** (`evaluator/`) has zero dependencies, its own copy of the APPR rules, read-only provider keys and no database credential. It commits a manifest hash before the run and grades the provider ledgers against the system's final report.
- **Vector Search** recalls similar past investigations for the investigator. It is advisory: it cannot change a decision.

With a provider that deduplicates on the idempotency key for its retention period, the design gives at most one payment per entitlement. Without that, it does not re-send; it parks the payment. It does not promise exactly-once effects in general.

## Limits

- The entrant wrote the simulator, the system and the auditor; on one laptop their independence is procedural. Partial answers: a judge chooses the kill, a labelled mutant turns the auditor red, and the ticket-refund ledger is Stripe's.
- Audit events are append-only by convention and by database privilege, not cryptographically tamper-evident.
- A provider's acknowledgement is not payment finality; refunds and payouts can fail later (not handled here).
- The EU261 pack (fixture EU1) is computed and graded but EUR payments are not sent (payment documents are CAD-only by design today).

## Running it

Requires Node 24, pnpm 10, a MongoDB replica set (the Atlas sandbox or `pnpm db:up`), and the keys listed in `.env.example` (Stripe **test** keys only; `pnpm check:safety` refuses anything else).

```bash
pnpm install
pnpm db:init
pnpm sim
pnpm demo:reset -- --scenario S0
pnpm demo:start
pnpm demo:go -- --kill-at P02
pnpm demo:resume
pnpm demo:audit
pnpm demo:late-commit
```

Tests: `pnpm test`, `pnpm test:int`, `pnpm test:e2e`, `pnpm test:evaluator`, `pnpm check:safety`.

## Prior work

The closest prior work is **Anchor** (first place, CockroachDB × AWS hackathon, 2026): an intent log, an external call, a hard kill, and a reconciler that asks the provider. Never Twice differs in three ways: it re-sends safely under the same key when licensed, an AI agent runs the investigation while fixed code rules, and an auditor with no access to the system's database grades the result. Related research: arXiv 2610.00349 (budget-conserving reservations), 2610.31916 ("Permission to Retry"), 2609.29095 ("LIMBO").

## Third-party components

npm packages listed in `package.json` files (mongodb, zod, hono, stripe, vite, react, vitest, tsx, concurrently, mongodb-memory-server), MongoDB Atlas, Atlas Vector Search, Voyage AI, Stripe test mode, Anthropic Claude via Claude Code, Docker image `mongodb/mongodb-atlas-local` (optional local database).

License: MIT.
