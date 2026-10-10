"""
Operator clustering: one inbox slot per kit, not per domain.

Scam kits are cloned across many domains. Opening twenty copies of the same
page with the same deposit address is twenty times the work for one piece of
evidence. v2 links candidates that share a *strong* key and treats the linked
set as one cluster:

    wallet    the same checksum-valid deposit address
    san       registered on the same TLS certificate as other domains
    service   the same embedded customer-service/chat backend (SPA config)
    favicon   the same uncommon favicon (seen on only a handful of live sites;
              framework/default icons exceed the popularity cap and are ignored)
    favtmpl   the same favicon AND the same page structure

Hosting IPs, nameservers and page templates alone are *not* merge keys: CDNs,
shared hosting and site builders make unrelated sites share them. They are
recorded for the advanced view only.

A shared key is an observation about infrastructure. It is never presented as
proof that the same people run both sites.
"""
from __future__ import annotations

import hashlib

from app.v2 import store

STRONG = ("wallet", "san", "service", "favtmpl", "favicon")
MAX_KEY_POPULARITY = 40          # a key on more domains than this is infrastructure, not a kit
MAX_POPULARITY = {"favicon": 15}  # default/framework icons are shared widely; kit icons are not


def template_key(html: str) -> str:
    from app.discovery.template_similarity import structural_fingerprint
    fp = structural_fingerprint(html or "")
    if len(fp) < 8:
        return ""
    return hashlib.sha1(",".join(str(h) for h in sorted(fp)[:24]).encode()).hexdigest()[:20]


def assign(domain: str, keys: list) -> str:
    """Links `domain` into a cluster via its strong keys; returns the cluster id."""
    store.add_keys(domain, keys)
    linked = set()
    for kt, kv in keys:
        if kt not in STRONG or not kv:
            continue
        if store.key_popularity(kt, kv) > MAX_POPULARITY.get(kt, MAX_KEY_POPULARITY):
            continue
        for other in store.domains_with_key(kt, kv):
            if other == domain:
                continue
            cand = store.get(other)
            if cand and cand.get("cluster_id"):
                linked.add(cand["cluster_id"])
    current = (store.get(domain) or {}).get("cluster_id")
    if current:
        linked.add(current)
    if not linked:
        cid = f"c:{domain}"
    else:
        # keep the cluster that already has decisions, else the oldest
        def rank(c):
            info = store.get_cluster(c) or {}
            return (-(info.get("useful", 0) + info.get("skipped", 0)), info.get("created_at") or 0, c)
        ordered = sorted(linked, key=rank)
        cid = ordered[0]
        for other in ordered[1:]:
            store.merge_clusters(cid, other)
    store.update(domain, cluster_id=cid)
    members = store.cluster_members(cid)
    store.upsert_cluster(cid, domain, len(members))
    return cid


def cluster_wallets(cluster_id: str, exclude: str = "") -> set:
    wallets = set()
    for m in store.cluster_members(cluster_id):
        if m["domain"] == exclude:
            continue
        for kt, kv in store.keys_for(m["domain"]):
            if kt == "wallet":
                wallets.add(kv)
    return wallets
