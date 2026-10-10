# Security review checkpoint

Module API authentication is per-module. The TypeScript SDK now fails immediately on authentication 4xx instead of retrying. Form submission remains gated by report approval, schema matching, duplicate checks, and the source adapter's rate and safety checks. Local reporting tests use synthetic evidence and a loopback receiver. Wallet validation is scoped to address format plus observed website evidence.

**Unresolved:** no complete authenticated route audit, payload-size and uploaded evidence path audit, credential redaction sweep, approval-context revocation test, database ownership validation for wallet evidence refs, or hosted penetration test. The platform may be private behind its deployment access gate; that assumption must be verified before production deployment. Do not include provider or form credentials in source control.
