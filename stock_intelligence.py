"""Public-source market evidence, AI value-chain taxonomy, and signal scoring.

The module deliberately consumes only public feeds/APIs.  It does not log in to,
bypass, or scrape the body of paywalled pages.  Bloomberg, Reuters,
Investing.com, and similar publishers can still appear when their public
headline metadata is exposed by Yahoo Finance or Google News RSS.

All scoring functions accept plain dictionaries and an injectable HTTP session,
which keeps the unit tests deterministic and independent of the live web.
"""

from __future__ import annotations

import json
import math
import os
import re
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from urllib.parse import quote_plus, urlparse

import requests


DEFAULT_LOOKBACK_DAYS = 120
MAX_EVIDENCE_ITEMS = 18


# Scores are editorial-quality priors, not assertions that every article from a
# publisher is correct.  Relevance, freshness, corroboration and noise penalties
# are applied separately below.
SOURCE_REPUTATION = {
    "sec.gov": 1.00,
    "investor relations": 0.98,
    "company filing": 0.98,
    "reuters": 0.97,
    "bloomberg": 0.96,
    "wall street journal": 0.94,
    "wsj": 0.94,
    "financial times": 0.93,
    "associated press": 0.91,
    "ap news": 0.91,
    "barron's": 0.88,
    "cnbc": 0.86,
    "marketwatch": 0.84,
    "yahoo finance": 0.82,
    "investing.com": 0.80,
    "nasdaq": 0.82,
    "business wire": 0.74,
    "globe newswire": 0.72,
    "pr newswire": 0.72,
    "seeking alpha": 0.60,
    "the motley fool": 0.52,
    "motley fool": 0.52,
    "reddit": 0.32,
    "stocktwits": 0.28,
    "twitter": 0.26,
    "x.com": 0.26,
}

SOURCE_DOMAIN_REPUTATION = {
    "sec.gov": 1.00,
    "reuters.com": 0.97,
    "bloomberg.com": 0.96,
    "wsj.com": 0.94,
    "ft.com": 0.93,
    "apnews.com": 0.91,
    "barrons.com": 0.88,
    "cnbc.com": 0.86,
    "marketwatch.com": 0.84,
    "finance.yahoo.com": 0.82,
    "investing.com": 0.80,
    "nasdaq.com": 0.82,
    "businesswire.com": 0.74,
    "globenewswire.com": 0.72,
    "prnewswire.com": 0.72,
    "seekingalpha.com": 0.60,
    "fool.com": 0.52,
    "reddit.com": 0.32,
    "stocktwits.com": 0.28,
    "twitter.com": 0.26,
    "x.com": 0.26,
}


AI_THEME_KEYWORDS = {
    "HYPERSCALER": (
        "hyperscale", "hyperscaler", "cloud platform", "cloud infrastructure",
        "azure", "aws", "google cloud", "data-center capex", "data center capex",
    ),
    "AI_COMPUTE": (
        "gpu", "accelerator", "ai chip", "compute semiconductor", "custom silicon",
        "inference chip", "integrated circuit design",
    ),
    "WAFER_FOUNDRY": (
        "foundry", "wafer fabrication", "wafer fab", "fabless", "process node",
        "advanced packaging", "chip manufacturing", "semiconductor fabrication",
    ),
    "SEMI_EQUIPMENT": (
        "lithography", "wafer equipment", "process control", "etch", "deposition",
        "metrology", "semiconductor equipment",
    ),
    "PHOTONICS_OPTICS": (
        "photonics", "silicon photonics", "optical transceiver", "co-packaged optics",
        "laser diode", "datacom optics", "optical networking",
    ),
    "MEMORY_STORAGE": (
        "dram", "hbm", "nand", "memory chip", "data storage", "hard disk",
    ),
    "DATA_CENTER_POWER": (
        "data center power", "fuel cell", "backup power", "ups system", "switchgear",
        "power management", "thermal management", "liquid cooling", "microgrid",
    ),
    "POWER_GENERATION": (
        "power generation", "nuclear power", "natural gas generation", "grid capacity",
        "electricity demand", "independent power producer",
    ),
    "AI_CLOUD_INFRA": (
        "gpu cloud", "ai cloud", "compute hosting", "ai infrastructure provider",
    ),
    "AI_SOFTWARE": (
        "ai software", "data platform", "machine learning platform", "application software",
    ),
}


