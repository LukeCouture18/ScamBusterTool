# v6.1 known limitations

The stable release has no known release-blocking defect in the tested local architecture.

- Live blockchain providers were not run without user-supplied credentials. Deterministic provider structures, partial results, failover, retries, and provenance were tested.
- Real Google Forms, CAPTCHA, MFA, authenticated third-party sites, anti-bot systems, and live confirmation behavior were not tested or bypassed.
- Hosted Cloudflare D1 migration execution was unavailable. Local Wrangler D1 start/restart and transactional migration crash matrices passed.
- Lint retains 172 advisory warnings in supplied module UI code. There are zero errors and no broad rule suppression.
- External module processes still require the deployment's process supervisor; their normal entry points and restart recovery were tested locally.
