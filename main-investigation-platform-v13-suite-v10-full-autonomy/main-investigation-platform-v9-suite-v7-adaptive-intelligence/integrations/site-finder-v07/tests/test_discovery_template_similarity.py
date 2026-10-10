"""Tests for app/discovery/template_similarity.py."""
import tempfile
from pathlib import Path

from app.discovery.template_similarity import (
    extract_tag_sequence, structural_fingerprint, similarity, TemplateSimilarityDiscoverer,
)

TEMPLATE_A = """<html><head><title>CryptoGrow</title></head><body>
<nav><a href="/">Home</a><a href="/deposit">Deposit</a><a href="/login">Login</a></nav>
<div class="hero"><h1>Welcome to CryptoGrow</h1><p>Guaranteed 5% daily returns!</p>
<button>Start Investing</button></div>
<div class="plans"><div class="plan">Bronze</div><div class="plan">Silver</div><div class="plan">Gold</div></div>
<footer><p>Copyright CryptoGrow</p></footer>
</body></html>"""

TEMPLATE_A_REBRANDED = """<html><head><title>BitWealth Pro</title></head><body>
<nav><a href="/">Home</a><a href="/deposit">Deposit</a><a href="/login">Login</a></nav>
<div class="hero"><h1>Welcome to BitWealth Pro</h1><p>Guaranteed 8% daily returns!</p>
<button>Start Investing</button></div>
<div class="plans"><div class="plan">Starter</div><div class="plan">Pro</div><div class="plan">VIP</div></div>
<footer><p>Copyright BitWealth</p></footer>
</body></html>"""

UNRELATED_SITE = """<html><head><title>My Personal Blog</title></head><body>
<header><h1>Welcome to my blog</h1></header>
<article><h2>My trip to Japan</h2><p>Last month I visited Tokyo and Kyoto...</p>
<img src="photo1.jpg"><img src="photo2.jpg"></article>
<aside><ul><li>Recent posts</li><li>Categories</li><li>Archive</li></ul></aside>
</body></html>"""


def test_extract_tag_sequence():
    tags = extract_tag_sequence("<html><body><div>text</div></body></html>")
    # Only opening tags are captured (closing tags start with "</", which the
    # regex deliberately doesn't match) — this is sufficient structural signal
    # and cheaper than tracking open/close pairs.
    assert tags == ["html", "body", "div"]


def test_extract_tag_sequence_ignores_attributes():
    tags_with_attrs = extract_tag_sequence('<div class="foo" id="bar">x</div>')
    tags_without_attrs = extract_tag_sequence("<div>x</div>")
    assert tags_with_attrs == tags_without_attrs


def test_same_template_different_content_scores_high_similarity():
    fp_a = structural_fingerprint(TEMPLATE_A)
    fp_b = structural_fingerprint(TEMPLATE_A_REBRANDED)
    score = similarity(fp_a, fp_b)
    assert score >= 0.6, f"expected same-template pages to score >= 0.6, got {score}"


def test_unrelated_sites_score_low_similarity():
    fp_a = structural_fingerprint(TEMPLATE_A)
    fp_c = structural_fingerprint(UNRELATED_SITE)
    score = similarity(fp_a, fp_c)
    assert score < 0.6, f"expected unrelated pages to score < 0.6, got {score}"


def test_identical_html_scores_perfect_similarity():
    fp = structural_fingerprint(TEMPLATE_A)
    assert similarity(fp, fp) == 1.0


def test_empty_html_produces_empty_fingerprint():
    fp = structural_fingerprint("")
    assert fp == frozenset()


def test_similarity_with_empty_fingerprint_is_zero():
    fp_a = structural_fingerprint(TEMPLATE_A)
    fp_empty = structural_fingerprint("")
    assert similarity(fp_a, fp_empty) == 0.0


def test_find_matches_returns_only_above_threshold_sorted_desc():
    disc = TemplateSimilarityDiscoverer()
    target_fp = structural_fingerprint(TEMPLATE_A)
    # A near-but-not-identical structural variant (one extra <span> wrapper) so
    # sorting has something meaningful to distinguish from the byte-identical case.
    slightly_different_structure = TEMPLATE_A.replace("<p>Guaranteed 5% daily returns!</p>",
                                                        "<p><span>Guaranteed 5% daily returns!</span></p>")
    candidates = {
        "same-template-site.test": structural_fingerprint(slightly_different_structure),
        "unrelated-site.test": structural_fingerprint(UNRELATED_SITE),
        "identical-site.test": structural_fingerprint(TEMPLATE_A),
    }
    matches = disc.find_matches(target_fp, candidates)
    labels = [m[0] for m in matches]

    assert "unrelated-site.test" not in labels
    assert "identical-site.test" in labels
    assert "same-template-site.test" in labels
    assert matches[0][0] == "identical-site.test"
    assert matches[0][1] >= matches[1][1]


def test_fingerprint_html_file_handles_missing_file_gracefully():
    disc = TemplateSimilarityDiscoverer()
    with tempfile.TemporaryDirectory() as tmpdir:
        fp = disc.fingerprint_html_file(str(Path(tmpdir) / "does_not_exist.html"))
        assert fp == frozenset()


def test_fingerprint_html_file_reads_real_file():
    disc = TemplateSimilarityDiscoverer()
    with tempfile.TemporaryDirectory() as tmpdir:
        html_file = Path(tmpdir) / "page.html"
        html_file.write_text(TEMPLATE_A, encoding="utf-8")
        fp = disc.fingerprint_html_file(str(html_file))
        assert fp != frozenset()
        assert fp == structural_fingerprint(TEMPLATE_A)
