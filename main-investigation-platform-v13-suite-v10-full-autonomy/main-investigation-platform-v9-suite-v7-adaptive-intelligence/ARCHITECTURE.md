# Architecture checkpoint

The Main Platform owns persisted investigations, global entities, investigation-specific observations, immutable observation versions, evidence links, event routing, durable jobs, planner decisions, approval and reporting state. Site Finder discovers and triages; Site Investigator gathers site evidence; CryptoWalletLogger passively observes browser evidence; Wallet Investigator analyzes blockchain fixtures or configured providers; Form Submitter validates, prepares, attempts and verifies reports.

The normal request-driven platform handles incoming events synchronously and stores background state in D1. The built Worker now contains a scheduled trigger for platform event recovery, feedback, and monitoring. The five specialized module processes remain independently supervised; no joined five-module production startup has been verified. Refer to `V6_1_AUDIT_REPORT.md` for the actual verified production paths and gaps.
