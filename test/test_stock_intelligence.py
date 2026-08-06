import json
import os
import unittest
from datetime import datetime, timedelta, timezone

from stock_intelligence import (
    aggregate_market_signal,
    author_reputation,
    build_market_intelligence,
    collect_public_items,
    current_calendar_year,
    extract_current_year_analyst_targets,
    infer_ai_theme,
    lexical_sentiment,
    noise_penalty,
    parse_public_feed,
    relevance_score,
    score_market_items,
    signal_label,
    source_reputation,
    technical_signal_score,
    validate_current_year_analyst_record,
)


NOW = datetime(2026, 8, 6, 12, 0, tzinfo=timezone.utc)


def item(title, *, source="Reuters", days=1, url="https://example.com/story", summary=""):
    return {
        "title": title,
        "summary": summary,
        "source": source,
        "url": url,
        "author": "",
        "published_at": NOW - timedelta(days=days),
        "origin": "fixture",
    }


class FakeResponse:
    def __init__(self, *, text="", payload=None, status_code=200):
        self.text = text
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, rss, gdelt, x_payload=None):
        self.rss = rss
        self.gdelt = gdelt
        self.x_payload = x_payload
        self.urls = []
        self.calls = []

    def get(self, url, **kwargs):
        self.urls.append(url)
        self.calls.append((url, kwargs))
        if "api.gdeltproject.org" in url:
            return FakeResponse(payload=self.gdelt)
        if "api.x.com" in url:
            return FakeResponse(payload=self.x_payload or {})
        return FakeResponse(text=self.rss)


