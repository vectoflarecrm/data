from __future__ import annotations

import hashlib
import html
import re
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlsplit

_WS = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    """Collapse all whitespace for hashing / comparison."""
    return _WS.sub(" ", text).strip()


def content_hash(text: str) -> str:
    """sha256 over normalized text; drives idempotency and duplicate-evidence detection."""
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


_IGNORED_TAGS = {"script", "style", "noscript", "template", "head", "svg", "iframe"}
_INLINE = {
    "a",
    "span",
    "b",
    "i",
    "em",
    "strong",
    "u",
    "sub",
    "sup",
    "small",
    "code",
    "abbr",
    "label",
    "q",
}
_CONTAINER_BREAKS = {
    "p",
    "div",
    "section",
    "article",
    "li",
    "tr",
    "br",
    "blockquote",
    "ul",
    "ol",
    "table",
    "header",
    "footer",
    "nav",
    "figure",
}
_HEADINGS = {"h1": "# ", "h2": "## ", "h3": "### ", "h4": "#### ", "h5": "##### ", "h6": "###### "}
_SKIP_LINK_PREFIXES = ("javascript:", "mailto:", "tel:", "#", "data:", "vbscript:")


class _Extractor(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.skip_depth = 0
        self.in_title = False
        self.title_parts: list[str] = []
        self.heading_prefix: str = ""
        self.body_lines: list[str] = []
        self.links: list[str] = []
        self._buffer: list[str] = []

    def flush(self) -> None:
        text = "".join(self._buffer)
        text = re.sub(r"[ \t\r\n]+", " ", text).strip()
        if text:
            self.body_lines.append(f"{self.heading_prefix}{text}")
        self._buffer = []
        self.heading_prefix = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = dict(attrs)
        if tag in _IGNORED_TAGS:
            self.skip_depth += 1
            return
        if tag == "title":
            self.in_title = True
            return
        if self.skip_depth:
            return
        if tag == "a":
            href = attr_map.get("href")
            if href and not href.strip().lower().startswith(_SKIP_LINK_PREFIXES):
                self.links.append(urljoin(self.base_url, href.strip()))
            return
        if tag in _HEADINGS:
            self.flush()
            self.heading_prefix = _HEADINGS[tag]
            return
        if tag in _CONTAINER_BREAKS:
            self.flush()

    def handle_endtag(self, tag: str) -> None:
        if tag in _IGNORED_TAGS:
            if self.skip_depth:
                self.skip_depth -= 1
            return
        if tag == "title":
            self.in_title = False
            return
        if self.skip_depth:
            return
        if tag in _HEADINGS or tag in _CONTAINER_BREAKS:
            self.flush()

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(html.unescape(data))
            return
        if self.skip_depth:
            return
        if data and not data.isspace():
            self._buffer.append(html.unescape(data))


def extract_document(raw: str | bytes, base_url: str) -> dict[str, Any]:
    """Parse HTML into {title, text, markdown, links} using the standard library."""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    parser = _Extractor(base_url)
    try:
        parser.feed(raw)
        parser.close()
    except Exception:  # noqa: BLE001 - tolerate malformed markup
        pass
    title = " ".join(parser.title_parts).strip()
    lines = parser.body_lines
    text = "\n".join(lines).strip()
    markdown = "\n\n".join(lines).strip() or text
    return {
        "title": title,
        "text": text,
        "markdown": markdown,
        "links": _dedupe_links(parser.links),
    }


def normalize_link(link: str, base_url: str | None = None) -> str | None:
    """Resolve, normalize and qualify a raw href into a stable URL."""
    if not link:
        return None
    url = urljoin(base_url, link.strip()) if base_url else link.strip()
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return None
    host = parts.netloc.lower()
    path = parts.path or "/"
    path = re.sub(r"/{2,}", "/", path)
    if path != "/" and path.endswith("/"):
        path = path[:-1]
    rebuilt = f"{parts.scheme}://{host}{path}"
    if parts.query:
        rebuilt += f"?{parts.query}"
    if parts.fragment:
        rebuilt += f"#{parts.fragment}"
    return rebuilt


def _dedupe_links(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = normalize_link(item) or item
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out
