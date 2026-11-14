# Generated probe admission rate (Tier 3, task D4)

**Measured, live model, cli backend: 20 of 20 runs admitted on the first attempt (10/10 per tool description); 20 of 20 attempts admitted; 0 rejections; 0 model failures.**

What this measures and what it does not:

- Each run is one live probe-author call (claude-opus-5-5, `claude -p`, effort low, prompt probe-author@1) followed by the FIXED admission code: static checks, then the four canaries in fresh scratch accounts of a private simulator (`--scratch-sim`) with planted ground truth. A rejected spec would have been retried once with the canary failure as feedback; no retry was needed.
- The model wrote the SAME spec in all 20 runs (list endpoint, recipient and created_gte from intent fields, limit 20, marker at `$.metadata.nt_marker`, cursor pagination, max_pages 10). Run-to-run variance at this prompt is effectively zero, so 20 runs are close to one observation, not twenty independent ones.
- Set 2 removes the tool description's warning that search lags; the model still chose the strongly consistent list. The system prompt does say a probe that misses a recent effect causes harm, which is a hint.
- No live run was rejected, so the live sweep does not itself show a canary rejecting anything. That the canaries reject bad specs is shown by the tests with hand-written known-bad specs (packages/recovery/test/probe-canaries.test.ts: lagging search path rejected at canary 1; newest-object-whatever-the-marker rejected at canary 2; wrong marker_path rejected at canary 1; no pagination and too few pages rejected at canary 3; a write endpoint rejected statically with zero requests, and canary 4 fails when both the static check and the read-only credential are removed) and by PRB-09 (a scripted author output that fails canary 1 twice: nothing admitted, 0/2).
- A separate, earlier single run in record mode (`--record-first`, same prompt, same spec, admitted) produced the cassette fixtures/cassettes/a2a3d831….json that scripts/test/probe-author-replay.test.ts replays: the recorded spec is admitted on attempt 1 with no live call. It is not counted in the 20.
- Not built: PRB-08 (end-to-end reconcile of a NotifySim send through the gateway). Contracts are frozen: ProviderObject.kind has no message member and ACCEPTED_STATUSES has no notify provider, so the fixed matcher finds the probe's hit by marker but reports CONTRADICTION STATUS_sent, not MATCH (tested).
- Admission is a test, not a proof.

## Set 1: fixtures/tool-descriptions/notify.send.json (search lag documented)

Measured 2026-11-14T19:25:58.787Z with `pnpm probe:admit -- --tool notify.send --runs 10 --scratch-sim --out out/sweeps/probes.md`.
Model claude-opus-5-5, backend cli, mode live; prompt version probe-author@1; tool schema hash `e14c8306ae5d450f5f82297e87e7df89769a3d1f77cf6cd5e5c527429576c2c2`.
Each run: one model call writes a ProbeSpec; fixed code admits or rejects it (static checks, then four canaries in scratch simulator accounts with planted ground truth); a rejected spec is retried once with the failure as feedback. Admission is a test, not a proof.

**runs admitted 10/10 (first attempt 10/10); attempts admitted 10/10; errors 0.**

| Run | Mode | Time | Attempt | Admitted | Canaries (1 found now, 2 decoy ignored, 3 paginated, 4 state unchanged) | Reason when rejected | Spec |
|---|---|---|---|---|---|---|---|
| 1 | live/live | 3.1 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 2 | live/live | 3.2 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 3 | live/live | 3.4 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 4 | live/live | 3.1 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 5 | live/live | 2.8 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 6 | live/live | 3.0 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 7 | live/live | 3.1 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 8 | live/live | 3.5 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 9 | live/live | 2.9 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 10 | live/live | 2.7 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |


## Set 2: fixtures/tool-descriptions/notify.send.search-lag-undocumented.json (search lag NOT mentioned)

Tool description: `fixtures/tool-descriptions/notify.send.search-lag-undocumented.json` (NotifySim send message (SIMULATOR) - variant whose description does not mention search lag).
Measured 2026-11-14T19:26:43.810Z with `pnpm probe:admit -- --tool notify.send --tool-file fixtures/tool-descriptions/notify.send.search-lag-undocumented.json --runs 10 --scratch-sim --out out/sweeps/probes.md`.
Model claude-opus-5-5, backend cli, mode live; prompt version probe-author@1; tool schema hash `a8153b8e53054e9b485197c0587cdcfca667863cca9bc7e10833e269bd117f85`.
Each run: one model call writes a ProbeSpec; fixed code admits or rejects it (static checks, then four canaries in scratch simulator accounts with planted ground truth); a rejected spec is retried once with the failure as feedback. Admission is a test, not a proof.

**runs admitted 10/10 (first attempt 10/10); attempts admitted 10/10; errors 0.**

| Run | Mode | Time | Attempt | Admitted | Canaries (1 found now, 2 decoy ignored, 3 paginated, 4 state unchanged) | Reason when rejected | Spec |
|---|---|---|---|---|---|---|---|
| 1 | live/live | 2.9 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 2 | live/live | 3.2 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 3 | live/live | 3.1 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 4 | live/live | 2.7 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 5 | live/live | 3.0 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 6 | live/live | 3.0 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 7 | live/live | 2.9 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 8 | live/live | 2.8 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 9 | live/live | 2.9 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |
| 10 | live/live | 3.4 s | 1 | yes | 1:pass 2:pass 3:pass 4:pass |  | GET /v1/messages?account={{account}}&recipient={{payee_ref}}&created_gte={{first_dispatch_at}}&limit=20; items $.data[*]; marker $.metadata.nt_marker; pages starting_after<-$.next_cursor x10 |

