"""
Template-similarity pivot discoverer.

Scam operations very commonly reuse the same site template/builder across
many domains — same HTML structure, same script includes, same layout —
just with the branding/copy swapped. Two pages built from the same template
will have near-identical DOM *structure* even though the visible text
differs, so a structural fingerprint (not a text fingerprint) is the right
signal here.

This module fingerprints a page's HTML structure using a cheap, dependency-
free technique: extract the sequence of tag names (ignoring attributes and
text content) and hash shingles of that sequence. Two pages built from the
same template produce the same or near-identical fingerprint even with
completely different text/images/wallet addresses.

This operates entirely on HTML we've ALREADY saved locally (the
html_snapshot_path captured during investigation) — no additional network
requests to any site, and no new external service. It's a pure local
correlation step, which is why it's the cheapest and most "passive" of all
the discovery sources.
"""
import hashlib
import logging
import re
from pathlib import Path

logger = logging.getLogger("scamhunter.discovery.template_similarity")

TAG_RE = re.compile(r"<\s*([a-zA-Z][a-zA-Z0-9]*)")
SHINGLE_SIZE = 4       # number of consecutive tags per shingle
NUM_HASHES = 64        # how many shingle hashes make up a fingerprint (minhash-style)


def extract_tag_sequence(html: str) -> list:
    """Returns the sequence of HTML tag names in document order, e.g.
    ['html', 'head', 'title', 'body', 'div', 'nav', 'a', 'a', ...]."""
    return [m.group(1).lower() for m in TAG_RE.finditer(html)]


def _shingles(tags: list, size: int = SHINGLE_SIZE):
    if len(tags) < size:
        if tags:
            yield tuple(tags)
        return
    for i in range(len(tags) - size + 1):
        yield tuple(tags[i:i + size])


def structural_fingerprint(html: str) -> frozenset:
    """
    A minhash-style fingerprint: the set of the NUM_HASHES smallest shingle
    hashes. Two documents with substantially overlapping shingle sets (i.e.
    the same template) will have substantially overlapping fingerprints, and
    Jaccard similarity between two such sets approximates document similarity
    without needing to store or compare the full shingle sets.
    """
    tags = extract_tag_sequence(html)
    if not tags:
        return frozenset()
    hashes = set()
    for shingle in _shingles(tags):
        h = int(hashlib.md5("|".join(shingle).encode()).hexdigest(), 16)
        hashes.add(h)
    smallest = sorted(hashes)[:NUM_HASHES]
    return frozenset(smallest)


def similarity(fp_a: frozenset, fp_b: frozenset) -> float:
    """Jaccard similarity between two fingerprints, 0.0-1.0."""
    if not fp_a or not fp_b:
        return 0.0
    intersection = len(fp_a & fp_b)
    union = len(fp_a | fp_b)
    return intersection / union if union else 0.0


class TemplateSimilarityDiscoverer:
    """
    Correlation pass over pages we've already scanned: not a URL generator on
    its own (there's no new domain to find purely from "these two pages look
    similar" — both are already sites we know about), but it produces
    corroborating evidence connecting existing sites, which the discovery
    engine surfaces as a discovery_event and uses to raise confidence/priority
    on whichever of the pair hasn't been investigated as thoroughly yet. See
    app/discovery/engine.py for how this feeds into scoring.
    """
    name = "template_similarity"
    SIMILARITY_THRESHOLD = 0.6   # Jaccard similarity at/above this counts as "same template"

    def fingerprint_html_file(self, html_path: str) -> frozenset:
        try:
            text = Path(html_path).read_text(errors="ignore")
        except (OSError, FileNotFoundError):
            return frozenset()
        return structural_fingerprint(text)

    def find_matches(self, target_fingerprint: frozenset, candidate_fingerprints: dict) -> list:
        """
        candidate_fingerprints: {label: fingerprint} for other pages/sites to
        compare against (label is typically a site domain or page URL).
        Returns [(label, similarity_score), ...] for anything at/above threshold,
        sorted by similarity descending.
        """
        matches = []
        for label, fp in candidate_fingerprints.items():
            score = similarity(target_fingerprint, fp)
            if score >= self.SIMILARITY_THRESHOLD:
                matches.append((label, score))
        matches.sort(key=lambda t: t[1], reverse=True)
        return matches