TICKER_THEME_OVERRIDES = {
    # Hyperscalers / platforms
    "MSFT": "HYPERSCALER", "GOOG": "HYPERSCALER", "GOOGL": "HYPERSCALER",
    "AMZN": "HYPERSCALER", "META": "HYPERSCALER", "ORCL": "HYPERSCALER",
    # AI compute and semiconductor design
    "NVDA": "AI_COMPUTE", "AMD": "AI_COMPUTE", "AVGO": "AI_COMPUTE",
    "MRVL": "AI_COMPUTE", "ARM": "AI_COMPUTE", "CRDO": "AI_COMPUTE",
    # Foundries / wafer fabrication
    "TSM": "WAFER_FOUNDRY", "INTC": "WAFER_FOUNDRY", "GFS": "WAFER_FOUNDRY",
    "UMC": "WAFER_FOUNDRY", "SMIC": "WAFER_FOUNDRY",
    # Wafer-fab equipment and process control
    "ASML": "SEMI_EQUIPMENT", "AMAT": "SEMI_EQUIPMENT", "LRCX": "SEMI_EQUIPMENT",
    "KLAC": "SEMI_EQUIPMENT", "ONTO": "SEMI_EQUIPMENT", "CAMT": "SEMI_EQUIPMENT",
    "ACMR": "SEMI_EQUIPMENT", "MKSI": "SEMI_EQUIPMENT", "UCTT": "SEMI_EQUIPMENT",
    # Photonics / optical interconnect
    "COHR": "PHOTONICS_OPTICS", "LITE": "PHOTONICS_OPTICS", "AAOI": "PHOTONICS_OPTICS",
    "FN": "PHOTONICS_OPTICS", "IPGP": "PHOTONICS_OPTICS", "CIEN": "PHOTONICS_OPTICS",
    # Memory / storage
    "MU": "MEMORY_STORAGE", "WDC": "MEMORY_STORAGE", "STX": "MEMORY_STORAGE",
    "SNDK": "MEMORY_STORAGE", "SIMO": "MEMORY_STORAGE", "RMBS": "MEMORY_STORAGE",
    # Data-center electrical, thermal and distributed generation (including Bloom)
    "BE": "DATA_CENTER_POWER", "VRT": "DATA_CENTER_POWER", "ETN": "DATA_CENTER_POWER",
    "GEV": "DATA_CENTER_POWER", "PWR": "DATA_CENTER_POWER", "CARR": "DATA_CENTER_POWER",
    # Generators / grid beneficiaries
    "CEG": "POWER_GENERATION", "VST": "POWER_GENERATION", "NRG": "POWER_GENERATION",
    # GPU cloud / AI infrastructure
    "CRWV": "AI_CLOUD_INFRA", "NBIS": "AI_CLOUD_INFRA", "IREN": "AI_CLOUD_INFRA",
}


POSITIVE_PHRASES = {
    "raises guidance": 1.00, "raised guidance": 1.00, "guidance raised": 1.00,
    "beats estimates": 0.85, "beat estimates": 0.85, "earnings beat": 0.80,
    "revenue beat": 0.80, "price target raised": 0.65, "target raised": 0.60,
    "upgraded to buy": 0.80, "analyst upgrade": 0.65, "wins contract": 0.75,
    "contract award": 0.70, "record revenue": 0.75, "strong demand": 0.65,
    "capacity sold out": 0.75, "strategic partnership": 0.45,
    "margin expansion": 0.65, "free cash flow growth": 0.65,
    "data center demand": 0.45, "ai demand": 0.45, "backlog growth": 0.65,
}

NEGATIVE_PHRASES = {
    "cuts guidance": -1.00, "cut guidance": -1.00, "guidance cut": -1.00,
    "misses estimates": -0.85, "missed estimates": -0.85, "earnings miss": -0.80,
    "revenue miss": -0.80, "price target cut": -0.65, "target cut": -0.60,
    "downgraded to sell": -0.85, "analyst downgrade": -0.65,
    "margin pressure": -0.55, "weak demand": -0.70, "order cancellation": -0.85,
    "contract cancelled": -0.85, "accounting investigation": -0.95,
    "sec investigation": -0.90, "antitrust probe": -0.60, "export restriction": -0.70,
    "production delay": -0.65, "capacity delay": -0.60, "dilutive offering": -0.75,
    "going concern": -1.00, "default risk": -0.95, "backlog decline": -0.65,
}

FINANCE_CATALYST_TERMS = (
    "earnings", "revenue", "guidance", "margin", "forecast", "price target",
    "analyst", "upgrade", "downgrade", "contract", "order", "backlog", "capex",
    "cash flow", "acquisition", "merger", "investigation", "filing", "demand",
    "shipment", "capacity", "data center", "semiconductor", "wafer", "photonics",
    "power", "gpu", "cloud", "ai",
)

NOISE_PHRASES = (
    "you won't believe", "must buy now", "next 100x", "to the moon", "guaranteed",
    "secret stock", "millionaire maker", "this one trick", "urgent alert",
    "could make you rich", "get rich", "hot stock tip", "🚀🚀", "!!!",
)


def _utc_now():
    return datetime.now(timezone.utc)


