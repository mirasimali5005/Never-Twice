# Arms comparison, scenario S1 (sandbox, measured)

One group (`ga2nqh4e`, manifest sha256 `b9857f32c269b0775172c7ccd17a86458e6e53af233f632b3d9aaf3209a36c37`, committed before the run), one run per arm, each against its own simulator account with fault schedule F-DEMO (P11 keyless-rail late commit held until released; P13 request dropped once), the same 17 claims, recorded model outputs (replay), Stripe in test mode. Every arm was started with `--pause-before-payout`, the same go file `{"kill_at_passenger":"P02"}` was written, each arm was SIGKILLed at its crash barrier for P02's statutory payment (all four exited 137), then restarted. `nt` and `rules_only` were then reconciled (`pnpm reconcile -- --until-drained`), every report was rewritten with `--report-only`, and every run was graded by `pnpm evaluator:check`. Everything below is copied from those certificates.

## Table 1: after kill, restart and reconciliation (the late commit on P11 has not landed)

| Arm | Run | Safety verdict | Completion line |
|---|---|---|---|
| nt | rniium8r | `SAFETY: PASS` | `owed paid 9 of 10; refusals correct 4 of 4; holds 4 of 4; over-parked 1; goodwill 500.00 of 800.00` |
| control (A) | rg32x8im | `SAFETY: FAIL` | `owed paid 10 of 10; refusals correct 4 of 4; holds 4 of 4; over-parked 0; goodwill 500.00 of 800.00` |
| documented (B) | rcnbixv6 | `SAFETY: PASS` | `owed paid 10 of 10; refusals correct 4 of 4; holds 4 of 4; over-parked 0; goodwill 500.00 of 800.00` |
| rules_only (R) | rgtofrr3 | `SAFETY: PASS` | `owed paid 9 of 10; refusals correct 4 of 4; holds 4 of 4; over-parked 1; goodwill 500.00 of 800.00` |

Findings:

- **nt**: none
- **control (A)**: 
  - C1 duplicate        ZT4H9X.P02.NT101-20261110.APPR_DELAY  3 provider payments for one entitlement  [po_acf4540d645fd598, po_850349aaa12e97b8, po_d75ce6a9b2522153]
  - C4 unrecorded       ZT4H9X.P02.NT101-20261110.APPR_DELAY  provider holds this payment and the report's paid list does not (report lists the entitlement under paid)  [po_acf4540d645fd598]
- **documented (B)**: none
- **rules_only (R)**: none

## Table 2: after P11's held late commit lands on every account (`POST /admin/faults/release`), the `nt` and `rules_only` watchers run, reports rewritten

| Arm | Run | Safety verdict | Completion line |
|---|---|---|---|
| nt | rniium8r | `SAFETY: PASS` | `owed paid 10 of 10; refusals correct 4 of 4; holds 4 of 4; over-parked 0; goodwill 500.00 of 800.00` |
| control (A) | rg32x8im | `SAFETY: FAIL` | `owed paid 10 of 10; refusals correct 4 of 4; holds 4 of 4; over-parked 0; goodwill 500.00 of 800.00` |
| documented (B) | rcnbixv6 | `SAFETY: FAIL` | `owed paid 10 of 10; refusals correct 4 of 4; holds 4 of 4; over-parked 0; goodwill 500.00 of 800.00` |
| rules_only (R) | rgtofrr3 | `SAFETY: PASS` | `owed paid 10 of 10; refusals correct 4 of 4; holds 4 of 4; over-parked 0; goodwill 500.00 of 800.00` |

Findings:

- **nt**: none
- **control (A)**: 
  - C1 duplicate        ZT4H9X.P02.NT101-20261110.APPR_DELAY            3 provider payments for one entitlement  [po_acf4540d645fd598, po_850349aaa12e97b8, po_d75ce6a9b2522153]
  - C1 duplicate        PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING  2 provider payments for one entitlement  [po_ca4e02721fd1c84c, po_d5e6387c64372528]
  - C4 unrecorded       ZT4H9X.P02.NT101-20261110.APPR_DELAY            provider holds this payment and the report's paid list does not (report lists the entitlement under paid)  [po_acf4540d645fd598]
  - C4 unrecorded       PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING  provider holds this payment and the report's paid list does not (report lists the entitlement under paid)  [po_d5e6387c64372528]
- **documented (B)**: 
  - C1 duplicate        PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING  2 provider payments for one entitlement  [po_b26457be4ce21104, po_82121ef6e8ca98b8]
  - C4 unrecorded       PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING  provider holds this payment and the report's paid list does not (report lists the entitlement under paid)  [po_82121ef6e8ca98b8]
- **rules_only (R)**: none

## What each arm's own final report said (after Table 2)

| Arm | `complete` | paid | refused | parked | failed_no_effect | unresolved |
|---|---|---|---|---|---|---|
| nt | true | 13 | 4 | 4 | 0 | 0 |
| control (A) | true | 15 | 4 | 3 | 0 | 0 |
| documented (B) | true | 14 | 4 | 3 | 0 | 0 |
| rules_only (R) | true | 13 | 4 | 4 | 0 | 0 |

`complete` for `nt` and `rules_only` became true only after reconciliation (it was `false`, `unresolved=3`, straight after the restart). Arms A and B reported `complete=true` at the end of their pass, before and after the late commit, with `unresolved` empty.

## Reading it, measured only

- At the S0-style kill (P02 killed right after the provider answered, all arms restarted): control paid P02 three times (two claims name P02, the second claim and the restart each paid again under a fresh key). `documented` paid P02 once: the stable key (the same marker Never Twice uses) made the provider return the first payment. `nt` and `rules_only` paid once.
- **On this measure `documented` is as safe as Never Twice: Table 1 shows `SAFETY: PASS` for both, and `documented` completed more (owed paid 10 of 10 against 9 of 10) because `nt` parks the keyless-rail payment P11 as "would not guess" while `documented` re-sent it.**
- When P11's held late commit landed (Table 2), `documented` failed C1 (two provider payments for P11) and C4 (the provider holds a payment its report does not list), while still reporting `complete=true` with nothing unresolved. `nt` and `rules_only` stayed `PASS`, and the reconciler's watcher confirmed P11 from the late-landing payment, taking them to 10 of 10 owed paid.
- `rules_only` (regex parser instead of the model) produced the same S1 verdict and completion as `nt` at both points. See the regex measurement in tasks/reports/ARMS.md: it resolved the same 16 of 17 claims as the model and never a different passenger.
- Not measured here (not part of this run): the goodwill cap under concurrency (one worker per arm), and any run with Stripe disabled.
