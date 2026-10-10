declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    INGEST_API_KEY?: string;
    MODULE_API_KEYS?: string;
    ALLOW_LEGACY_API_KEY?: string;
    FEEDBACK_WEBHOOK_ALLOWLIST?: string;
    FEEDBACK_SIGNING_KEY?: string;
    FEEDBACK_ALLOW_LOOPBACK_HTTP?: string;
  }
}
