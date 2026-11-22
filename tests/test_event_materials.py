from unittest.mock import patch

import pytest

from scripts.collect_event_materials import OfficialFetcher, canonical_url, collect_event, extract_page, importance


def test_official_extraction_keeps_attribution_and_resource_types():
    html = '''<html><head><title>SC26</title><meta name="description" content="Official conference news"></head>
    <body><nav><p>Navigation should not appear in excerpts, even when it is long enough to look like a paragraph.</p></nav>
    <main><h1>SC26 Keynote</h1><time datetime="2026-11-17">Tuesday</time>
    <p>The keynote explains the new networking architecture and the technical challenges of scaling high performance computing systems.</p>
    <a href="/slides.pdf">Technical slides</a><a href="https://youtu.be/example">Keynote video</a>
    <a href="javascript:alert(1)">Unsafe</a><a href="/registration">Register</a></main></body></html>'''
    page, links = extract_page(html, "https://sc26.supercomputing.org/news/keynote/")
    assert page["title"] == "SC26 Keynote"
    assert page["published_at"] == "2026-11-17"
    assert page["excerpts"] and "Navigation" not in page["excerpts"][0]
    assert [link["type"] for link in links] == ["pdf", "video"]
    assert all(link["source_url"] == page["url"] for link in links)
    assert links[0]["url"] == "https://sc26.supercomputing.org/slides.pdf"
    assert importance("Keynote technical paper") > importance("General information")


def test_rejects_non_https_credentials_and_custom_ports():
    for url in ["http://example.org", "https://user:pass@example.org", "javascript:alert(1)", "https://example.org:8080"]:
        assert canonical_url(url) is None
    assert canonical_url("/news#top", "https://example.org/dates") == "https://example.org/news"


def test_collection_obeys_budget_domain_boundary_and_records_partial_failure():
    event = {"id": "sc", "cycle": 2026, "name": "SC26", "source_url": "https://official.example/dates"}

    def read(url, **kwargs):
        if url.endswith("/dates"):
            raise ValueError("robots_disallowed")
        return '''<main><h1>SC26</h1><a href="/keynote">Keynote</a>
        <a href="https://untrusted.example/news">News</a><a href="/technical.pdf">Technical PDF</a></main>'''

    with patch("scripts.collect_event_materials.OfficialFetcher.allowed", return_value=True), patch(
        "scripts.collect_event_materials.OfficialFetcher.read", side_effect=read
    ) as fetch:
        payload = collect_event(event, None, max_pages=3)
    assert payload["status"] == "partial"
    assert payload["pages_attempted"] == 3
    assert fetch.call_count == 3
    assert not any("untrusted.example" in call.args[0] for call in fetch.call_args_list)
    assert payload["resources"][0]["type"] == "pdf"
    assert payload["errors"] == [{"url": "https://official.example/dates", "reason": "robots_disallowed"}]


def test_robots_rejection_does_not_fetch_content():
    event = {"id": "sc", "cycle": 2026, "name": "SC26", "source_url": "https://official.example/"}
    with patch("scripts.collect_event_materials.OfficialFetcher.allowed", return_value=False), patch(
        "scripts.collect_event_materials.OfficialFetcher.read"
    ) as fetch:
        payload = collect_event(event, None)
    assert payload["status"] == "failed"
    fetch.assert_not_called()


def test_proceedings_paper_uses_specific_title_and_extracts_long_abstract():
    abstract = "Technical scaling results show improved performance across GPUs. " * 50
    html = '<title>Proceedings</title><h3><span class="var-sub_title">Architecture study</span></h3><p>Authors: ' + 'Name ' * 300 + '<span class="var-main_text_with_paragraphs">' + abstract + '</span></p>'
    page, _ = extract_page(html, "https://official.example/paper")
    assert page["title"] == "Architecture study"
    assert page["excerpts"][0].startswith("Technical scaling")
    assert len(" ".join(page["excerpts"]).split()) <= 120


def test_redirect_to_private_host_is_never_requested():
    class Response:
        is_redirect = True
        headers = {"Location": "https://127.0.0.1/admin"}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    from unittest.mock import Mock
    session = Mock()
    session.get.return_value = Response()
    fetcher = OfficialFetcher(session, {"official.example"})
    with patch("scripts.collect_event_materials.public_host", return_value=True):
        with pytest.raises(ValueError, match="blocked_host"):
            fetcher.read("https://official.example/")
    assert session.get.call_count == 1


def test_redirect_checks_destination_robots_and_access_block_is_not_content():
    class Response:
        is_redirect = True
        headers = {"Location": "/private"}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    from unittest.mock import Mock
    session = Mock()
    session.get.return_value = Response()
    fetcher = OfficialFetcher(session, {"official.example"})
    with patch("scripts.collect_event_materials.public_host", return_value=True), patch.object(fetcher, "allowed", return_value=False):
        with pytest.raises(ValueError, match="robots_disallowed"):
            fetcher.read("https://official.example/", check_robots=True)
    assert session.get.call_count == 1
    with pytest.raises(ValueError, match="site_access_blocked"):
        extract_page("<h1>Sorry, you have been blocked</h1>", "https://official.example/")
