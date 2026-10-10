import { apiError, assertModule, authError, authorizeModule, enforceRateLimit, getBucket, getD1, now, sha256 } from "@/lib/platform";

export async function POST(request: Request) {
  try {
    const size = Number(request.headers.get("content-length") ?? 0); if (size > 25 * 1024 * 1024) return apiError(413, "FILE_TOO_LARGE", "Evidence uploads are limited to 25 MB.");
    const form = await request.formData(); const file = form.get("file"); const sourceModule = String(form.get("source_module") ?? ""); const sourceRecordId = String(form.get("external_id") ?? "");
    if (!(file instanceof File) || !assertModule(sourceModule) || !sourceRecordId) return apiError(400, "VALIDATION_ERROR", "file, source_module, and external_id are required.");
    await authorizeModule(request, sourceModule); await enforceRateLimit(sourceModule);
    if (file.size > 25 * 1024 * 1024) return apiError(413, "FILE_TOO_LARGE", "Evidence uploads are limited to 25 MB.");
    const bytes = await file.arrayBuffer(); const digest = await sha256(bytes); const key = `${sourceModule}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    await getBucket().put(key, bytes, { httpMetadata: { contentType: file.type || "application/octet-stream" }, customMetadata: { sourceModule, sourceRecordId, sha256: digest } });
    const db = getD1(); const existing = await db.prepare("SELECT id, object_key FROM evidence WHERE source_module = ? AND source_record_id = ?").bind(sourceModule, sourceRecordId).first<{ id: string; object_key: string | null }>();
    if (existing?.object_key && existing.object_key !== key) { await getBucket().delete(key); return apiError(409, "EVIDENCE_IMMUTABLE", "That source evidence ID already has stored content. Submit a new external_id for a new file."); }
    const id = existing?.id ?? crypto.randomUUID();
    if (existing) await db.prepare("UPDATE evidence SET title = ?, object_key = ?, media_type = ?, sha256 = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(String(form.get("title") ?? file.name), key, file.type, digest, id).run();
    else await db.prepare("INSERT INTO evidence (id, source_module, source_record_id, evidence_type, title, object_key, media_type, sha256, metadata, provenance, schema_version, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', '1.0', ?)").bind(id, sourceModule, sourceRecordId, String(form.get("evidence_type") ?? "file"), String(form.get("title") ?? file.name), key, file.type, digest, now()).run();
    return Response.json({ id, object_key: key, sha256: digest, size: file.size }, { status: existing ? 200 : 201 });
  } catch (error) {
    const handled = authError(error); if (handled) return handled;
    return apiError(500, "UPLOAD_ERROR", error instanceof Error ? error.message : "Evidence upload failed");
  }
}
