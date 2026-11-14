# Never Twice

**The claims desk that refuses to guess.**

Never Twice is an airline claims desk for statutory passenger compensation under Canada's Air Passenger Protection Regulations, built on MongoDB. AI agents read messy claims; a deterministic rules engine fixes the amount; a gateway reserves the money in MongoDB in one transaction and sends it through a payment provider. When a payment's outcome is unknown after a crash or a lost response, the desk investigates the provider's own records, confirms only on matching evidence, re-sends only the identical request under the same key when a recorded licence allows it, and otherwise parks the payment for a person. A separate auditor with no access to the system's database grades every dollar. The compensation provider is a simulator, Stripe runs in test mode only, and every passenger, booking and claim is synthetic.

Status: Work in progress during the MongoDB Agents in Context hackathon, 14 November 2026.

Design documents, the test plan and the fixture specification were prepared before the event with AI assistance and are not in this repository; all code here was written during the build period with AI coding agents.
