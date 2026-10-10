"""Authenticated v6 feedback receiver. Stores delivery IDs before acknowledging."""
import hashlib
import hmac
import json
import os
from app import db

ALLOWED={"site.investigated","wallet.validated","wallet.analyzed","evidence.added","relationship.discovered"}

def receive(body:bytes,headers:dict,process=None,ack=None):
    secret=os.environ.get("MAIN_PLATFORM_FEEDBACK_SIGNING_KEY","")
    if not secret or not body or len(body)>1_000_000:return 503,{"error":"receiver_not_configured_or_body_invalid"}
    expected="sha256="+hmac.new(secret.encode(),body,hashlib.sha256).hexdigest()
    signature=headers.get("x-platform-signature","")
    if not hmac.compare_digest(signature,expected):return 401,{"error":"invalid_signature"}
    delivery=headers.get("x-platform-delivery-id","")
    try:message=json.loads(body)
    except (UnicodeDecodeError,json.JSONDecodeError):return 400,{"error":"invalid_payload"}
    if not isinstance(message,dict) or delivery!=message.get("delivery_id") or len(delivery)>240 or message.get("event_type") not in ALLOWED:
        return 400,{"error":"invalid_delivery"}
    if process is None:
        from app.integration.v4.feedback_sync import poll_outcomes
        process=poll_outcomes
    if ack is None:
        from app.integration.v4.client import default_client
        def ack(value):return default_client().sdk._request(f"/api/v1/modules/site_finder/events/{value}","POST")
    try:
        with db.get_conn() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS platform_push_receipts (delivery_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
            already=conn.execute("SELECT 1 FROM platform_push_receipts WHERE delivery_id=?",(delivery,)).fetchone()
        if not already:
            process()
            with db.get_conn() as conn:conn.execute("INSERT OR IGNORE INTO platform_push_receipts(delivery_id,event_id) VALUES (?,?)",(delivery,str(message.get("event_id") or "")))
        ack(delivery)
    except Exception as error:return 503,{"error":"feedback_processing_failed","detail":str(error)[:200]}
    return 200,{"acknowledged":True,"duplicate":bool(already)}
