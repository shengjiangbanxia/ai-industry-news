#!/usr/bin/env python3
"""Collect bounded, attributed excerpts and resource links from official event pages.

No model, paid search, social API, cookies, or browser automation is used.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import re
import socket
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

USER_AGENT = "AIIndustryNewsRadarEventCollector/1.0"
MAX_BYTES = 1_500_000
MAX_PAGES = 16
KEYWORDS = {
    "keynote": 6, "plenary": 6, "press-release": 6, "announcement": 5,
    "news": 4, "technical": 4, "paper": 4, "research": 4, "session": 3,
    "program": 3, "schedule": 3, "agenda": 3, "video": 3, "slides": 4,
    "proceedings": 5, "archive": 3, "主旨": 6, "发布": 5, "技术": 4,
}
SKIP = re.compile(r"login|sign-in|register|registration|privacy|cookie|sponsor|hotel|travel|contact", re.I)


def canonical_url(value: str, base: str = "") -> str | None:
    parts = urlsplit(urljoin(base, value))
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.port not in (None, 443):
        return None
    return urlunsplit((parts.scheme, parts.netloc.lower(), parts.path or "/", parts.query, ""))


def public_host(host: str) -> bool:
    try:
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        return bool(addresses) and all(ipaddress.ip_address(row[4][0]).is_global for row in addresses)
    except (OSError, ValueError):
        return False


def importance(text: str) -> int:
    value = text.lower()
    return sum(weight for term, weight in KEYWORDS.items() if term in value)


def resource_type(url: str) -> str:
    path = urlsplit(url).path.lower()
    host = (urlsplit(url).hostname or "").lower()
    if path.endswith(".pdf"):
        return "pdf"
    if path.endswith((".ppt", ".pptx")):
        return "slides"
    if host in {"youtu.be", "youtube.com", "www.youtube.com", "vimeo.com", "www.vimeo.com"}:
        return "video"
    return "page"


def extract_page(html: str, url: str) -> tuple[dict, list[dict]]:
    soup = BeautifulSoup(html, "html.parser")
    paper_titles = soup.select(".var-sub_title")
    heading = (paper_titles[0] if len(paper_titles) == 1 else None) or soup.find("h1") or soup.find("h2") or soup.find("title")
    title = heading.get_text(" ", strip=True) if heading else urlsplit(url).hostname
    if re.search(r"attention required|just a moment|access denied|sorry, you have been blocked", str(title), re.I):
        raise ValueError("site_access_blocked")
    meta = soup.find("meta", attrs={"name": "description"}) or soup.find("meta", attrs={"property": "og:description"})
    description = re.sub(r"\s+", " ", str(meta.get("content", ""))).strip()[:500] if meta else ""
    published = soup.find("meta", attrs={"property": "article:published_time"})
    times = soup.find_all("time")
    time = times[0] if len(times) == 1 else None
    published_at = str(published.get("content") or "") if published else str(time.get("datetime") or time.get_text(strip=True)) if time else ""
    links = []
    for anchor in soup.select("a[href]"):
        try:
            target = canonical_url(str(anchor.get("href")), url)
        except ValueError:
            continue
        label = re.sub(r"\s+", " ", anchor.get_text(" ", strip=True))[:240]
        if target and not SKIP.search(label + " " + urlsplit(target).path):
            links.append({"url": target, "title": label or urlsplit(target).path, "type": resource_type(target), "source_url": url})
    for element in soup.select("script, style, nav, footer, header, aside, form"):
        element.decompose()
    body = soup.find("article") or soup.find("main") or soup.body or soup
    excerpts = []
    for element in body.select(".var-main_text_with_paragraphs") or body.select("p, li"):
        text = re.sub(r"\s+", " ", element.get_text(" ", strip=True)).strip()
        if len(text) < 65 or text in excerpts:
            continue
        # Short attributed excerpts, rather than republishing full articles.
        remaining = 120 - len(" ".join(excerpts).split())
        if remaining < 20:
            break
        words = text.split()
        excerpt = " ".join(words[:remaining])[:600]
        excerpts.append(excerpt + ("…" if len(excerpt) < len(text) else ""))
        if len(excerpts) == 3:
            break
    category_text = (str(title) + " " + url).lower()
    category = "主旨演讲" if re.search(r"keynote|plenary|主旨", category_text) else "技术报告" if re.search(r"paper|proceedings|technical|research|技术", category_text) else "官方发布" if re.search(r"news|announcement|press|发布", category_text) else "大会信息"
    return {"url": url, "title": str(title)[:300], "description": description, "category": category,
            "published_at": published_at[:100] or None, "excerpts": excerpts,
            "importance_score": importance(str(title) + " " + url), "type": "page"}, links


class OfficialFetcher:
    def __init__(self, session: requests.Session, hosts: set[str]):
        self.session, self.hosts = session, hosts
        self.robots: dict[str, RobotFileParser] = {}

    def read(self, url: str, *, check_robots: bool = False) -> str:
        # Validate every redirect, and bound downloads before parsing.
        for _ in range(5):
            host = urlsplit(url).hostname or ""
            if host not in self.hosts or not public_host(host):
                raise ValueError("blocked_host")
            with self.session.get(url, timeout=15, allow_redirects=False, stream=True,
                                  headers={"User-Agent": USER_AGENT}) as response:
                if response.is_redirect:
                    target = canonical_url(response.headers.get("Location", ""), url)
                    if not target:
                        raise ValueError("blocked_redirect")
                    if check_robots and not self.allowed(target):
                        raise ValueError("robots_disallowed")
                    url = target
                    continue
                response.raise_for_status()
                content_type = response.headers.get("Content-Type", "").lower()
                if not any(t in content_type for t in ("text/html", "text/plain", "application/xhtml+xml")):
                    raise ValueError("unsupported_content_type")
                chunks, size = [], 0
                for chunk in response.iter_content(65536):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError("page_too_large")
                    chunks.append(chunk)
                content = b"".join(chunks)
                self.last_url = url
                encoding = response.encoding if response.encoding and response.encoding.lower() != "iso-8859-1" else "utf-8"
                return content.decode(encoding, errors="replace")
        raise ValueError("too_many_redirects")

    def allowed(self, url: str) -> bool:
        origin = "https://" + urlsplit(url).netloc
        if origin not in self.robots:
            robot = RobotFileParser()
            try:
                robot.parse(self.read(origin + "/robots.txt").splitlines())
            except requests.HTTPError as exc:
                robot.parse([] if exc.response.status_code == 404 else ["User-agent: *", "Disallow: /"])
            except (requests.RequestException, ValueError):
                robot.parse(["User-agent: *", "Disallow: /"])
            self.robots[origin] = robot
        return self.robots[origin].can_fetch(USER_AGENT, url)


def collect_event(event: dict, session: requests.Session, max_pages: int = MAX_PAGES) -> dict:
    seeds = [event["source_url"], *event.get("research_sources", [])]
    seeds = [canonical_url(url) for url in seeds]
    if not all(seeds):
        raise ValueError("invalid_official_source")
    hosts = {urlsplit(url).hostname for url in seeds}
    # Also discover the official conference homepage when the source is a dates page.
    seeds = list(dict.fromkeys([*seeds, *("https://" + urlsplit(url).netloc + "/" for url in seeds)]))
    fetcher = OfficialFetcher(session, hosts)
    queue = [(100, url) for url in seeds]
    seen, resources, pages, errors = set(), {}, [], []
    sections: dict[str, int] = {}
    budget = max(1, min(max_pages, MAX_PAGES))
    while queue and len(seen) < budget:
        queue.sort(key=lambda row: (-row[0], row[1]))
        _, url = queue.pop(0)
        if url in seen:
            continue
        section = "/".join(urlsplit(url).path.strip("/").split("/")[:2])
        if sections.get(section, 0) >= 4:
            continue
        sections[section] = sections.get(section, 0) + 1
        seen.add(url)
        try:
            if not fetcher.allowed(url):
                raise ValueError("robots_disallowed")
            html = fetcher.read(url, check_robots=True)
            page, links = extract_page(html, getattr(fetcher, "last_url", url))
            signature = (page["title"], page["description"], tuple(page["excerpts"]))
            if not any((row["title"], row["description"], tuple(row["excerpts"])) == signature for row in pages):
                pages.append(page)
            for link in links:
                target = link["url"]
                kind = link["type"]
                score = importance(link["title"] + " " + target)
                same_host = urlsplit(target).hostname in hosts
                if kind in {"pdf", "slides", "video"}:
                    resources.setdefault(target, link)
                elif same_host and score > 0 and target not in seen:
                    if len(queue) < 150:
                        queue.append((score, target))
        except (requests.RequestException, ValueError) as exc:
            errors.append({"url": url, "reason": type(exc).__name__ if isinstance(exc, requests.RequestException) else str(exc)})
    pages.sort(key=lambda item: (-item["importance_score"], item["url"]))
    return {
        "event_id": event["id"], "cycle": event["cycle"], "name": event["name"],
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "method": "official_pages_no_llm", "status": "partial" if pages and errors else "ok" if pages else "failed",
        "notice": "按官网栏目和关键词筛选；简介与摘录来自原文，未使用大模型分析。外链资料未下载或核验全文。",
        "pages": pages, "resources": list(resources.values())[:80], "errors": errors,
        "pages_attempted": len(seen), "max_pages": budget,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--cycle", required=True, type=int)
    parser.add_argument("--config", default="config/industry-events.json")
    parser.add_argument("--output-dir", default="data/event-materials")
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    event = next((row for row in config["events"] if row["id"] == args.event_id and row["cycle"] == args.cycle), None)
    if not event or not re.fullmatch(r"[a-z0-9-]+", args.event_id):
        parser.error("Unknown event/cycle")
    with requests.Session() as session:
        payload = collect_event(event, session)
    path = Path(args.output_dir) / f"{args.event_id}-{args.cycle}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    # Keep previously collected useful material if a later attempt fails completely.
    if payload["status"] == "failed":
        print(json.dumps({"status": "failed", "errors": payload["errors"]}, ensure_ascii=False))
        return 1
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Collected {len(payload['pages'])} pages and {len(payload['resources'])} resource links: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
