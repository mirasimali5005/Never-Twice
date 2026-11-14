import { useEffect, useMemo, useState } from "react";
import { api, MOCK } from "./api";
import { ArmColumn } from "./components/ArmColumn";
import { AuditorPanel, auditable } from "./components/AuditorPanel";
import { AuditorSummary } from "./components/AuditorSummary";
import { Cases } from "./components/Cases";
import { Comparison } from "./components/Comparison";
import { Hero, type StageName } from "./components/Hero";
import { Investigation } from "./components/Investigation";
import { trailPhase } from "./components/Timeline";
import { isBaseline } from "./trailSteps";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Header } from "./components/Header";
import { ChoiceStrip } from "./components/ChoiceStrip";
import { HowItWorks } from "./components/HowItWorks";
import { Timeline } from "./components/Timeline";
import certNt from "./mocks/certificate.nt.json";
import { mockElapsed, restartMock } from "./mocks/engine";
import type { ApiResult } from "./api";
import type { AnyTrail, ClaimCase, GroupRun, GroupView } from "./types";
import { useResource, useRunData } from "./useRunData";

const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const GROUP_ID = q.get("group") ?? (MOCK ? "g4x8p2nd" : null);
const ARM_PARAM = q.get("arm");
const MANIFEST_PARAM = q.get("manifest");

