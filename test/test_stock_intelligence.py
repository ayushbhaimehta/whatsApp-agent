import json
import os
import unittest
from datetime import datetime, timedelta, timezone

import pandas as pd

from stock_intelligence import (
    aggregate_market_signal,
    apply_directional_scenario_shift,
    author_reputation,
    build_market_intelligence,
    calendarize_fiscal_estimate,
    complete_forward_revenue_path,
    collect_public_items,
    convert_currency_amount,
    currency_pair_candidates,
    current_calendar_year,
    data_center_power_valuation_policy,
    dedupe_peer_symbols,
    extract_current_year_analyst_targets,
    filter_non_monotonic_scenario_methods,
    infer_ai_theme,
    infer_secondary_ai_exposures,
    infer_valuation_archetype,
    lexical_sentiment,
    memory_storage_valuation_policy,
    noise_penalty,
    normalize_scenario_estimates,
    normalize_yahoo_analyst_history,
    parse_public_feed,
    quote_equivalent_share_count,
    reconcile_forward_eps_estimate,
    relevance_score,
    robust_analyst_target_policy,
    robust_method_composite,
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

    def test_target_extraction_accepts_pt_and_target_price_but_rejects_local_currency(self):
        rows = extract_current_year_analyst_targets([
            item(
                "Mizuho Raises Micron (NASDAQ: MU) PT to $1,750 and Maintains Outperform",
                source="Yahoo Finance", url="https://finance.yahoo.com/mu-mizuho",
            ),
            item(
                "Needham Raises Taiwan Semiconductor (TSM) Target Price to $530 From $480",
                source="Yahoo Finance", url="https://finance.yahoo.com/tsm-needham",
            ),
            item(
                "Local Broker Raises TSM Target Price to NT$1,800",
                source="Example", url="https://example.com/tsm-local",
            ),
        ], "TSM", "Taiwan Semiconductor Manufacturing", 419, as_of=NOW)
        # The MU headline is irrelevant to TSM; the explicit NT$ local-share target
        # is rejected rather than being mislabeled as a USD ADR target.
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["firm"], "Needham")
        self.assertEqual(rows[0]["price_target"], 530.0)
        self.assertEqual(rows[0]["previous_price_target"], 480.0)

        mu_rows = extract_current_year_analyst_targets([
            item(
                "Mizuho Raises Micron (NASDAQ: MU) PT to $1,750 and Maintains Outperform",
                source="Yahoo Finance", url="https://finance.yahoo.com/mu-mizuho",
            ),
            item(
                "BofA Maintains Buy and $1,500 Target on Micron Technology",
                source="Yahoo Finance", url="https://finance.yahoo.com/mu-bofa",
            ),
        ], "MU", "Micron Technology", 875, as_of=NOW)
        self.assertEqual({row["price_target"] for row in mu_rows}, {1500.0, 1750.0})

    def test_sandisk_target_headline_variants_are_extracted_without_gemini(self):
        rows = extract_current_year_analyst_targets([
            item(
                "BofA Raises SanDisk (SNDK) Price Target to $2,100, Keeps Buy Rating",
                source="Yahoo Finance", url="https://finance.yahoo.com/sndk-bofa",
            ),
            item(
                "Evercore ISI Adjusts Price Target on Sandisk Corporation to $3,100 From $1,400, Maintains Outperform Rating",
                source="Moomoo", url="https://www.moomoo.com/sndk-evercore", days=2,
            ),
        ], "SNDK", "Sandisk Corporation", 1280, as_of=NOW)
        self.assertEqual(len(rows), 2)
        by_firm = {row["firm"]: row for row in rows}
        self.assertEqual(by_firm["BofA"]["price_target"], 2100.0)
        self.assertEqual(by_firm["Evercore ISI"]["price_target"], 3100.0)
        self.assertEqual(by_firm["Evercore ISI"]["previous_price_target"], 1400.0)

    def test_yahoo_dated_analyst_history_retains_targets_without_gemini(self):
        frame = pd.DataFrame([
            {
                "GradeDate": "2026-08-05T17:24:02Z", "Firm": "Wells Fargo",
                "ToGrade": "Equal-Weight", "FromGrade": "Equal-Weight",
                "currentPriceTarget": 1400.0, "priorPriceTarget": 1620.0,
            },
            {
                "GradeDate": "2026-08-05T15:47:36Z", "Firm": "Citigroup",
                "ToGrade": "Buy", "FromGrade": "Buy",
                "currentPriceTarget": 2100.0, "priorPriceTarget": 2500.0,
            },
            {
                "GradeDate": "2025-12-01T12:00:00Z", "Firm": "Old Firm",
                "ToGrade": "Buy", "currentPriceTarget": 900.0,
            },
        ]).set_index("GradeDate")
        rows = normalize_yahoo_analyst_history(frame, "SNDK", as_of=NOW)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["price_target"], 1400.0)
        self.assertEqual(rows[0]["previous_price_target"], 1620.0)
        self.assertEqual(rows[1]["firm"], "Citigroup")
        self.assertNotIn("token", rows[0]["source_url"].lower())
        self.assertEqual(rows[0]["record_origin"], "Yahoo Finance provider feed")

    def test_sandisk_uses_nand_peers_and_structural_forward_policy(self):
        policy = memory_storage_valuation_policy(
            "SNDK",
            "Sandisk manufactures NAND flash and enterprise solid-state drives",
        )
        self.assertEqual(policy["subtype"], "NAND_FLASH")
        self.assertEqual(policy["label"], "NAND Flash & Enterprise SSD")
        self.assertNotIn("WDC", policy["peer_symbols"])
        self.assertNotIn("STX", policy["peer_symbols"])
        self.assertNotIn("SIMO", policy["peer_symbols"])
        self.assertNotIn("RMBS", policy["peer_symbols"])
        self.assertGreaterEqual(policy["terminal_margin_cap"], 0.45)
        self.assertGreaterEqual(policy["structural_forward_eps_weight"], 0.70)
        self.assertGreaterEqual(policy["structural_forward_pe_floor"], 6.0)
        self.assertIn("Forward P/E", policy["weights"])

    def test_mu_diversified_memory_policy_models_hbm_cycle_explicitly(self):
        policy = memory_storage_valuation_policy(
            "MU", "Micron produces DRAM, HBM and NAND memory",
        )
        self.assertEqual(policy["subtype"], "DIVERSIFIED_MEMORY")
        self.assertIn("HBM", policy["label"])
        self.assertIn("Forward P/E", policy["weights"])
        self.assertIn("Normalized P/E", policy["weights"])
        self.assertGreaterEqual(policy["growth_cap"], 0.50)
        self.assertGreaterEqual(policy["forward_ebit_margin_cap"], 0.80)
        self.assertGreaterEqual(policy["structural_forward_eps_weight"], 0.65)

    def test_currency_pair_policy_normalizes_adrs_and_preserves_same_currency(self):
        self.assertEqual(currency_pair_candidates("USD", "USD"), [])
        self.assertEqual(
            currency_pair_candidates("TWD", "USD"),
            [("TWDUSD=X", False), ("USDTWD=X", True)],
        )
        self.assertEqual(currency_pair_candidates("not-a-currency", "USD"), [])
        self.assertEqual(convert_currency_amount(100, "USD", "USD"), 100.0)
        self.assertAlmostEqual(
            convert_currency_amount(1000, "TWD", "USD", 0.031), 31.0,
        )
        self.assertIsNone(convert_currency_amount(1000, "TWD", "USD", None))

    def test_quote_share_basis_uses_adr_equivalent_market_cap_over_price(self):
        market_cap = 2_172_000_000_000
        price = 419
        implied = market_cap / price
        self.assertAlmostEqual(
            quote_equivalent_share_count(market_cap, price, implied), implied,
        )
        # A five-times underlying-share count must not replace the ADR basis.
        self.assertAlmostEqual(
            quote_equivalent_share_count(market_cap, price, implied * 5), implied,
        )

    def test_directional_scenario_shift_is_monotonic_even_in_contraction(self):
        base_growth = -0.12
        bear = apply_directional_scenario_shift(base_growth, -0.22)
        bull = apply_directional_scenario_shift(base_growth, 0.18)
        self.assertLess(bear, base_growth)
        self.assertGreater(bull, base_growth)
        self.assertLess(
            apply_directional_scenario_shift(0.30, -0.22),
            0.30,
        )

    def test_provider_scenario_ranges_and_method_outputs_cannot_invert(self):
        self.assertEqual(
            normalize_scenario_estimates(130, 120, 110),
            (110.0, 120.0, 130.0),
        )
        self.assertEqual(
            normalize_scenario_estimates(125, 120, 140),
            (120.0, 120.0, 140.0),
        )
        accepted, rejected = filter_non_monotonic_scenario_methods({
            "Bear": {"DCF": 130, "Forward P/E": 90},
            "Base": {"DCF": 120, "Forward P/E": 100},
            "Bull": {"DCF": 150, "Forward P/E": 95},
        })
        self.assertNotIn("DCF", accepted["Bear"])
        self.assertEqual(rejected["Bear"]["DCF"], 130)
        self.assertNotIn("Forward P/E", accepted["Bull"])
        self.assertEqual(rejected["Bull"]["Forward P/E"], 95)

    def test_missing_fx_revenue_path_fails_closed_without_crashing(self):
        self.assertEqual(
            complete_forward_revenue_path(None, None, None, 0.15),
            (None, None),
        )
        first, second = complete_forward_revenue_path(None, None, 100, 0.15)
        self.assertEqual(first, 100.0)
        self.assertAlmostEqual(second, 115.0)

    def test_robust_analyst_policy_filters_outlier_and_caps_street_weight(self):
        policy = robust_analyst_target_policy(
            100,
            120,
            verified_targets=[130, 132, 135, 138, 140, 500],
            rolling_mean=150,
            rolling_median=145,
            opinion_count=30,
            archetype="MEMORY_STORAGE",
        )
        self.assertEqual(policy["source"], "verified current-year firm targets")
        self.assertEqual(policy["filtered_count"], 1)
        self.assertLess(policy["anchor"], 150)
        self.assertGreater(policy["objective"], 120)
        self.assertLessEqual(policy["weight"], 0.40)

    def test_rolling_consensus_receives_less_weight_than_verified_firm_targets(self):
        verified = robust_analyst_target_policy(
            100, 110, verified_targets=[125, 130, 135, 140],
            opinion_count=20, archetype="WAFER_FOUNDRY",
        )
        rolling = robust_analyst_target_policy(
            100, 110, verified_targets=[], rolling_mean=133,
            rolling_median=132, opinion_count=20, archetype="WAFER_FOUNDRY",
        )
        self.assertGreater(verified["weight"], rolling["weight"])

    def test_thin_verified_targets_are_combined_transparently_not_discarded(self):
        policy = robust_analyst_target_policy(
            100, 110, verified_targets=[125, 130], rolling_mean=135,
            rolling_median=134, rolling_low=90, rolling_high=180,
            opinion_count=20, archetype="WAFER_FOUNDRY",
        )
        self.assertEqual(
            policy["source"],
            "thin verified firm targets + rolling provider consensus",
        )
        self.assertEqual(policy["verified_count"], 2)
        self.assertEqual(policy["provider_opinion_count"], 20)
        self.assertLess(policy["anchor"], 134)

    def test_wide_rolling_target_range_reduces_reliability(self):
        tight = robust_analyst_target_policy(
            100, 110, rolling_mean=130, rolling_median=129,
            rolling_low=120, rolling_high=140, opinion_count=20,
            archetype="MEMORY_STORAGE",
        )
        wide = robust_analyst_target_policy(
            100, 110, rolling_mean=130, rolling_median=129,
            rolling_low=40, rolling_high=400, opinion_count=20,
            archetype="MEMORY_STORAGE",
        )
        self.assertLess(wide["reliability"], tight["reliability"])
        self.assertLess(wide["weight"], tight["weight"])

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

    def test_primary_business_taxonomy_covers_packaging_test_and_process_control(self):
        self.assertEqual(
            infer_valuation_archetype(
                "AMKR",
                "outsourced semiconductor assembly and test for NAND and HBM devices",
            ),
            "PACKAGING_OSAT",
        )
        self.assertEqual(
            infer_valuation_archetype(
                "UNKNOWN",
                "outsourced semiconductor assembly and test services including memory testing",
            ),
            "PACKAGING_OSAT",
        )
        self.assertEqual(infer_valuation_archetype("ASX"), "PACKAGING_OSAT")
        self.assertEqual(infer_valuation_archetype("KLIC"), "PACKAGING_EQUIPMENT")
        self.assertEqual(
            infer_valuation_archetype("TER", "DRAM and HBM automated test equipment"),
            "SEMICONDUCTOR_TEST",
        )
        self.assertEqual(infer_valuation_archetype("FORM"), "TEST_INTERFACE")
        self.assertEqual(infer_valuation_archetype("COHU"), "SEMICONDUCTOR_TEST")
        self.assertEqual(infer_valuation_archetype("AEHR"), "BURN_IN_TEST")
        self.assertEqual(infer_valuation_archetype("KLAC"), "SEMI_PROCESS_CONTROL")

    def test_foundry_with_secondary_packaging_remains_a_foundry(self):
        description = (
            "pure-play wafer foundry providing leading process nodes, wafer fabrication, "
            "and advanced packaging including CoWoS"
        )
        self.assertEqual(
            infer_valuation_archetype("UNKNOWN", description),
            "WAFER_FOUNDRY",
        )
        self.assertIn(
            "ADVANCED_PACKAGING",
            infer_secondary_ai_exposures("TSM", description),
        )

    def test_data_center_power_subtypes_use_economically_distinct_policies(self):
        policies = {
            ticker: data_center_power_valuation_policy(ticker)
            for ticker in ("BE", "VRT", "ETN", "GEV", "PWR")
        }
        self.assertEqual(policies["BE"]["subtype"], "DISTRIBUTED_POWER")
        self.assertEqual(policies["VRT"]["subtype"], "CRITICAL_POWER_COOLING")
        self.assertEqual(policies["ETN"]["subtype"], "ELECTRICAL_EQUIPMENT")
        self.assertEqual(policies["GEV"]["subtype"], "ELECTRICAL_EQUIPMENT")
        self.assertEqual(policies["PWR"]["subtype"], "POWER_CONSTRUCTION")
        self.assertIn("EV/Sales", policies["BE"]["weights"])
        self.assertNotEqual(policies["BE"]["peer_symbols"], policies["PWR"]["peer_symbols"])
        for policy in policies.values():
            self.assertAlmostEqual(sum(policy["weights"].values()), 1.0)

    def test_regulated_utilities_are_not_mixed_with_merchant_generators(self):
        self.assertEqual(infer_valuation_archetype("NEE"), "REGULATED_UTILITY")
        self.assertEqual(infer_valuation_archetype("CEG"), "POWER_GENERATION")

    def test_fiscal_calendarization_differs_for_mu_and_tsm_year_ends(self):
        as_of = datetime(2026, 8, 9, tzinfo=timezone.utc)
        mu = calendarize_fiscal_estimate(
            100, 200, datetime(2026, 8, 28, tzinfo=timezone.utc), as_of=as_of,
        )
        tsm = calendarize_fiscal_estimate(
            100, 200, datetime(2026, 12, 31, tzinfo=timezone.utc), as_of=as_of,
        )
        self.assertAlmostEqual(mu["next_fy_weight"], 0.947, places=2)
        self.assertAlmostEqual(tsm["next_fy_weight"], 0.605, places=2)
        self.assertGreater(mu["value"], tsm["value"])

    def test_quarterly_evidence_allows_hbm_margin_but_shrinks_malformed_eps(self):
        corroborated = reconcile_forward_eps_estimate(
            140,
            200_000_000_000,
            1_000_000_000,
            quarterly_pairs=[(35, 50_000_000_000), (34, 49_000_000_000)],
            current_net_margin=0.66,
        )
        self.assertEqual(corroborated["status"], "quarter-corroborated")
        self.assertEqual(corroborated["value"], 140)

        malformed = reconcile_forward_eps_estimate(
            190,
            200_000_000_000,
            1_000_000_000,
            quarterly_pairs=[(35, 50_000_000_000), (34, 49_000_000_000)],
            current_net_margin=0.66,
        )
        self.assertEqual(malformed["status"], "shrunk-to-evidence-envelope")
        self.assertLess(malformed["value"], 190)
        self.assertLessEqual(malformed["margin_cap"], 0.90)

    def test_dual_listed_peers_receive_one_issuer_vote(self):
        self.assertEqual(
            dedupe_peer_symbols("AMKR", ["ASX", "3711.TW", "6239.TW"]),
            ["ASX", "6239.TW"],
        )
        self.assertEqual(
            dedupe_peer_symbols("ASX", ["AMKR", "3711.TW", "6239.TW"]),
            ["AMKR", "6239.TW"],
        )

    def test_robust_composite_never_mutates_raw_dcf(self):
        result = robust_method_composite(
            {"DCF": 100, "Forward P/E": 300, "EV/EBITDA": 310},
            {"DCF": 0.30, "Forward P/E": 0.40, "EV/EBITDA": 0.30},
            (0.50, 2.00),
        )
        self.assertEqual(result["used_values"]["DCF"], 100)
        self.assertEqual(result["used_values"]["Forward P/E"], 300)
        self.assertGreaterEqual(result["family_count"], 2)

    def test_form_plain_word_is_not_treated_as_a_ticker_mention(self):
        unrelated = item(
            "Company files a new tax form after earnings",
            summary="The form is available online.",
        )
        qualified = item(
            "$FORM raises semiconductor probe-card guidance",
            summary="FormFactor demand improves.",
        )
        self.assertLess(
            relevance_score(unrelated, "FORM", "FormFactor", "SEMICONDUCTOR_TEST"),
            0.42,
        )
        self.assertGreater(
            relevance_score(qualified, "FORM", "FormFactor", "SEMICONDUCTOR_TEST"),
            0.70,
        )


if __name__ == "__main__":
    unittest.main()
