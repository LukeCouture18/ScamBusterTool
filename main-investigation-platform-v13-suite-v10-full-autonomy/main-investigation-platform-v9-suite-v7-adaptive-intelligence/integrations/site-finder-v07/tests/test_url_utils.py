"""Tests for app/investigate/url_utils.py — URL normalization and the
VisitedTracker used to guarantee an investigation terminates and never loops."""
from app.investigate.url_utils import normalize_url, VisitedTracker


def test_trailing_slash_normalized():
    assert normalize_url("http://site.com/page") == normalize_url("http://site.com/page/")


def test_www_prefix_normalized():
    assert normalize_url("http://site.com/page") == normalize_url("http://www.site.com/page")


def test_fragment_stripped():
    assert normalize_url("http://site.com/page#section1") == normalize_url("http://site.com/page#section2")
    assert normalize_url("http://site.com/page") == normalize_url("http://site.com/page#top")


def test_tracking_params_stripped():
    assert normalize_url("http://site.com/page?utm_source=fb") == normalize_url("http://site.com/page")
    assert normalize_url("http://site.com/page?fbclid=abc123") == normalize_url("http://site.com/page")


def test_meaningful_query_params_preserved():
    assert normalize_url("http://site.com/page?id=1") != normalize_url("http://site.com/page?id=2")


def test_domain_case_normalized():
    assert normalize_url("http://SITE.com/page") == normalize_url("http://site.com/page")


def test_visited_tracker_catches_all_loop_variants():
    tracker = VisitedTracker(max_pages=10)
    assert not tracker.already_visited("http://site.com/a")
    tracker.mark_visited("http://site.com/a")

    assert tracker.already_visited("http://site.com/a")
    assert tracker.already_visited("http://site.com/a/")
    assert tracker.already_visited("http://www.site.com/a")
    assert tracker.already_visited("http://site.com/a?utm_source=test")
    assert not tracker.already_visited("http://site.com/b")


def test_visited_tracker_enforces_max_pages():
    tracker = VisitedTracker(max_pages=3)
    tracker.mark_visited("http://site.com/a")
    tracker.mark_visited("http://site.com/b")
    assert not tracker.at_limit()
    tracker.mark_visited("http://site.com/c")
    assert tracker.at_limit()
    assert tracker.count() == 3


def test_visited_tracker_count():
    tracker = VisitedTracker(max_pages=100)
    assert tracker.count() == 0
    tracker.mark_visited("http://site.com/a")
    tracker.mark_visited("http://site.com/b")
    tracker.mark_visited("http://site.com/a")  # duplicate, shouldn't double-count
    assert tracker.count() == 2