export function App() {
  const [picked, setPicked] = useState<string | null>(null);
  const [armSel, setArmSel] = useState<string>(ARM_PARAM ?? "nt");
  const [howOpen, setHowOpen] = useState(false);
  const [techOpen, setTechOpen] = useState(false);

  const groupNow = useResource(GROUP_ID, () => api.group(GROUP_ID!), 0, 3000);
  // keep the last good group so a dropped request does not blank the screen; the banner says it is stale
  const [groupKept, setGroupKept] = useState<GroupView | null>(null);
  useEffect(() => {
    if (groupNow?.ok) setGroupKept(groupNow.data);
  }, [groupNow]);
  const group: ApiResult<GroupView> | null = groupKept ? { ok: true, data: groupKept } : groupNow;
  const runs: GroupRun[] = groupKept?.runs ?? [];
  const nt = runs.find((r) => r.arm === "nt");
  const control = runs.find((r) => r.arm === "control" || r.arm === "documented");
  const mutant = runs.find((r) => r.arm === "nt_mutant");

  const ntData = useRunData(nt, picked, true);
  const selectedKey = picked ?? ntData.selectedKey;
  const controlData = useRunData(control, selectedKey, true);
  const mutantData = useRunData(mutant, null, false);

  // the case file in focus: the claim behind the selected entitlement (earliest claim wins; merged duplicates are listed inside it)
  const claims = useResource(nt ? `cl:${nt.run_id}` : null, () => api.claims(nt!.run_id), 0, 5000);
  const claimId = useMemo(() => {
    if (!claims?.ok) return null;
    const list = claims.data;
    const bySelection = selectedKey ? list.filter((c) => c.effect_keys.includes(selectedKey)) : [];
    const ofP02 = list.filter((c) => c.effect_keys.some((k) => k.split(".")[1] === "P02")); // default case file: Daniel Whitlock's
    const pool = bySelection.length > 0 ? bySelection : ofP02.length > 0 ? ofP02 : list;
    return [...pool].sort((a, b) => a.received_at.localeCompare(b.received_at))[0]?.claim_id ?? null;
  }, [claims, selectedKey]);
  const claim = useResource(nt && claimId ? `c:${nt.run_id}:${claimId}` : null, () => api.claim(nt!.run_id, claimId!), 0, 5000);
  const [lastGood, setLastGood] = useState<ApiResult<ClaimCase> | null>(null);
  useEffect(() => {
    if (claim?.ok) setLastGood(claim);
  }, [claim]);
  const shownClaim = claim?.ok ? claim : lastGood ?? claim;

  const entries = [nt, control, mutant].flatMap((r, i) => (r ? [{ run: r, cert: [ntData, controlData, mutantData][i].certificate }] : []));
  const anyAudited = entries.some((e) => auditable(e.cert));
  const paymentsStarted = (ntData.payments?.ok ? ntData.payments.data.length : 0) > 0 || (controlData.payments?.ok ? controlData.payments.data.length : 0) > 0;
  const stripeAmountMinor = (ntData.payments?.ok ? ntData.payments.data : []).find((p) => p.provider === "stripe_refund")?.amount_minor ?? null;

  // payments recovered safely: Never Twice payments whose own record shows an investigation and a CONFIRMED end state
  const ntRows = ntData.payments?.ok ? ntData.payments.data : [];
  const recKey = nt && ntRows.length > 0 ? `rec:${nt.run_id}:${ntRows.map((r) => `${r.effect_key}=${r.state}`).join(",")}` : null;
  const recTrails = useResource<AnyTrail[]>(
    recKey,
    async () => {
      const all = await Promise.all(ntRows.map((r) => api.payment(nt!.run_id, r.effect_key)));
      const bad = all.find((x) => !x.ok);
      if (bad && !bad.ok) return bad;
      return { ok: true, data: all.flatMap((x) => (x.ok ? [x.data] : [])) };
    },
    0,
    MOCK ? undefined : 5000, // an investigation can close after the row's state settles: re-read until the run is still
  );
  const recovered = recTrails?.ok
    ? recTrails.data.filter((t) => !isBaseline(t) && t.intent.state === "CONFIRMED" && (t.investigations ?? []).some((i) => i?.decision)).length
    : null;

  // the demo stage, from real state only
  const ntStatus = ntData.summary?.ok ? ntData.summary.data.status : null;
  const selTrail = ntData.trail?.ok && !isBaseline(ntData.trail.data) ? ntData.trail.data : null;
  const ph = selTrail ? trailPhase(selTrail) : null;
  const stage: StageName | null = !groupKept
    ? null
    : anyAudited
      ? "Audited"
      : ph?.investigated && ph.confirmed
        ? "Recovered"
        : ph?.investigated || ph?.quarantined
          ? "Investigating"
          : ph?.lost
            ? "Crash"
            : paymentsStarted && ntStatus !== "PAUSED"
              ? "Payments sending"
              : "Paused";
  const openTech = () => {
    setTechOpen(true);
    requestAnimationFrame(() => document.getElementById("tech")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const certForManifest = entries.map((e) => (auditable(e.cert) ? e.cert.data : null)).find((c) => c !== null) ?? null;
  const groupManifest = groupKept?.manifest_sha256 ?? null;
  const manifest = {
    hash: groupManifest ?? MANIFEST_PARAM ?? certForManifest?.manifest_sha256 ?? (MOCK ? certNt.manifest_sha256 : null),
    commitment: certForManifest?.commitment_sha256 ?? (MOCK ? certNt.commitment_sha256 : null),
  };
  const groupIntake = groupKept?.intake_mode;
  const intakeReplay = groupIntake ? groupIntake === "replay" : shownClaim?.ok ? shownClaim.data.extraction_meta?.mode === "replay" : false;

  // mock rehearsal helper: a tiny clock and "r" to restart the progression
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!MOCK) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
        restartMock();
        setPicked(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(id);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!GROUP_ID) {
    return (
      <main className="empty">
        <h1>Never Twice</h1>
        <p>the claims desk that refuses to guess</p>
        <p>
          Open this page as <span className="mono">?group=&lt;group_id&gt;</span>, or add <span className="mono">?mock=1</span> to rehearse without a backend.
        </p>
      </main>
    );
  }

  return (
    <div className="desk">
      <ErrorBoundary name="hero" resetKey={group}>
        <Hero group={groupKept} stage={stage} mock={MOCK} stream={ntData.stream} intakeReplay={intakeReplay} onHowItWorks={() => setHowOpen(true)} onEvidence={openTech} />
      </ErrorBoundary>
      {groupNow && !groupNow.ok && (
        <div className="banner banner--error" role="alert">
          Desk API unavailable ({groupNow.error}){groupKept ? ": what you see is the last data received" : ". Nothing below is shown as zero or green"}.
        </div>
      )}
      <div className="stage-row">
        <ErrorBoundary name="comparison" resetKey={[controlData, ntData]}>
          <Comparison control={control ? controlData : null} nt={nt ? ntData : null} hasControl={!!control || !groupKept} hasNt={!!nt || !groupKept} recovered={recovered} />
        </ErrorBoundary>
        <ErrorBoundary name="auditor" resetKey={entries}>
          <AuditorSummary entries={entries} stripeAmountMinor={stripeAmountMinor} />
        </ErrorBoundary>
      </div>
      {!paymentsStarted && !anyAudited && (
        <ErrorBoundary name="passenger list">
          <ChoiceStrip scenario={groupKept?.scenario ?? null} />
        </ErrorBoundary>
      )}
      <ErrorBoundary name="timeline" resetKey={ntData.trail}>
        <Timeline trail={ntData.trail} summary={ntData.summary} />
      </ErrorBoundary>
      <div className="work-row">
        <ErrorBoundary name="cases" resetKey={shownClaim}>
          <Cases rows={ntData.payments} selectedKey={selectedKey} onSelect={setPicked} claim={shownClaim} claims={claims?.ok ? claims.data : []} trail={ntData.trail} />
        </ErrorBoundary>
        <ErrorBoundary name="investigation" resetKey={ntData.trail}>
          <Investigation trail={ntData.trail} />
        </ErrorBoundary>
      </div>
      <details id="tech" className="glass tech" open={techOpen} onToggle={(e) => setTechOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="tech__sum">
          <span className="eyebrow">Technical evidence</span>
          <span className="legend">run ids, manifest, raw payment trails, provider objects, auditor findings</span>
        </summary>
        {techOpen && (
          <div className="tech__body">
            <ErrorBoundary name="header" resetKey={group}>
              <Header groupId={GROUP_ID} group={group} manifest={manifest} mock={MOCK} stream={ntData.stream} intakeReplay={intakeReplay} />
            </ErrorBoundary>
            <main className="cols">
              <ErrorBoundary name="control column" resetKey={controlData}>
                <ArmColumn title="Ordinary agent (control)" kind="control" run={control} data={controlData} selectedKey={selectedKey} onSelect={setPicked} groupReady={groupKept !== null} />
              </ErrorBoundary>
              <ErrorBoundary name="Never Twice column" resetKey={ntData}>
                <ArmColumn title="Never Twice" kind="nt" run={nt} data={ntData} selectedKey={selectedKey} onSelect={setPicked} groupReady={groupKept !== null} />
              </ErrorBoundary>
            </main>
            <ErrorBoundary name="auditor detail" resetKey={entries}>
              <AuditorPanel entries={entries} selectedArm={armSel} onSelect={setArmSel} stripeAmountMinor={stripeAmountMinor} />
            </ErrorBoundary>
          </div>
        )}
      </details>
      <ErrorBoundary name="how it works">
        <HowItWorks open={howOpen} onClose={() => setHowOpen(false)} trail={ntData.trail} goodwill={groupKept?.scenario === "S1"} />
      </ErrorBoundary>
      {MOCK && q.get("clock") === "1" && (
        <div className="mockclock" aria-hidden>
          mock clock {Math.floor(mockElapsed())} s · r restarts
        </div>
      )}
    </div>
  );
}