def _coerce_datetime(value):
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)):
        # Yahoo sometimes supplies seconds, sometimes milliseconds.
        timestamp = float(value)
        if timestamp > 10_000_000_000:
            timestamp /= 1000.0
        try:
            parsed = datetime.fromtimestamp(timestamp, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    else:
        raw = str(value or "").strip()
        if not raw:
            return None
        try:
            parsed = parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            try:
                parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                try:
                    parsed = datetime.strptime(raw, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
                except ValueError:
                    return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _plain_text(value):
    text = re.sub(r"<[^>]+>", " ", unescape(str(value or "")))
    return " ".join(text.split())


def _safe_public_url(value):
    url = str(value or "").strip()
    try:
        parsed = urlparse(url)
    except ValueError:
        return ""
    return url if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def infer_ai_theme(ticker, company_text=""):
    """Return a focused AI-infrastructure theme without asking an LLM to guess."""
    symbol = str(ticker or "").strip().upper()
    if symbol in TICKER_THEME_OVERRIDES:
        return TICKER_THEME_OVERRIDES[symbol]
    haystack = str(company_text or "").lower()
    matches = []
    for theme, keywords in AI_THEME_KEYWORDS.items():
        count = sum(1 for keyword in keywords if keyword in haystack)
        if count:
            matches.append((count, theme))
    return max(matches)[1] if matches else "GENERAL_AI"


def current_calendar_year(value, *, as_of=None):
    parsed = _coerce_datetime(value)
    current = _coerce_datetime(as_of) or _utc_now()
    return bool(parsed and current and parsed.year == current.year and parsed <= current)


def validate_current_year_analyst_record(
    record,
    ticker,
    company_name,
    current_price,
    *,
    as_of=None,
):
    """Validate a sourced analyst action without trusting its producer blindly.

    Gemini, provider APIs and public-feed extraction all pass this same boundary.
    An implausible numeric target is removed; a rating-only row may remain, but a
    row with neither a rating nor a usable target is rejected. The issuer and
    generic publisher names cannot be presented as the sell-side firm.
    """
    if not isinstance(record, dict) or not current_calendar_year(record.get("date"), as_of=as_of):
        return None
    url = _safe_public_url(record.get("source_url"))
    if not url:
        return None
    firm = " ".join(str(record.get("firm") or "").split()).strip()
    firm_key = _organization_key(firm)
    company_key = _organization_key(company_name)
    rejected_firms = {
        "", company_key, _organization_key(ticker), "not disclosed",
        "reuters", "bloomberg", "yahoo finance", "investing com",
        "google news", "gdelt", "wall street", "analyst",
    }
    if firm_key in rejected_firms:
        return None

    cleaned = dict(record)
    cleaned["firm"] = firm
    cleaned["source_url"] = url
    try:
        price = float(current_price)
    except (TypeError, ValueError):
        price = 0.0

    def plausible_target(value):
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(number) or number <= 0:
            return None
        if price > 0 and not (price * 0.20 <= number <= price * 5.0):
            return None
        return number

    cleaned["price_target"] = plausible_target(record.get("price_target"))
    cleaned["previous_price_target"] = plausible_target(record.get("previous_price_target"))
    rating = str(cleaned.get("new_rating") or "N/A").strip()
    cleaned["new_rating"] = rating or "N/A"
    if cleaned["price_target"] is None and cleaned["new_rating"].upper() == "N/A":
        return None
    return cleaned


def source_reputation(source="", url=""):
    domain = urlparse(str(url or "")).netloc.lower().split(":", 1)[0]
    domain = domain[4:] if domain.startswith("www.") else domain
    for known_domain, score in SOURCE_DOMAIN_REPUTATION.items():
        if domain == known_domain or domain.endswith("." + known_domain):
            return score
    source_normalized = " ".join(re.sub(r"[^a-z0-9]+", " ", str(source or "").lower()).split())
    for marker, score in SOURCE_REPUTATION.items():
        marker_normalized = " ".join(re.sub(r"[^a-z0-9]+", " ", marker.lower()).split())
        if source_normalized == marker_normalized or source_normalized.startswith(marker_normalized + " "):
            return score
    return 0.46


def _configured_author_scores():
    raw = os.environ.get("MARKET_AUTHOR_REPUTATION_JSON", "").strip()
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            return {}
        return {
            str(name).strip().lower(): max(0.0, min(1.0, float(score)))
            for name, score in payload.items()
        }
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}


def author_reputation(item, configured=None):
    """Score authors conservatively; fame or track record is never invented.

    Social authors receive a meaningful boost only when the operator supplies a
    reviewed score in MARKET_AUTHOR_REPUTATION_JSON (for example after checking a
    transparent historical scorecard).
    """
    explicit = item.get("author_reputation")
    try:
        if explicit is not None:
            return max(0.0, min(1.0, float(explicit)))
    except (TypeError, ValueError):
        pass
    configured = configured if configured is not None else _configured_author_scores()
    author = " ".join(str(item.get("author") or "").strip().lower().split())
    for key, score in configured.items():
        normalized_key = " ".join(str(key).strip().lower().split())
        if normalized_key and author and author.lstrip("@") == normalized_key.lstrip("@"):
            return score
    source = f"{item.get('source', '')} {item.get('url', '')}".lower()
    if any(marker in source for marker in ("reddit", "twitter", "x.com", "stocktwits")):
        return 0.25
    return 0.58 if author else 0.50


def _ticker_is_ambiguous(ticker):
    ticker = str(ticker or "").strip().upper()
    return len(ticker) <= 2 or ticker in {"AI", "IT", "ON", "ALL", "NOW", "SO", "A", "C", "F"}


def relevance_score(item, ticker, company_name, theme="GENERAL_AI"):
    title = str(item.get("title") or "")
    summary = str(item.get("summary") or "")
    text = f"{title} {summary}".lower()
    symbol = str(ticker or "").strip().upper()
    company = re.sub(
        r"\b(incorporated|corporation|corp\.?|inc\.?|limited|ltd\.?|plc|holdings?)\b",
        " ", str(company_name or ""), flags=re.I,
    )
    company = " ".join(company.lower().split())

    exact_ticker = bool(re.search(rf"(?<![A-Z0-9])\$?{re.escape(symbol)}(?![A-Z0-9])", f"{title} {summary}", re.I))
    qualified_ticker = bool(re.search(
        rf"(?:\${re.escape(symbol)}\b|(?:nasdaq|nyse|ticker)\s*[:\-]?\s*{re.escape(symbol)}\b)",
        f"{title} {summary}", re.I,
    ))
    if _ticker_is_ambiguous(symbol) and not qualified_ticker:
        exact_ticker = False

    company_match = bool(company and len(company) >= 4 and company in text)
    # A distinctive first two-word alias handles titles that omit "Holdings" etc.
    company_tokens = [token for token in company.split() if len(token) > 2]
    alias = " ".join(company_tokens[:2])
    alias_match = bool(alias and len(alias) >= 5 and alias in text)
    catalyst_count = sum(1 for term in FINANCE_CATALYST_TERMS if term in text)
    theme_terms = AI_THEME_KEYWORDS.get(theme, ())
    theme_count = sum(1 for term in theme_terms if term in text)

    score = 0.0
    if company_match:
        score += 0.58
    elif alias_match:
        score += 0.48
    if exact_ticker:
        score += 0.38
    score += min(0.20, catalyst_count * 0.05)
    score += min(0.12, theme_count * 0.04)
    return max(0.0, min(1.0, score))


def lexical_sentiment(item):
    text = f"{item.get('title', '')} {item.get('summary', '')}".lower()
    values = []
    for phrase, value in POSITIVE_PHRASES.items():
        if phrase in text:
            values.append(value)
    for phrase, value in NEGATIVE_PHRASES.items():
        if phrase in text:
            values.append(value)

    # Single-word fallbacks matter only when no more precise event phrase exists.
    if not values:
        positive = len(re.findall(r"\b(beat|beats|upgrade|upgraded|growth|surge|record|approval|win|bullish)\b", text))
        negative = len(re.findall(r"\b(miss|misses|downgrade|downgraded|decline|probe|delay|recall|bearish|lawsuit)\b", text))
        if positive or negative:
            values.append(max(-0.70, min(0.70, (positive - negative) / max(2.0, positive + negative))))
    if not values:
        return 0.0
    raw = sum(values) / math.sqrt(len(values))
    if any(term in text for term in ("rumor", "reportedly", "may", "could", "unconfirmed")):
        raw *= 0.75
    return max(-1.0, min(1.0, raw))


def noise_penalty(item):
    text = f"{item.get('title', '')} {item.get('summary', '')}".lower()
    penalty = sum(0.14 for phrase in NOISE_PHRASES if phrase in text)
    source = f"{item.get('source', '')} {item.get('url', '')}".lower()
    if any(marker in source for marker in ("reddit", "twitter", "x.com", "stocktwits")):
        penalty += 0.12
    if len(str(item.get("title") or "")) < 22:
        penalty += 0.10
    if not any(term in text for term in FINANCE_CATALYST_TERMS):
        penalty += 0.16
    title = str(item.get("title") or "")
    letters = [character for character in title if character.isalpha()]
    if letters and sum(character.isupper() for character in letters) / len(letters) > 0.70:
        penalty += 0.10
    return max(0.0, min(0.85, penalty))


def _title_tokens(value):
    stop = {"the", "a", "an", "and", "or", "to", "for", "of", "on", "in", "as", "at", "by", "with"}
    return {
        token for token in re.findall(r"[a-z0-9]+", str(value or "").lower())
        if len(token) > 2 and token not in stop
    }


def _similarity(left, right):
    left_tokens = _title_tokens(left)
    right_tokens = _title_tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def _canonical_item(raw, origin):
    if not isinstance(raw, dict):
        return None
    published = _coerce_datetime(raw.get("published_at") or raw.get("date") or raw.get("pubDate"))
    title = _plain_text(raw.get("title"))
    url = _safe_public_url(raw.get("url") or raw.get("link"))
    if not title or not url or published is None:
        return None
    return {
        "title": title,
        "summary": _plain_text(raw.get("summary") or raw.get("description")),
        "url": url,
        "source": _plain_text(raw.get("source") or raw.get("publisher") or urlparse(url).netloc),
        "author": _plain_text(raw.get("author")),
        "published_at": published,
        "origin": origin,
    }


def normalize_yahoo_news(items):
    normalized = []
    for outer in items or []:
        raw = outer.get("content", outer) if isinstance(outer, dict) else {}
        provider = raw.get("provider") or {}
        canonical = raw.get("canonicalUrl") or raw.get("clickThroughUrl") or {}
        item = _canonical_item({
            "title": raw.get("title"),
            "summary": raw.get("summary") or raw.get("description"),
            "url": canonical.get("url") if isinstance(canonical, dict) else canonical,
            "source": provider.get("displayName") if isinstance(provider, dict) else provider,
            "author": raw.get("byline"),
            "published_at": raw.get("pubDate") or raw.get("providerPublishTime") or raw.get("displayTime"),
        }, "Yahoo Finance public news API")
        if item:
            normalized.append(item)
    return normalized


def parse_public_feed(xml_text, origin):
    """Parse RSS or Atom headline metadata; article bodies are never fetched."""
    try:
        root = ET.fromstring(xml_text)
    except (ET.ParseError, TypeError):
        return []
    rows = []
    candidates = list(root.findall(".//item"))
    candidates.extend(root.findall(".//{http://www.w3.org/2005/Atom}entry"))
    for element in candidates:
        def find_text(*names):
            for name in names:
                child = element.find(name)
                if child is not None and child.text:
                    return child.text
            return ""

        link = find_text("link", "{http://www.w3.org/2005/Atom}link")
        if not link:
            link_node = element.find("{http://www.w3.org/2005/Atom}link")
            link = link_node.attrib.get("href", "") if link_node is not None else ""
        source_node = element.find("source")
        source = source_node.text if source_node is not None and source_node.text else ""
        author = find_text("author", "{http://www.w3.org/2005/Atom}author/{http://www.w3.org/2005/Atom}name")
        row = _canonical_item({
            "title": find_text("title", "{http://www.w3.org/2005/Atom}title"),
            "summary": find_text("description", "{http://www.w3.org/2005/Atom}summary", "{http://www.w3.org/2005/Atom}content"),
            "url": link,
            "source": source or ("Reddit" if "reddit" in origin.lower() else "Google News"),
            "author": author,
            "published_at": find_text("pubDate", "published", "updated", "{http://www.w3.org/2005/Atom}published", "{http://www.w3.org/2005/Atom}updated"),
        }, origin)
        if row:
            rows.append(row)
    return rows


def _get_feed(session, url, origin, timeout):
    try:
        response = session.get(
            url,
            timeout=timeout,
            headers={"User-Agent": "WhatsAppStockResearch/1.0 (public RSS reader)"},
        )
        if response.status_code != 200:
            return [], f"{origin}: HTTP {response.status_code}"
        return parse_public_feed(response.text, origin), ""
    except Exception as exc:  # Network failure must never block the valuation report.
        return [], f"{origin}: {type(exc).__name__}"


def _get_gdelt(session, ticker, company_name, timeout):
    """Read GDELT's public DOC 2.0 JSON metadata endpoint (no API key)."""
    base_query = f'"{company_name}" stock' if company_name else f'"{ticker}" stock'
    # The deterministic sentiment lexicon is English, so non-English GDELT
    # headlines are intentionally excluded instead of being scored as neutral.
    query = f"{base_query} sourcelang:english"
    url = (
        "https://api.gdeltproject.org/api/v2/doc/doc?query=" + quote_plus(query)
        + "&mode=ArtList&maxrecords=50&format=json&sort=datedesc"
    )
    try:
        response = session.get(
            url,
            timeout=timeout,
            headers={"User-Agent": "WhatsAppStockResearch/1.0 (public metadata research)"},
        )
        if response.status_code != 200:
            return [], f"GDELT DOC public API: HTTP {response.status_code}"
        payload = response.json()
        rows = []
        for article in payload.get("articles", []) if isinstance(payload, dict) else []:
            row = _canonical_item({
                "title": article.get("title"),
                "summary": "",
                "url": article.get("url"),
                "source": article.get("domain") or "GDELT indexed publisher",
                "author": "",
                "published_at": article.get("seendate"),
            }, "GDELT DOC 2.0 public API")
            if row:
                rows.append(row)
        return rows, ""
    except Exception as exc:
        return [], f"GDELT DOC public API: {type(exc).__name__}"


def _get_x_recent(session, ticker, company_name, bearer_token, timeout):
    """Use X's official recent-search API when the operator supplies a token."""
    company_clause = f'"{company_name}"' if company_name else f'"${ticker}"'
    query = (
        f'({company_clause} OR "${ticker}") '
        "(earnings OR guidance OR analyst OR contract OR demand OR price target) "
        "lang:en -is:retweet"
    )
    url = (
        "https://api.x.com/2/tweets/search/recent?query=" + quote_plus(query)
        + "&max_results=25&tweet.fields=created_at,author_id"
        + "&expansions=author_id&user.fields=name,username,verified"
    )
    try:
        response = session.get(
            url,
            timeout=timeout,
            allow_redirects=False,
            headers={
                "Authorization": f"Bearer {bearer_token}",
                "User-Agent": "WhatsAppStockResearch/1.0 (official X API client)",
            },
        )
        if response.status_code != 200:
            return [], f"X official recent-search API: HTTP {response.status_code}"
        payload = response.json()
        users = {
            str(user.get("id")): user
            for user in (payload.get("includes", {}).get("users", []) if isinstance(payload, dict) else [])
            if isinstance(user, dict)
        }
        rows = []
        for post in payload.get("data", []) if isinstance(payload, dict) else []:
            if not isinstance(post, dict):
                continue
            user = users.get(str(post.get("author_id")), {})
            username = str(user.get("username") or "").strip()
            post_id = str(post.get("id") or "").strip()
            if not username or not post_id:
                continue
            row = _canonical_item({
                "title": post.get("text"),
                "summary": "",
                "url": f"https://x.com/{username}/status/{post_id}",
                "source": "X/Twitter official API",
                "author": f"@{username}",
                "published_at": post.get("created_at"),
            }, "X API v2 recent search")
            if row:
                rows.append(row)
        return rows, ""
    except Exception as exc:
        return [], f"X official recent-search API: {type(exc).__name__}"


def collect_public_items(ticker, company_name, *, yahoo_items=None, session=None, timeout=10):
    """Collect public metadata from Yahoo, Google, GDELT, Reddit, and optional X API."""
    session = session or requests.Session()
    rows = normalize_yahoo_news(yahoo_items or [])
    diagnostics = []
    year = _utc_now().year
    quoted_company = f'"{company_name}"' if company_name else ticker
    queries = [
        f'{quoted_company} {ticker} stock (earnings OR guidance OR contract OR data center OR AI)',
        f'{quoted_company} {ticker} ("price target" OR upgrade OR downgrade) after:{year}-01-01',
    ]
    for number, query in enumerate(queries, start=1):
        url = (
            "https://news.google.com/rss/search?q=" + quote_plus(query)
            + "&hl=en-US&gl=US&ceid=US:en"
        )
        feed_rows, note = _get_feed(session, url, f"Google News public RSS query {number}", timeout)
        rows.extend(feed_rows)
        if note:
            diagnostics.append(note)

    if os.environ.get("MARKET_GDELT_ENABLED", "true").strip().lower() not in {"0", "false", "no"}:
        gdelt_rows, note = _get_gdelt(session, ticker, company_name, timeout)
        rows.extend(gdelt_rows)
        if note:
            diagnostics.append(note)

    # Social posts are consumed only through X's official API. There is no page
    # scraping fallback. Author reputation remains neutral unless an exact handle
    # has an operator-reviewed score in MARKET_AUTHOR_REPUTATION_JSON.
    x_token = os.environ.get("MARKET_X_BEARER_TOKEN", "").strip()
    if x_token:
        x_rows, note = _get_x_recent(session, ticker, company_name, x_token, timeout)
        rows.extend(x_rows)
        if note:
            diagnostics.append(note)

    # Reddit's public RSS feed is best effort. No login, private data, or access
    # control is bypassed. Operators can disable it with MARKET_REDDIT_ENABLED=false.
    if os.environ.get("MARKET_REDDIT_ENABLED", "true").strip().lower() not in {"0", "false", "no"}:
        reddit_query = quote_plus(f'({ticker} OR "{company_name}") (stock OR earnings OR guidance)')
        reddit_url = f"https://www.reddit.com/search.rss?q={reddit_query}&sort=new&t=month"
        feed_rows, note = _get_feed(session, reddit_url, "Reddit public RSS", timeout)
        rows.extend(feed_rows)
        if note:
            diagnostics.append(note)
    return rows, diagnostics


def score_market_items(items, ticker, company_name, theme, *, as_of=None, lookback_days=DEFAULT_LOOKBACK_DAYS):
    now = _coerce_datetime(as_of) or _utc_now()
    configured_authors = _configured_author_scores()
    candidates = []
    seen_urls = set()
    for raw in items or []:
        item = raw if isinstance(raw, dict) and isinstance(raw.get("published_at"), datetime) else _canonical_item(raw, "fixture")
        if not item or item["url"] in seen_urls:
            continue
        seen_urls.add(item["url"])
        age_days = max(0.0, (now - item["published_at"]).total_seconds() / 86400.0)
        if item["published_at"] > now or age_days > lookback_days:
            continue
        relevance = relevance_score(item, ticker, company_name, theme)
        if relevance < 0.42:
            continue
        item = dict(item)
        item["age_days"] = age_days
        item["source_quality"] = source_reputation(item.get("source"), item.get("url"))
        item["author_quality"] = author_reputation(item, configured_authors)
        item["relevance"] = relevance
        item["freshness"] = math.exp(-math.log(2) * age_days / 30.0)
        item["noise_penalty"] = noise_penalty(item)
        item["sentiment"] = lexical_sentiment(item)
        candidates.append(item)

    # Corroboration requires similar reporting from distinct publishers.  A dozen
    # copies from one domain never count as independent confirmation.
    for item in candidates:
        corroborating_sources = {
            other.get("source") or urlparse(other.get("url", "")).netloc
            for other in candidates
            if other is not item and _similarity(item.get("title"), other.get("title")) >= 0.38
        }
        item["corroboration_count"] = len(corroborating_sources)
        item["corroboration"] = min(1.0, 0.45 + 0.18 * len(corroborating_sources))
        base_weight = (
            0.30 * item["source_quality"]
            + 0.10 * item["author_quality"]
            + 0.25 * item["relevance"]
            + 0.15 * item["freshness"]
            + 0.20 * item["corroboration"]
        )
        item["weight"] = max(0.0, min(1.0, base_weight * (1.0 - item["noise_penalty"])))

    # Near-duplicate syndicated headlines add corroboration but only the highest
    # quality representative contributes to the aggregate, preventing vote stuffing.
    ordered = sorted(candidates, key=lambda row: (row["weight"], -row["age_days"]), reverse=True)
    deduped = []
    for item in ordered:
        if any(_similarity(item.get("title"), existing.get("title")) >= 0.82 for existing in deduped):
            continue
        if item["weight"] >= 0.24:
            deduped.append(item)
    return sorted(deduped, key=lambda row: row["published_at"], reverse=True)[:MAX_EVIDENCE_ITEMS]


def technical_signal_score(*, current_price, sma_50, sma_200, rsi_14, momentum_3m=None, momentum_6m=None, momentum_12m=None):
    """Return a bounded technical overlay and its data coverage."""
    components = []
    try:
        price = float(current_price)
        ma50 = float(sma_50)
        ma200 = float(sma_200)
        if all(math.isfinite(value) and value > 0 for value in (price, ma50, ma200)):
            components.extend([
                (0.22, max(-1.0, min(1.0, (price / ma50 - 1.0) / 0.10))),
                (0.22, max(-1.0, min(1.0, (ma50 / ma200 - 1.0) / 0.12))),
            ])
    except (TypeError, ValueError, ZeroDivisionError):
        pass
    for weight, value, scale in (
        (0.20, momentum_3m, 0.20), (0.16, momentum_6m, 0.35), (0.10, momentum_12m, 0.55)
    ):
        try:
            number = float(value)
            if math.isfinite(number):
                components.append((weight, max(-1.0, min(1.0, number / scale))))
        except (TypeError, ValueError):
            pass
    try:
        rsi = float(rsi_14)
        if math.isfinite(rsi):
            # A modest mean-reversion overlay; trend/momentum remain dominant.
            rsi_component = (50.0 - rsi) / 30.0
            components.append((0.10, max(-1.0, min(1.0, rsi_component))))
    except (TypeError, ValueError):
        pass
    available = sum(weight for weight, _ in components)
    score = sum(weight * value for weight, value in components) / available if available else 0.0
    return {"score": max(-1.0, min(1.0, score)), "coverage": min(1.0, available)}


def signal_label(score):
    score = float(score)
    if score >= 0.52:
        return "STRONG BUY"
    if score >= 0.18:
        return "BUY"
    if score > -0.18:
        return "HOLD"
    if score > -0.52:
        return "SELL"
    return "STRONG SELL"


def aggregate_market_signal(scored_items, technical):
    denominator = sum(item.get("weight", 0.0) for item in scored_items)
    news_score = (
        sum(item.get("sentiment", 0.0) * item.get("weight", 0.0) for item in scored_items) / denominator
        if denominator else 0.0
    )
    source_count = len({str(item.get("source") or "").lower() for item in scored_items})
    evidence_count = len(scored_items)
    mean_quality = (
        sum(item.get("source_quality", 0.0) for item in scored_items) / evidence_count
        if evidence_count else 0.0
    )
    coverage = min(1.0, math.log1p(evidence_count) / math.log(13)) if evidence_count else 0.0
    coverage *= min(1.0, 0.45 + 0.18 * source_count) if source_count else 0.0
    if evidence_count:
        signs = [1 if item.get("sentiment", 0) > 0.08 else -1 if item.get("sentiment", 0) < -0.08 else 0 for item in scored_items]
        dominant = Counter(signs).most_common(1)[0][1] / len(signs)
    else:
        dominant = 0.0

    technical_score = float((technical or {}).get("score", 0.0))
    technical_coverage = float((technical or {}).get("coverage", 0.0))
    if evidence_count >= 3 and coverage >= 0.30:
        news_weight = 0.68
    elif evidence_count:
        news_weight = 0.50
    else:
        news_weight = 0.0
    technical_weight = 1.0 - news_weight
    combined = news_weight * news_score + technical_weight * technical_score
    confidence = 100.0 * (
        0.48 * coverage + 0.18 * mean_quality + 0.14 * dominant
        + 0.20 * technical_coverage
    )
    if not evidence_count:
        confidence = min(confidence, 42.0)
    return {
        "news_score": max(-1.0, min(1.0, news_score)),
        "technical_score": max(-1.0, min(1.0, technical_score)),
        "combined_score": max(-1.0, min(1.0, combined)),
        "label": signal_label(combined),
        "confidence": int(round(max(0.0, min(100.0, confidence)))),
        "coverage": int(round(coverage * 100)),
        "evidence_count": evidence_count,
        "source_count": source_count,
        "mode": "news + technicals" if evidence_count else "technical-only fallback",
    }


_TARGET_PATTERNS = (
    re.compile(
        r"price\s+target\s+(?:is\s+)?(?:raised|lifted|increased|boosted|cut|lowered|reduced)?\s*"
        r"(?:from\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s+)?(?:to|at|of)\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)",
        re.I,
    ),
    re.compile(r"\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s+price\s+target", re.I),
)


def _organization_key(value):
    value = re.sub(r"[^a-z0-9 ]+", " ", str(value or "").lower())
    value = re.sub(
        r"\b(incorporated|corporation|corp|inc|limited|ltd|plc|holdings?|company|co)\b",
        " ", value,
    )
    return " ".join(value.split())


def _extract_firm(text, company_name="", ticker=""):
    # Keep the action alternatives inside one non-capturing group. Without the
    # group, regex alternation can match a bare verb elsewhere in the headline,
    # leaving the required firm capture as None (a common public-feed shape).
    action = r"(?:raises?|cuts?|lowers?|boosts?|lifts?|initiates?|upgrades?|downgrades?|maintains?|reiterates?)"
    patterns = (
        re.compile(rf"^([A-Z][A-Za-z0-9&.' -]{{2,45}}?)\s+{action}\b"),
        re.compile(r"\b(?:at|by)\s+([A-Z][A-Za-z0-9&.' -]{2,45}?)(?:\s*[-:;,]|$)"),
    )
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            candidate = " ".join(match.group(1).split()).strip(" -:,.;")
            candidate_lower = candidate.lower()
            candidate_key = _organization_key(candidate)
            company_key = _organization_key(company_name)
            rejected_keys = {
                company_key,
                _organization_key(ticker),
                "reuters", "bloomberg", "yahoo finance", "investing com",
                "wall street", "analyst", "research report", "market report",
            }
            if (
                candidate_lower not in {"analyst", "wall street", "price target"}
                and "price target" not in candidate_lower
                and not candidate_lower.endswith(" stock")
                and candidate_key
                and candidate_key not in rejected_keys
            ):
                return candidate
    return ""


def extract_current_year_analyst_targets(items, ticker, company_name, current_price, *, as_of=None):
    """Extract only explicit, attributable current-year targets from feed metadata.

    This conservative fallback never guesses a target or analyst firm.  If a public
    headline does not contain both an exact numeric target and an attributable firm,
    it is omitted and the report leaves the field unavailable.
    """
    now = _coerce_datetime(as_of) or _utc_now()
    rows = []
    for item in items or []:
        published = _coerce_datetime(item.get("published_at") or item.get("date"))
        url = _safe_public_url(item.get("url"))
        if not published or published.year != now.year or published > now or not url:
            continue
        relevance = relevance_score(item, ticker, company_name, infer_ai_theme(ticker, company_name))
        if relevance < 0.50:
            continue
        text = f"{item.get('title', '')} {item.get('summary', '')}".strip()
        lower = text.lower()
        if "price target" not in lower or not any(term in lower for term in (
            "analyst", "raises", "raised", "cuts", "cut", "lowers", "boosts",
            "initiates", "upgrades", "downgrades", "maintains", "reiterates", " at ", " by ",
        )):
            continue
        previous = None
        target = None
        for pattern in _TARGET_PATTERNS:
            match = pattern.search(text)
            if not match:
                continue
            if len(match.groups()) == 2:
                previous = float(match.group(1).replace(",", "")) if match.group(1) else None
                target = float(match.group(2).replace(",", ""))
            else:
                target = float(match.group(1).replace(",", ""))
            break
        firm = (
            _extract_firm(str(item.get("title") or ""), company_name, ticker)
            or _extract_firm(text, company_name, ticker)
        )
        if target is None or not firm:
            continue
        try:
            price = float(current_price)
            if price > 0 and not (price * 0.20 <= target <= price * 5.0):
                continue
        except (TypeError, ValueError):
            pass
        rating = "N/A"
        rating_match = re.search(r"\b(strong buy|buy|outperform|overweight|hold|neutral|sell|underperform|underweight)\b", lower)
        if rating_match:
            rating = rating_match.group(1).title()
        rows.append({
            "date": published.strftime("%Y-%m-%d"),
            "analyst": "Not disclosed",
            "firm": firm,
            "previous_rating": "N/A",
            "new_rating": rating,
            "price_target": target,
            "previous_price_target": previous,
            "source_url": url,
            "source_title": str(item.get("title") or item.get("source") or "Public feed headline"),
            "record_origin": "Public feed; target and firm stated in headline metadata",
        })
    unique = {}
    for row in rows:
        key = (row["date"], row["firm"].lower(), row["price_target"])
        unique[key] = row
    return sorted(unique.values(), key=lambda row: row["date"], reverse=True)


def build_market_intelligence(
    ticker,
    company_name,
    company_text,
    technical_inputs,
    *,
    yahoo_items=None,
    session=None,
    as_of=None,
    lookback_days=None,
):
    """End-to-end public-evidence collection with deterministic graceful fallback."""
    theme = infer_ai_theme(ticker, company_text)
    raw_items, diagnostics = collect_public_items(
        ticker, company_name, yahoo_items=yahoo_items, session=session,
    )
    try:
        lookback_days = int(lookback_days or os.environ.get("MARKET_SENTIMENT_LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS))
    except (TypeError, ValueError):
        lookback_days = DEFAULT_LOOKBACK_DAYS
    scored = score_market_items(
        raw_items, ticker, company_name, theme,
        as_of=as_of, lookback_days=max(14, min(365, lookback_days)),
    )
    technical = technical_signal_score(**technical_inputs)
    aggregate = aggregate_market_signal(scored, technical)
    return {
        "theme": theme,
        "items": scored,
        "all_public_items": raw_items,
        "diagnostics": diagnostics,
        "technical": technical,
        "signal": aggregate,
    }