class StockIntelligenceTests(unittest.TestCase):
    def setUp(self):
        self.old_author_json = os.environ.get("MARKET_AUTHOR_REPUTATION_JSON")
        self.old_reddit = os.environ.get("MARKET_REDDIT_ENABLED")
        self.old_gdelt = os.environ.get("MARKET_GDELT_ENABLED")
        self.old_x_token = os.environ.get("MARKET_X_BEARER_TOKEN")
        os.environ.pop("MARKET_X_BEARER_TOKEN", None)

    def tearDown(self):
        for name, value in (
            ("MARKET_AUTHOR_REPUTATION_JSON", self.old_author_json),
            ("MARKET_REDDIT_ENABLED", self.old_reddit),
            ("MARKET_GDELT_ENABLED", self.old_gdelt),
            ("MARKET_X_BEARER_TOKEN", self.old_x_token),
        ):
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def test_ai_value_chain_has_focused_infrastructure_categories(self):
        self.assertEqual(infer_ai_theme("MSFT"), "HYPERSCALER")
        self.assertEqual(infer_ai_theme("TSM"), "WAFER_FOUNDRY")
        self.assertEqual(infer_ai_theme("COHR"), "PHOTONICS_OPTICS")
        self.assertEqual(infer_ai_theme("BE"), "DATA_CENTER_POWER")
        self.assertEqual(infer_ai_theme("XYZ", "silicon photonics transceivers"), "PHOTONICS_OPTICS")

    def test_current_calendar_year_rejects_old_future_and_missing_dates(self):
        self.assertTrue(current_calendar_year("2026-01-02", as_of=NOW))
        self.assertFalse(current_calendar_year("2025-12-31", as_of=NOW))
        self.assertFalse(current_calendar_year("2026-12-31", as_of=NOW))
        self.assertFalse(current_calendar_year("N/A", as_of=NOW))

    def test_publisher_quality_ranks_primary_and_major_sources_above_social(self):
        self.assertGreater(source_reputation("SEC", "https://sec.gov/filing"), source_reputation("Bloomberg"))
        self.assertGreater(source_reputation("Bloomberg"), source_reputation("Yahoo Finance"))
        self.assertGreater(source_reputation("Yahoo Finance"), source_reputation("Reddit"))
        self.assertEqual(source_reputation("Not Bloomberg", "https://notbloomberg.example/story"), 0.46)

    def test_configured_author_boost_only_applies_to_matching_author(self):
        os.environ["MARKET_AUTHOR_REPUTATION_JSON"] = json.dumps({"Serenity Semiconductor Research": 0.91})
        matched = {"author": "Serenity Semiconductor Research", "source": "Reddit"}
        unmatched = {"author": "Someone Else", "source": "Reddit"}
        missing = {"author": "", "source": "Reddit"}
        self.assertAlmostEqual(author_reputation(matched), 0.91)
        self.assertEqual(author_reputation(unmatched), 0.25)
        self.assertEqual(author_reputation(missing), 0.25)

    def test_short_ambiguous_ticker_requires_company_or_qualified_symbol(self):
        irrelevant = item("Be ready for better weather and power savings", source="Unknown")
        relevant = item("Bloom Energy ($BE) wins data center power contract")
        self.assertLess(relevance_score(irrelevant, "BE", "Bloom Energy", "DATA_CENTER_POWER"), 0.42)
        self.assertGreater(relevance_score(relevant, "BE", "Bloom Energy", "DATA_CENTER_POWER"), 0.70)

    def test_lexical_sentiment_uses_event_phrases(self):
        positive = item("Nvidia raises guidance after revenue beat on AI demand")
        negative = item("Nvidia cuts guidance after revenue miss and weak demand")
        self.assertGreater(lexical_sentiment(positive), 0.5)
        self.assertLess(lexical_sentiment(negative), -0.5)

    def test_clickbait_and_social_content_receive_noise_penalties(self):
        clean = item("Bloom Energy reports quarterly revenue and updated guidance")
        spam = item("MUST BUY NOW!!! This secret BE stock could make you rich", source="Reddit")
        self.assertGreater(noise_penalty(spam), noise_penalty(clean) + 0.3)

    def test_scoring_filters_stale_off_topic_and_syndicated_duplicates(self):
        rows = [
            item("Bloom Energy raises guidance on data center demand", source="Reuters", url="https://reuters.com/a"),
            item("Bloom Energy raises guidance on strong data-center demand", source="Bloomberg", url="https://bloomberg.com/b"),
            item("Bloom Energy raises guidance last year", source="Reuters", days=200, url="https://reuters.com/old"),
            item("Local sports team wins final", source="Reuters", url="https://reuters.com/sport"),
        ]
        scored = score_market_items(rows, "BE", "Bloom Energy", "DATA_CENTER_POWER", as_of=NOW, lookback_days=120)
        self.assertEqual(len(scored), 1)
        self.assertGreaterEqual(scored[0]["corroboration_count"], 1)
        self.assertGreater(scored[0]["weight"], 0.5)

    def test_final_weight_enforces_source_rank_and_spam_penalty(self):
        rows = [
            item(
                "Bloom Energy raises guidance on data center demand",
                source="Bloomberg", url="https://bloomberg.com/clean",
            ),
            item(
                "Bloom Energy MUST BUY NOW!!! secret stock could make you rich",
                source="Reddit", url="https://reddit.com/spam",
            ),
        ]
        scored = score_market_items(rows, "BE", "Bloom Energy", "DATA_CENTER_POWER", as_of=NOW)
        by_url = {row["url"]: row for row in scored}
        self.assertIn("https://bloomberg.com/clean", by_url)
        if "https://reddit.com/spam" in by_url:
            self.assertGreater(
                by_url["https://bloomberg.com/clean"]["weight"],
                by_url["https://reddit.com/spam"]["weight"],
            )

    def test_technical_overlay_accepts_decimal_returns(self):
        result = technical_signal_score(
            current_price=120, sma_50=110, sma_200=100, rsi_14=58,
            momentum_3m=0.12, momentum_6m=0.22, momentum_12m=0.35,
        )
        self.assertGreater(result["score"], 0.3)
        self.assertEqual(result["coverage"], 1.0)

    def test_five_level_signal_boundaries(self):
        self.assertEqual(signal_label(0.70), "STRONG BUY")
        self.assertEqual(signal_label(0.30), "BUY")
        self.assertEqual(signal_label(0.00), "HOLD")
        self.assertEqual(signal_label(-0.30), "SELL")
        self.assertEqual(signal_label(-0.70), "STRONG SELL")

    def test_aggregate_combines_weighted_evidence_and_technicals(self):
        rows = [
            {"source": "Reuters", "source_quality": 0.97, "sentiment": 0.9, "weight": 0.8},
            {"source": "Bloomberg", "source_quality": 0.96, "sentiment": 0.8, "weight": 0.75},
            {"source": "Yahoo Finance", "source_quality": 0.82, "sentiment": 0.7, "weight": 0.65},
        ]
        result = aggregate_market_signal(rows, {"score": 0.6, "coverage": 1.0})
        self.assertIn(result["label"], {"BUY", "STRONG BUY"})
        self.assertGreater(result["confidence"], 50)
        self.assertEqual(result["mode"], "news + technicals")

    def test_no_evidence_is_explicit_low_confidence_technical_fallback(self):
        result = aggregate_market_signal([], {"score": 0.7, "coverage": 1.0})
        self.assertEqual(result["mode"], "technical-only fallback")
        self.assertLessEqual(result["confidence"], 42)

    def test_target_extraction_is_exact_attributable_and_current_year_only(self):
        valid = item(
            "Mizuho Raises Bloom Energy Price Target From $50 to $80 at Mizuho",
            source="Yahoo Finance", url="https://finance.yahoo.com/valid",
        )
        old = dict(valid, published_at=datetime(2025, 12, 1, tzinfo=timezone.utc), url="https://finance.yahoo.com/old")
        no_firm = item(
            "Bloom Energy price target raised from $50 to $80",
            source="Yahoo Finance", url="https://finance.yahoo.com/no-firm",
        )
        issuer_as_firm = item(
            "Bloom Energy Raises Price Target to $80 Following Strong Demand",
            source="Yahoo Finance", url="https://finance.yahoo.com/issuer-is-not-analyst",
        )
        implausible = item(
            "Mizuho Raises Bloom Energy Price Target to $9000",
            source="Yahoo Finance", url="https://finance.yahoo.com/bad",
        )
        rows = extract_current_year_analyst_targets(
            [valid, old, no_firm, issuer_as_firm, implausible], "BE", "Bloom Energy", 70, as_of=NOW,
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["firm"], "Mizuho")
        self.assertEqual(rows[0]["price_target"], 80.0)
        self.assertEqual(rows[0]["previous_price_target"], 50.0)
        self.assertEqual(rows[0]["date"], "2026-08-05")
        self.assertTrue(rows[0]["source_url"].startswith("https://"))

    def test_target_extraction_ignores_bare_action_verbs_without_a_firm(self):
        rows = extract_current_year_analyst_targets([item(
            "Bloom Energy price target cut to $65 after earnings",
            source="Example", url="https://example.com/bloom-target",
        )], "BE", "Bloom Energy", 70, as_of=NOW)
        self.assertEqual(rows, [])

    def test_all_analyst_providers_share_ytd_source_firm_and_plausibility_boundary(self):
        base = {
            "date": "2026-08-05", "analyst": "Analyst A", "firm": "Mizuho",
            "new_rating": "Buy", "price_target": 80,
            "source_url": "https://example.com/action", "source_title": "Action",
        }
        valid = validate_current_year_analyst_record(base, "BE", "Bloom Energy", 70, as_of=NOW)
        self.assertEqual(valid["price_target"], 80.0)
        self.assertIsNone(validate_current_year_analyst_record(dict(base, date="2025-08-05"), "BE", "Bloom Energy", 70, as_of=NOW))
        self.assertIsNone(validate_current_year_analyst_record(dict(base, source_url=""), "BE", "Bloom Energy", 70, as_of=NOW))
        self.assertIsNone(validate_current_year_analyst_record(dict(base, firm="Bloom Energy"), "BE", "Bloom Energy", 70, as_of=NOW))
        rating_only = validate_current_year_analyst_record(dict(base, price_target=9000), "BE", "Bloom Energy", 70, as_of=NOW)
        self.assertIsNone(rating_only["price_target"])
        self.assertIsNone(validate_current_year_analyst_record(
            dict(base, price_target=9000, new_rating="N/A"), "BE", "Bloom Energy", 70, as_of=NOW,
        ))

    def test_rss_and_gdelt_collectors_use_injected_session_without_live_web(self):
        rss = """<?xml version="1.0"?><rss><channel><item>
          <title>Bloom Energy raises guidance on data center demand</title>
          <link>https://reuters.com/feed-story</link><source>Reuters</source>
          <pubDate>Wed, 05 Aug 2026 10:00:00 GMT</pubDate>
          <description>Revenue guidance increased.</description>
        </item></channel></rss>"""
        gdelt = {"articles": [{
            "title": "Bloom Energy wins AI data center power agreement",
            "url": "https://bloomberg.com/gdelt-story", "domain": "bloomberg.com",
            "seendate": "20260805T120000Z",
        }]}
        parsed = parse_public_feed(rss, "fixture RSS")
        self.assertEqual(len(parsed), 1)
        fake = FakeSession(rss, gdelt)
        os.environ["MARKET_REDDIT_ENABLED"] = "false"
        os.environ["MARKET_GDELT_ENABLED"] = "true"
        rows, diagnostics = collect_public_items("BE", "Bloom Energy", session=fake)
        self.assertEqual(diagnostics, [])
        self.assertEqual(len(fake.urls), 3)  # two Google News queries + one GDELT request
        self.assertTrue(any(row["origin"].startswith("GDELT") for row in rows))

    def test_x_posts_are_read_only_through_official_api_when_token_is_supplied(self):
        rss = """<rss><channel></channel></rss>"""
        x_payload = {
            "data": [{
                "id": "123", "author_id": "7", "created_at": "2026-08-06T10:00:00Z",
                "text": "Bloom Energy guidance rises with data center demand",
            }],
            "includes": {"users": [{"id": "7", "username": "serenity", "name": "Serenity"}]},
        }
        fake = FakeSession(rss, {"articles": []}, x_payload=x_payload)
        os.environ["MARKET_REDDIT_ENABLED"] = "false"
        os.environ["MARKET_GDELT_ENABLED"] = "false"
        os.environ["MARKET_X_BEARER_TOKEN"] = "fixture-token"
        rows, diagnostics = collect_public_items("BE", "Bloom Energy", session=fake)
        self.assertEqual(diagnostics, [])
        self.assertTrue(any(row["origin"] == "X API v2 recent search" for row in rows))
        x_row = next(row for row in rows if row["origin"] == "X API v2 recent search")
        self.assertEqual(x_row["author"], "@serenity")
        self.assertEqual(x_row["url"], "https://x.com/serenity/status/123")
        x_call = next(call for call in fake.calls if "api.x.com" in call[0])
        self.assertNotIn("fixture-token", x_call[0])
        self.assertEqual(x_call[1]["headers"]["Authorization"], "Bearer fixture-token")
        self.assertIs(x_call[1]["allow_redirects"], False)
        self.assertNotIn("fixture-token", " ".join(diagnostics))

    def test_representative_end_to_end_intelligence_run_is_fully_offline(self):
        os.environ["MARKET_REDDIT_ENABLED"] = "false"
        os.environ["MARKET_GDELT_ENABLED"] = "false"
        fake = FakeSession("<rss><channel></channel></rss>", {"articles": []})
        yahoo_items = [{"content": {
            "title": "Bloom Energy raises guidance after data center contract win",
            "summary": "Revenue guidance raised on strong demand.",
            "canonicalUrl": {"url": "https://reuters.com/offline-fixture"},
            "provider": {"displayName": "Reuters"},
            "pubDate": "2026-08-05T10:00:00Z",
        }}]
        result = build_market_intelligence(
            "BE", "Bloom Energy", "fuel cells and data center power",
            {
                "current_price": 80, "sma_50": 72, "sma_200": 65, "rsi_14": 58,
                "momentum_3m": 0.15, "momentum_6m": 0.28, "momentum_12m": 0.40,
            },
            yahoo_items=yahoo_items, session=fake, as_of=NOW,
        )
        self.assertEqual(result["theme"], "DATA_CENTER_POWER")
        self.assertEqual(result["signal"]["evidence_count"], 1)
        self.assertIn(result["signal"]["label"], {"BUY", "STRONG BUY"})
        self.assertEqual(len(fake.urls), 2)  # Google RSS fixtures; no live sockets.


if __name__ == "__main__":
    unittest.main()
