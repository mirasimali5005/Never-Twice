// pnpm demo:evidence — prints exactly what to type into MongoDB Atlas Data Explorer and Stripe for the CURRENT demo group
// (.nt/current.json), so the documents shown on stage belong to the run on screen. Read-only.
import { readFileSync } from "node:fs";
import { openOwnerDb } from "../lib/env.ts";

const cur = JSON.parse(readFileSync(".nt/current.json", "utf8")) as { group_id: string; runs: Record<string, string> };
const nt = cur.runs["nt"]!;
const control = cur.runs["control"];
const P02 = `${nt}:ZT4H9X.P02.NT101-20261110.APPR_DELAY`;
const P11 = `${nt}:PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING`;
const REFUND = `${nt}:LM2P8D.P03.NT101-20261110.TICKET_REFUND`;

const nt_db = await openOwnerDb();
const db = nt_db.db;
const intents = db.collection<Record<string, any>>("payment_intents");
const p02 = await intents.findOne({ _id: P02 } as never);
const p11 = await intents.findOne({ _id: P11 } as never);
const refund = await intents.findOne({ _id: REFUND } as never);
const audit = await db.collection("audit_events").find({ intent_id: P02 }).sort({ at: 1 }).toArray();
const inv = await db.collection("investigation_records").findOne({ intent_id: P02 });
const probe = await db.collection("probes").findOne({});
await nt_db.close?.();

const line = (s = "") => console.log(s);
line(`DEMO GROUP ${cur.group_id}   Never Twice run ${nt}${control ? `   ordinary agent run ${control}` : ""}`);
line();
line("1) Atlas → never_twice.payment_intents   (the crashed payment)");
line(`   Filter: { "_id": "${P02}" }`);
line(p02 ? `   Shows: state ${p02.state} · lease_epoch ${p02.lease_epoch} · attempts ${p02.attempts?.length} · evidence.source ${p02.evidence?.source ?? "-"} · provider_object_id ${p02.evidence?.provider_object_id ?? "-"}` : "   (not created yet — run the demo first)");
line();
line("2) Atlas → never_twice.audit_events   (the durable state trail)");
line(`   Filter: { "intent_id": "${P02}" }     Options → Sort: { "at": 1 }`);
line(audit.length ? `   Shows ${audit.length} events: ${audit.map((e: any) => `${e.type}${e.to_state ? `→${e.to_state}` : ""}`).join("  ")}` : "   (none yet)");
line();
line("3) Atlas → never_twice.investigation_records   (what the AI looked at)");
line(`   Filter: { "intent_id": "${P02}" }`);
line(inv ? `   Shows: investigator ${inv.investigator} · match ${inv.match} · decision ${inv.decision?.kind ?? "-"} · ${inv.steps?.length ?? 0} queries${inv.embedding ? " · embedding stored (Vector Search)" : ""}` : "   (none yet — appears after Recover)");
line();
line("4) Atlas → never_twice.payment_intents   (the payment it refused to guess)");
line(`   Filter: { "_id": "${P11}" }`);
line(p11 ? `   Shows: state ${p11.state}${p11.quarantine ? ` · quarantine.reason ${p11.quarantine.reason}` : ""}` : "   (not created yet)");
line();
line("5) Atlas → Search & Vector Search (left menu) → index 'investigation_recall' on investigation_records;  never_twice.probes → the AI-written probe");
line(probe ? `   probes: ${String(probe._id).slice(0, 40)}…` : "   (no admitted probe stored)");
line();
line("6) Stripe (test mode) → search the refund id, then open it and show Metadata (nt_marker / nt_run_id link it to Atlas)");
line(refund?.evidence?.provider_object_id ? `   Refund: ${refund.evidence.provider_object_id}   (CA$${(refund.amount_minor / 100).toFixed(2)}, ${refund.state})` : "   (refund not sent yet)");
