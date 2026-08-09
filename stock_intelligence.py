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
import statistics
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timedelta, timezone
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
        "pure-play foundry", "wafer foundry", "wafer fabrication", "wafer fab",
        "process node", "chip manufacturing", "semiconductor fabrication",
    ),
    "SEMI_EQUIPMENT": (
        "lithography", "wafer equipment", "etch", "deposition",
        "semiconductor capital equipment", "wafer processing equipment",
    ),
    "SEMI_PROCESS_CONTROL": (
        "process control", "wafer inspection", "defect inspection", "metrology",
        "yield management", "optical inspection", "inspection equipment",
    ),
    "SEMICONDUCTOR_TEST": (
        "semiconductor test", "automated test equipment", "probe card", "wafer probe",
        "system level test", "burn-in test", "test handler", "test and measurement",
    ),
    "ADVANCED_PACKAGING": (
        "advanced packaging", "outsourced semiconductor assembly", "outsourced assembly",
        "semiconductor packaging and test", "chip packaging", "wafer-level packaging",
        "heterogeneous integration", "system-in-package", "flip chip packaging",
    ),
    "PHOTONICS_OPTICS": (
        "photonics", "silicon photonics", "optical transceiver", "co-packaged optics",
        "laser diode", "datacom optics", "optical networking",
    ),
    "NETWORKING_OPTICS": (
        "ethernet switching", "network switch", "data center networking",
        "networking silicon", "high-speed interconnect",
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
    "REGULATED_UTILITY": (
        "regulated electric utility", "rate base", "regulated utility",
        "electric transmission utility", "public utility",
    ),
    "AI_CLOUD_INFRA": (
        "gpu cloud", "ai cloud", "compute hosting", "ai infrastructure provider",
    ),
    "AI_SOFTWARE": (
        "ai software", "data platform", "machine learning platform", "application software",
    ),
    "DATA_CENTER_REIT": (
        "data center reit", "data center real estate", "colocation data center",
    ),
}

# Tie-breaking is explicit so a description mentioning both a customer's AI
# workload and the supplier's actual business model is classified by the latter.
AI_THEME_PRIORITY = {
    "ADVANCED_PACKAGING": 100,
    "SEMICONDUCTOR_TEST": 95,
    "SEMI_PROCESS_CONTROL": 90,
    "WAFER_FOUNDRY": 85,
    "SEMI_EQUIPMENT": 80,
    "MEMORY_STORAGE": 75,
    "PHOTONICS_OPTICS": 70,
    "NETWORKING_OPTICS": 68,
    "AI_COMPUTE": 65,
    "DATA_CENTER_POWER": 60,
    "POWER_GENERATION": 55,
    "REGULATED_UTILITY": 54,
    "HYPERSCALER": 50,
    "AI_CLOUD_INFRA": 45,
    "AI_SOFTWARE": 40,
    "DATA_CENTER_REIT": 35,
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
    "ACMR": "SEMI_EQUIPMENT", "MKSI": "SEMI_EQUIPMENT", "UCTT": "SEMI_EQUIPMENT",
    "ACLS": "SEMI_EQUIPMENT",
    # Inspection, metrology and yield/process control
    "KLAC": "SEMI_PROCESS_CONTROL", "ONTO": "SEMI_PROCESS_CONTROL",
    "CAMT": "SEMI_PROCESS_CONTROL", "NVMI": "SEMI_PROCESS_CONTROL",
    # Semiconductor automated test, probe cards and burn-in
    "TER": "SEMICONDUCTOR_TEST", "FORM": "SEMICONDUCTOR_TEST",
    "COHU": "SEMICONDUCTOR_TEST", "AEHR": "SEMICONDUCTOR_TEST",
    "ATEYY": "SEMICONDUCTOR_TEST", "6857.T": "SEMICONDUCTOR_TEST",
    "TPRO.MI": "SEMICONDUCTOR_TEST",
    # Outsourced assembly/test and advanced-packaging equipment
    "AMKR": "ADVANCED_PACKAGING", "ASX": "ADVANCED_PACKAGING",
    "KLIC": "ADVANCED_PACKAGING", "BESI.AS": "ADVANCED_PACKAGING",
    "0522.HK": "ADVANCED_PACKAGING", "3711.TW": "ADVANCED_PACKAGING",
    "6239.TW": "ADVANCED_PACKAGING",
    # Photonics / optical interconnect
    "COHR": "PHOTONICS_OPTICS", "LITE": "PHOTONICS_OPTICS", "AAOI": "PHOTONICS_OPTICS",
    "FN": "PHOTONICS_OPTICS", "IPGP": "PHOTONICS_OPTICS", "CIEN": "PHOTONICS_OPTICS",
    # Memory / storage
    "MU": "MEMORY_STORAGE", "WDC": "MEMORY_STORAGE", "STX": "MEMORY_STORAGE",
    "SNDK": "MEMORY_STORAGE", "SIMO": "MEMORY_STORAGE", "RMBS": "MEMORY_STORAGE",
    "285A.T": "MEMORY_STORAGE", "000660.KS": "MEMORY_STORAGE",
    "005930.KS": "MEMORY_STORAGE",
    # Data-center electrical, thermal and distributed generation (including Bloom)
    "BE": "DATA_CENTER_POWER", "VRT": "DATA_CENTER_POWER", "ETN": "DATA_CENTER_POWER",
    "GEV": "DATA_CENTER_POWER", "PWR": "DATA_CENTER_POWER", "CARR": "DATA_CENTER_POWER",
    "NVT": "DATA_CENTER_POWER", "HUBB": "DATA_CENTER_POWER", "EME": "DATA_CENTER_POWER",
    # Generators / grid beneficiaries
    "CEG": "POWER_GENERATION", "VST": "POWER_GENERATION", "NRG": "POWER_GENERATION",
    "TLN": "POWER_GENERATION",
    "NEE": "REGULATED_UTILITY", "AEP": "REGULATED_UTILITY",
    "DUK": "REGULATED_UTILITY", "SO": "REGULATED_UTILITY", "D": "REGULATED_UTILITY",
    # Networking and switching
    "ANET": "NETWORKING_OPTICS", "ALAB": "NETWORKING_OPTICS",
    # GPU cloud / AI infrastructure
    "CRWV": "AI_CLOUD_INFRA", "NBIS": "AI_CLOUD_INFRA", "IREN": "AI_CLOUD_INFRA",
    # AI software and data platforms
    "PLTR": "AI_SOFTWARE", "SNOW": "AI_SOFTWARE", "NOW": "AI_SOFTWARE",
    "CRM": "AI_SOFTWARE", "DDOG": "AI_SOFTWARE",
    # Data-center real estate
    "EQIX": "DATA_CENTER_REIT", "DLR": "DATA_CENTER_REIT",
}


THEME_TO_VALUATION_ARCHETYPE = {
    "HYPERSCALER": "MEGA_CAP_PLATFORM",
    "AI_COMPUTE": "AI_COMPUTE",
    "WAFER_FOUNDRY": "WAFER_FOUNDRY",
    "SEMI_EQUIPMENT": "SEMI_EQUIPMENT",
    "SEMI_PROCESS_CONTROL": "SEMI_PROCESS_CONTROL",
    "SEMICONDUCTOR_TEST": "SEMICONDUCTOR_TEST",
    "ADVANCED_PACKAGING": "ADVANCED_PACKAGING",
    "NETWORKING_OPTICS": "NETWORKING_OPTICS",
    "PHOTONICS_OPTICS": "PHOTONICS_OPTICS",
    "MEMORY_STORAGE": "MEMORY_STORAGE",
    "DATA_CENTER_POWER": "DATA_CENTER_POWER",
    "POWER_GENERATION": "POWER_GENERATION",
    "REGULATED_UTILITY": "REGULATED_UTILITY",
    "AI_CLOUD_INFRA": "AI_CLOUD_INFRA",
    "AI_SOFTWARE": "AI_SOFTWARE",
    "DATA_CENTER_REIT": "DATA_CENTER_REIT",
    "GENERAL_AI": "GENERAL_AI",
}


SECONDARY_AI_EXPOSURE_OVERRIDES = {
    # TSMC's primary economics are foundry manufacturing, while CoWoS/SoIC are
    # strategically important secondary exposure—not a reason to value it as an OSAT.
    "TSM": ("ADVANCED_PACKAGING",),
    "AMAT": ("ADVANCED_PACKAGING",),
    "LRCX": ("ADVANCED_PACKAGING",),
}


PACKAGING_ARCHETYPE_OVERRIDES = {
    "AMKR": "PACKAGING_OSAT", "ASX": "PACKAGING_OSAT",
    "3711.TW": "PACKAGING_OSAT", "6239.TW": "PACKAGING_OSAT",
    "KLIC": "PACKAGING_EQUIPMENT", "BESI.AS": "PACKAGING_EQUIPMENT",
    "0522.HK": "PACKAGING_EQUIPMENT",
}

TEST_ARCHETYPE_OVERRIDES = {
    "TER": "SEMICONDUCTOR_TEST", "COHU": "SEMICONDUCTOR_TEST",
    "ATEYY": "SEMICONDUCTOR_TEST", "6857.T": "SEMICONDUCTOR_TEST",
    "FORM": "TEST_INTERFACE", "TPRO.MI": "TEST_INTERFACE",
    "AEHR": "BURN_IN_TEST",
}


def infer_packaging_archetype(ticker, company_text=""):
    symbol = str(ticker or "").strip().upper()
    if symbol in PACKAGING_ARCHETYPE_OVERRIDES:
        return PACKAGING_ARCHETYPE_OVERRIDES[symbol]
    text = str(company_text or "").lower()
    equipment_terms = (
        "packaging equipment", "die attach", "die bonding", "wire bonding",
        "assembly equipment", "hybrid bonding equipment",
    )
    return (
        "PACKAGING_EQUIPMENT"
        if any(term in text for term in equipment_terms)
        else "PACKAGING_OSAT"
    )


def infer_test_archetype(ticker, company_text=""):
    symbol = str(ticker or "").strip().upper()
    if symbol in TEST_ARCHETYPE_OVERRIDES:
        return TEST_ARCHETYPE_OVERRIDES[symbol]
    text = str(company_text or "").lower()
    if any(term in text for term in ("probe card", "wafer probe", "test interface")):
        return "TEST_INTERFACE"
    if any(term in text for term in ("burn-in", "wafer-level burn in", "reliability test")):
        return "BURN_IN_TEST"
    return "SEMICONDUCTOR_TEST"


MEMORY_STORAGE_SUBTYPE_OVERRIDES = {
    "SNDK": "NAND_FLASH",
    "285A.T": "NAND_FLASH",
    "MU": "DIVERSIFIED_MEMORY",
    "000660.KS": "DIVERSIFIED_MEMORY",
    "005930.KS": "DIVERSIFIED_MEMORY",
    "WDC": "HDD",
    "STX": "HDD",
    "SIMO": "CONTROLLER",
    "RMBS": "MEMORY_IP",
}


def infer_memory_storage_subtype(ticker, company_text=""):
    """Separate NAND producers from economically different storage businesses."""
    symbol = str(ticker or "").strip().upper()
    if symbol in MEMORY_STORAGE_SUBTYPE_OVERRIDES:
        return MEMORY_STORAGE_SUBTYPE_OVERRIDES[symbol]
    text = str(company_text or "").lower()
    if "nand" in text or "flash memory" in text or "solid state drive" in text:
        return "NAND_FLASH"
    if "dram" in text or "high bandwidth memory" in text or "hbm" in text:
        return "DIVERSIFIED_MEMORY"
    if "hard disk" in text or "hdd" in text:
        return "HDD"
    if "controller" in text:
        return "CONTROLLER"
    if "memory interface" in text or "semiconductor ip" in text:
        return "MEMORY_IP"
    return "GENERAL_MEMORY_STORAGE"


def memory_storage_valuation_policy(ticker, company_text=""):
    """Return a transparent policy overlay for memory/storage valuation.

    Sandisk is a NAND/flash producer with joint-venture wafer economics. Treating
    it like an HDD vendor, controller designer, or IP licensor depresses both its
    normalized margin and peer multiple. The overlay still excludes analyst price
    targets; it changes only operating assumptions and comparable companies.
    """
    subtype = infer_memory_storage_subtype(ticker, company_text)
    policies = {
        "NAND_FLASH": {
            "subtype": subtype,
            "label": "NAND Flash & Enterprise SSD",
            "peer_symbols": ["285A.T", "MU", "000660.KS", "005930.KS"],
            "weights": {
                "DCF": 0.05,
                "Forward P/E": 0.45,
                "Normalized P/E": 0.25,
                "EV/EBITDA": 0.25,
            },
            "growth_cap": 0.55,
            "terminal_margin_floor": 0.12,
            "terminal_margin_cap": 0.50,
            "forward_ebit_margin_cap": 0.90,
            "structural_forward_eps_weight": 0.75,
            "structural_forward_pe_floor": 7.0,
            "structural_normalized_pe_floor": 6.5,
            "outlier_band": (0.45, 2.10),
        },
        "DIVERSIFIED_MEMORY": {
            "subtype": subtype,
            "label": "Diversified DRAM, HBM & NAND Memory",
            "peer_symbols": ["SNDK", "285A.T", "000660.KS", "005930.KS"],
            # HBM-led memory upcycles can change mix, margins and earnings power
            # faster than a trailing mid-cycle average. Keep normalization in the
            # model, while requiring cash-flow/EBITDA corroboration before the
            # period-matched earnings regime controls the result.
            "weights": {
                "DCF": 0.15,
                "Forward P/E": 0.30,
                "Normalized P/E": 0.15,
                "EV/EBITDA": 0.25,
                "EV/FCF": 0.15,
            },
            "growth_cap": 0.65,
            "terminal_margin_floor": 0.12,
            "terminal_margin_cap": 0.42,
            # A broad ceiling only. The report engine applies the tighter,
            # company-specific envelope from current and next-quarter EPS/revenue.
            # This still leaves room for a corroborated HBM margin regime without
            # admitting impossible EBIT above revenue.
            "forward_ebit_margin_cap": 0.90,
            "structural_forward_eps_weight": 0.72,
            "structural_forward_pe_floor": 6.5,
            "structural_normalized_pe_floor": 6.5,
            "outlier_band": (0.50, 1.95),
        },
        "HDD": {
            "subtype": subtype,
            "label": "Hard-Disk Storage",
            "peer_symbols": ["WDC", "STX"],
        },
        "CONTROLLER": {
            "subtype": subtype,
            "label": "Storage Controller Semiconductors",
            "peer_symbols": ["SIMO", "MRVL", "MCHP"],
        },
        "MEMORY_IP": {
            "subtype": subtype,
            "label": "Memory Interface IP",
            "peer_symbols": ["RMBS", "ARM", "SNPS", "CDNS"],
        },
    }
    return dict(policies.get(subtype, {
        "subtype": subtype,
        "label": "General Memory & Storage",
        "peer_symbols": ["MU", "SNDK", "WDC", "STX"],
    }))


DATA_CENTER_POWER_SUBTYPE_OVERRIDES = {
    "BE": "DISTRIBUTED_POWER",
    "VRT": "CRITICAL_POWER_COOLING", "CARR": "CRITICAL_POWER_COOLING",
    "NVT": "CRITICAL_POWER_COOLING",
    "ETN": "ELECTRICAL_EQUIPMENT", "GEV": "ELECTRICAL_EQUIPMENT",
    "HUBB": "ELECTRICAL_EQUIPMENT",
    "PWR": "POWER_CONSTRUCTION", "EME": "POWER_CONSTRUCTION",
}


def infer_data_center_power_subtype(ticker, company_text=""):
    symbol = str(ticker or "").strip().upper()
    if symbol in DATA_CENTER_POWER_SUBTYPE_OVERRIDES:
        return DATA_CENTER_POWER_SUBTYPE_OVERRIDES[symbol]
    text = str(company_text or "").lower()
    if any(term in text for term in ("fuel cell", "distributed power", "microgrid")):
        return "DISTRIBUTED_POWER"
    if any(term in text for term in ("cooling", "thermal management", "ups system", "critical digital infrastructure")):
        return "CRITICAL_POWER_COOLING"
    if any(term in text for term in ("switchgear", "electrical equipment", "power management")):
        return "ELECTRICAL_EQUIPMENT"
    if any(term in text for term in ("engineering and construction", "electrical contractor", "infrastructure solutions")):
        return "POWER_CONSTRUCTION"
    return "GENERAL_DATA_CENTER_POWER"


def data_center_power_valuation_policy(ticker, company_text=""):
    """Separate economically different suppliers behind data-center power demand."""
    subtype = infer_data_center_power_subtype(ticker, company_text)
    policies = {
        "DISTRIBUTED_POWER": {
            "subtype": subtype,
            "label": "Distributed / On-Site Data-Center Power",
            "peer_symbols": ["VRT", "GEV", "FCEL", "PLUG"],
            "weights": {"DCF": 0.05, "Forward P/E": 0.10, "EV/Sales": 0.65, "EV/EBITDA": 0.20},
            "forecast_years": 10,
            "sales_to_capital": 0.75,
            "growth_cap": 0.45,
            "terminal_margin_floor": 0.06,
            "terminal_margin_cap": 0.28,
            "outlier_band": (0.38, 2.45),
        },
        "CRITICAL_POWER_COOLING": {
            "subtype": subtype,
            "label": "Critical Power & Cooling Infrastructure",
            "peer_symbols": ["VRT", "NVT", "CARR", "JCI"],
            "weights": {"DCF": 0.15, "Forward P/E": 0.35, "EV/EBITDA": 0.35, "EV/FCF": 0.15},
            "forecast_years": 9,
            "sales_to_capital": 1.15,
            "growth_cap": 0.35,
            "terminal_margin_floor": 0.10,
            "terminal_margin_cap": 0.32,
            "outlier_band": (0.48, 2.10),
        },
        "ELECTRICAL_EQUIPMENT": {
            "subtype": subtype,
            "label": "Electrical Distribution & Grid Equipment",
            "peer_symbols": ["ETN", "HUBB", "GEV", "ABBN.SW"],
            "weights": {"DCF": 0.20, "Forward P/E": 0.35, "EV/EBITDA": 0.30, "EV/FCF": 0.15},
            "forecast_years": 9,
            "sales_to_capital": 1.10,
            "growth_cap": 0.25,
            "terminal_margin_floor": 0.12,
            "terminal_margin_cap": 0.28,
            "outlier_band": (0.55, 1.90),
        },
        "POWER_CONSTRUCTION": {
            "subtype": subtype,
            "label": "Power Engineering & Construction",
            "peer_symbols": ["PWR", "EME", "FIX", "MTZ"],
            "weights": {"DCF": 0.15, "Forward P/E": 0.35, "EV/EBITDA": 0.30, "EV/FCF": 0.20},
            "forecast_years": 8,
            "sales_to_capital": 1.65,
            "growth_cap": 0.25,
            "terminal_margin_floor": 0.04,
            "terminal_margin_cap": 0.16,
            "outlier_band": (0.55, 1.85),
        },
    }
    return dict(policies.get(subtype, {
        "subtype": subtype,
        "label": "General Data-Center Power Infrastructure",
        "peer_symbols": ["VRT", "ETN", "GEV", "PWR"],
    }))


def normalize_currency_code(value):
    """Return a conservative three-letter currency code or an empty string."""
    code = str(value or "").strip().upper()
    return code if re.fullmatch(r"[A-Z]{3}", code) else ""


def currency_pair_candidates(financial_currency, quote_currency):
    """Return Yahoo FX symbols and whether each quote must be inverted.

    Yahoo normally exposes `TWDUSD=X` as USD per TWD. Some pairs are available
    only in the reverse direction, so callers try both forms and invert the
    second. Keeping this mapping explicit prevents an ADR's TWD/EUR statements
    from being combined directly with a USD share price.
    """
    source = normalize_currency_code(financial_currency)
    destination = normalize_currency_code(quote_currency)
    if not source or not destination or source == destination:
        return []
    return [
        (f"{source}{destination}=X", False),
        (f"{destination}{source}=X", True),
    ]


def convert_currency_amount(value, source_currency, quote_currency, rate=None):
    """Convert one monetary value, failing closed when cross-currency FX is absent."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    source = normalize_currency_code(source_currency)
    destination = normalize_currency_code(quote_currency)
    if not source or not destination:
        return None
    if source == destination:
        return number
    try:
        rate = float(rate)
    except (TypeError, ValueError):
        return None
    return number * rate if math.isfinite(rate) and rate > 0 else None


def quote_equivalent_share_count(market_cap, current_price, reported_shares=None):
    """Use the share/ADR basis consistent with quote-currency market value."""
    try:
        market_cap = float(market_cap)
        current_price = float(current_price)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(value) and value > 0 for value in (market_cap, current_price)):
        return None
    implied = market_cap / current_price
    try:
        reported = float(reported_shares)
    except (TypeError, ValueError):
        reported = None
    if reported is not None and math.isfinite(reported) and reported > 0:
        ratio = reported / implied
        if 0.75 <= ratio <= 1.25:
            return reported
    return implied


def apply_directional_scenario_shift(value, relative_shift, floor_scale=0.08):
    """Move a metric monotonically for bear/bull cases, including negatives.

    Multiplying a negative growth rate by `(1 - bear_shift)` accidentally makes
    the contraction less severe. This helper moves a bear case downward and a
    bull case upward regardless of the starting sign.
    """
    try:
        value = float(value)
        relative_shift = float(relative_shift)
        floor_scale = abs(float(floor_scale))
    except (TypeError, ValueError):
        return value
    if not math.isfinite(value) or not math.isfinite(relative_shift):
        return value
    magnitude = max(abs(value), floor_scale)
    return value + relative_shift * magnitude


def normalize_scenario_estimates(low, base, high):
    """Keep provider bear/base/bull estimates ordered without inventing values."""
    def finite(value):
        try:
            number = float(value)
            return number if math.isfinite(number) and number > 0 else None
        except (TypeError, ValueError):
            return None

    low_value, base_value, high_value = map(finite, (low, base, high))
    if low_value is not None and high_value is not None and low_value > high_value:
        low_value, high_value = high_value, low_value
    if base_value is not None:
        if low_value is not None:
            low_value = min(low_value, base_value)
        if high_value is not None:
            high_value = max(high_value, base_value)
    return low_value, base_value, high_value


def complete_forward_revenue_path(year_one, year_two, trailing_revenue, growth):
    """Complete a two-year revenue path without multiplying a missing value."""
    def positive(value):
        try:
            number = float(value)
            return number if math.isfinite(number) and number > 0 else None
        except (TypeError, ValueError):
            return None

    first = positive(year_one) or positive(trailing_revenue)
    second = positive(year_two)
    if second is None and first is not None:
        try:
            growth_value = float(growth)
        except (TypeError, ValueError):
            growth_value = 0.0
        if not math.isfinite(growth_value):
            growth_value = 0.0
        second = first * max(1.0 + growth_value, 0.01)
    return first, second


def calendarize_fiscal_estimate(
    current_fy_value,
    next_fy_value,
    current_fy_end,
    *,
    as_of=None,
    target_days=365,
):
    """Calendarize FY0/FY+1 estimates to the actual 12-month target date.

    Yahoo's `nextFiscalYearEnd` is the endpoint for its `0y` estimate. The `+1y`
    estimate ends roughly one year later. Linear calendarization is preferable
    to always extrapolating beyond FY+1, which materially distorted companies
    with August and December fiscal year ends in opposite directions.
    """
    def number(value):
        try:
            parsed = float(value)
            return parsed if math.isfinite(parsed) and parsed > 0 else None
        except (TypeError, ValueError):
            return None

    def moment(value):
        if isinstance(value, datetime):
            parsed = value
        elif isinstance(value, (int, float)):
            try:
                timestamp = float(value)
                if timestamp > 10_000_000_000:
                    timestamp /= 1000.0
                parsed = datetime.fromtimestamp(timestamp, tz=timezone.utc)
            except (OverflowError, OSError, ValueError):
                return None
        else:
            try:
                parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
            except ValueError:
                return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    fy0 = number(current_fy_value)
    fy1 = number(next_fy_value)
    if fy0 is None and fy1 is None:
        return {"value": None, "next_fy_weight": None, "quality": "missing"}
    if fy0 is None:
        return {"value": fy1, "next_fy_weight": 1.0, "quality": "single-estimate fallback"}
    if fy1 is None:
        return {"value": fy0, "next_fy_weight": 0.0, "quality": "single-estimate fallback"}

    now = moment(as_of) or datetime.now(timezone.utc)
    fy0_end = moment(current_fy_end)
    if fy0_end is None:
        return {"value": fy1, "next_fy_weight": 1.0, "quality": "fiscal-date fallback"}
    target_date = now + timedelta(days=max(int(target_days), 1))
    next_fy_end = fy0_end + timedelta(days=365.2425)
    span_seconds = (next_fy_end - fy0_end).total_seconds()
    weight = (target_date - fy0_end).total_seconds() / span_seconds
    weight = max(0.0, min(1.0, weight))
    value = fy0 * (1.0 - weight) + fy1 * weight
    return {"value": value, "next_fy_weight": weight, "quality": "calendarized"}


def reconcile_forward_eps_estimate(
    eps_value,
    revenue_value,
    share_count,
    *,
    quarterly_pairs=None,
    current_net_margin=None,
    absolute_margin_cap=0.90,
):
    """Validate an annual EPS estimate against period-matched quarterly evidence.

    A static semiconductor margin ceiling fails in both directions: it rejects a
    genuine HBM-driven margin regime and can still accept a malformed estimate for
    a lower-margin OSAT or equipment vendor.  This guard derives a company-specific
    envelope from 0q/+1q EPS and revenue, with current net margin as a secondary
    anchor.  Values outside that envelope are shrunk transparently, never silently
    rescaled by a guessed power of ten.
    """
    def positive(value):
        try:
            number = float(value)
            return number if math.isfinite(number) and number > 0 else None
        except (TypeError, ValueError):
            return None

    eps = positive(eps_value)
    revenue = positive(revenue_value)
    shares = positive(share_count)
    if eps is None or revenue is None or shares is None:
        return {
            "value": None,
            "status": "missing",
            "implied_margin": None,
            "margin_cap": None,
            "quarterly_evidence_count": 0,
        }

    quarterly_margins = []
    for pair in quarterly_pairs or []:
        try:
            quarterly_eps, quarterly_revenue = pair
        except (TypeError, ValueError):
            continue
        quarterly_eps = positive(quarterly_eps)
        quarterly_revenue = positive(quarterly_revenue)
        if quarterly_eps is None or quarterly_revenue is None:
            continue
        margin = quarterly_eps * shares / quarterly_revenue
        if math.isfinite(margin) and 0 <= margin <= absolute_margin_cap:
            quarterly_margins.append(margin)

    try:
        current_margin = float(current_net_margin)
        if not math.isfinite(current_margin):
            current_margin = None
    except (TypeError, ValueError):
        current_margin = None

    anchors = []
    if quarterly_margins:
        anchors.append(statistics.median(quarterly_margins) + 0.12)
    if current_margin is not None and current_margin > -0.25:
        anchors.append(max(current_margin, 0.0) + 0.12)

    # Without quarter evidence, remain permissive enough for structural AI-cycle
    # transitions while enforcing an absolute accounting sanity limit.
    evidence_floor = 0.78 if not quarterly_margins else 0.35
    margin_cap = min(
        max(0.05, float(absolute_margin_cap)),
        max([evidence_floor, *anchors]),
    )
    implied_margin = eps * shares / revenue
    if not math.isfinite(implied_margin) or implied_margin < -0.25:
        return {
            "value": None,
            "status": "invalid",
            "implied_margin": implied_margin,
            "margin_cap": margin_cap,
            "quarterly_evidence_count": len(quarterly_margins),
        }
    if implied_margin <= margin_cap:
        status = "quarter-corroborated" if quarterly_margins else "accepted"
        return {
            "value": eps,
            "status": status,
            "implied_margin": implied_margin,
            "margin_cap": margin_cap,
            "quarterly_evidence_count": len(quarterly_margins),
        }

    clipped_eps = margin_cap * revenue / shares
    return {
        "value": clipped_eps,
        "status": "shrunk-to-evidence-envelope",
        "implied_margin": implied_margin,
        "margin_cap": margin_cap,
        "quarterly_evidence_count": len(quarterly_margins),
    }


PEER_ISSUER_ALIASES = {
    # ASE Technology is quoted both as the NYSE ADR and Taiwan ordinary share.
    "ASX": "ASE_TECHNOLOGY",
    "3711.TW": "ASE_TECHNOLOGY",
}


def dedupe_peer_symbols(subject_ticker, peer_symbols, *, limit=6):
    """Remove self-peers and dual listings at the underlying-issuer level."""
    subject = str(subject_ticker or "").strip().upper()
    subject_issuer = PEER_ISSUER_ALIASES.get(subject, subject)
    seen_issuers = {subject_issuer}
    result = []
    for raw_symbol in peer_symbols or []:
        symbol = str(raw_symbol or "").strip().upper()
        if not symbol:
            continue
        issuer = PEER_ISSUER_ALIASES.get(symbol, symbol)
        if issuer in seen_issuers:
            continue
        seen_issuers.add(issuer)
        result.append(symbol)
        if len(result) >= max(int(limit), 0):
            break
    return result


METHOD_FAMILIES = {
    "DCF": "intrinsic",
    "Forward P/E": "earnings-relative",
    "Normalized P/E": "earnings-relative",
    "EV/EBITDA": "enterprise-relative",
    "EV/Sales": "enterprise-relative",
    "EV/FCF": "cash-flow-relative",
}


def robust_method_composite(values, weights, band=(0.50, 2.00)):
    """Blend valuation methods without rewriting any method output.

    The previous winsorizer moved a low DCF upward toward peer multiples. That
    created artificial agreement. Here every displayed value remains raw; only
    its effective weight is reduced when it falls outside the configured robust
    band. Diagnostics expose both the adjusted weights and method-family count.
    """
    valid = {}
    for method, value in (values or {}).items():
        try:
            number = float(value)
            weight = float((weights or {}).get(method, 0.0))
        except (TypeError, ValueError):
            continue
        if math.isfinite(number) and number > 0 and math.isfinite(weight) and weight > 0:
            valid[method] = number
    if not valid:
        return {
            "value": None,
            "used_values": {},
            "effective_weights": {},
            "downweighted_methods": [],
            "family_count": 0,
        }

    center = statistics.median(valid.values())
    low_factor, high_factor = band
    low_boundary = center * max(float(low_factor), 0.01)
    high_boundary = center * max(float(high_factor), float(low_factor), 0.02)
    reliability = {}
    downweighted = []
    for method, value in valid.items():
        if value < low_boundary:
            distance = abs(math.log(max(value, 1e-12) / low_boundary))
        elif value > high_boundary:
            distance = abs(math.log(value / high_boundary))
        else:
            distance = 0.0
        reliability[method] = max(0.15, math.exp(-1.5 * distance))
        if distance > 0:
            downweighted.append(method)

    raw_effective = {
        method: float(weights[method]) * reliability[method]
        for method in valid
    }
    total = sum(raw_effective.values())
    if total <= 0:
        return {
            "value": None,
            "used_values": valid,
            "effective_weights": {},
            "downweighted_methods": downweighted,
            "family_count": len({METHOD_FAMILIES.get(key, key) for key in valid}),
        }
    effective_weights = {
        method: weight / total for method, weight in raw_effective.items()
    }
    composite = sum(valid[method] * effective_weights[method] for method in valid)
    return {
        "value": composite,
        "used_values": valid,
        "effective_weights": effective_weights,
        "downweighted_methods": downweighted,
        "family_count": len({METHOD_FAMILIES.get(key, key) for key in valid}),
    }


def filter_non_monotonic_scenario_methods(raw_by_scenario):
    """Reject scenario methods whose bear/base/bull ordering is inverted.

    Returning the rejected map separately makes the loss of a method visible to
    diagnostics and confidence scoring instead of silently forcing its output to
    the base value.
    """
    accepted = {
        name: dict((raw_by_scenario or {}).get(name) or {})
        for name in ("Bear", "Base", "Bull")
    }
    rejected = {name: {} for name in ("Bear", "Base", "Bull")}
    base_values = accepted["Base"]
    for method, base_value in list(base_values.items()):
        try:
            base_number = float(base_value)
        except (TypeError, ValueError):
            continue
        bear_value = accepted["Bear"].get(method)
        bull_value = accepted["Bull"].get(method)
        try:
            if bear_value is not None and float(bear_value) > base_number:
                rejected["Bear"][method] = accepted["Bear"].pop(method)
        except (TypeError, ValueError):
            rejected["Bear"][method] = accepted["Bear"].pop(method)
        try:
            if bull_value is not None and float(bull_value) < base_number:
                rejected["Bull"][method] = accepted["Bull"].pop(method)
        except (TypeError, ValueError):
            rejected["Bull"][method] = accepted["Bull"].pop(method)
    return accepted, rejected


def robust_analyst_target_policy(
    current_price,
    independent_value,
    *,
    verified_targets=None,
    rolling_mean=None,
    rolling_median=None,
    rolling_low=None,
    rolling_high=None,
    opinion_count=0,
    archetype="GENERAL_AI",
):
    """Build a bounded, auditable Street-calibrated 12-month objective.

    Verified current-year targets use one latest vote per firm before entering
    this function. The policy rejects implausible values, removes extreme
    median-absolute-deviation outliers, favors the median over the mean, and
    caps analyst influence. It never overwrites the independent valuation.
    """
    def positive(value):
        try:
            number = float(value)
            return number if math.isfinite(number) and number > 0 else None
        except (TypeError, ValueError):
            return None

    price = positive(current_price)
    independent = positive(independent_value)
    plausible_low = price * 0.20 if price else 0.0
    plausible_high = price * 5.0 if price else float("inf")
    raw_verified_values = [
        number for number in (positive(value) for value in (verified_targets or []))
        if number is not None
    ]
    verified_values = sorted(
        number for number in raw_verified_values
        if plausible_low <= number <= plausible_high
    )
    rolling_values = sorted(
        number for number in (positive(rolling_mean), positive(rolling_median))
        if number is not None and plausible_low <= number <= plausible_high
    )
    rolling_dispersion_values = sorted(
        number
        for number in (
            *rolling_values,
            positive(rolling_low),
            positive(rolling_high),
        )
        if number is not None and plausible_low <= number <= plausible_high
    )
    try:
        provider_opinion_count = max(int(opinion_count or 0), 0)
    except (TypeError, ValueError):
        provider_opinion_count = 0

    source = "unavailable"
    source_count = 0
    filtered_count = len(raw_verified_values) - len(verified_values)
    reliability_multiplier = 1.0
    coverage_count = 0.0
    anchor = None
    values = []
    dispersion_values = []

    if len(verified_values) >= 3:
        raw_count = len(verified_values)
        center = statistics.median(verified_values)
        deviations = [abs(value - center) for value in verified_values]
        mad = statistics.median(deviations)
        lower = max(plausible_low, center * 0.35)
        upper = min(plausible_high, center * 2.50)
        if mad > 0:
            robust_sigma = 1.4826 * mad
            lower = max(lower, center - 4.0 * robust_sigma)
            upper = min(upper, center + 4.0 * robust_sigma)
        values = [value for value in verified_values if lower <= value <= upper]
        dispersion_values = list(values)
        filtered_count += raw_count - len(values)
        source = "verified current-year firm targets"
        source_count = len(values)
        coverage_count = len(values)
    elif verified_values:
        values = list(verified_values)
        source_count = len(verified_values)
        verified_anchor = (
            0.70 * statistics.median(verified_values)
            + 0.30 * statistics.fmean(verified_values)
        )
        if rolling_values:
            rolling_anchor = (
                0.70 * statistics.median(rolling_values)
                + 0.30 * statistics.fmean(rolling_values)
            )
            verified_share = 0.50 if len(verified_values) == 1 else 0.60
            anchor = verified_share * verified_anchor + (1.0 - verified_share) * rolling_anchor
            dispersion_values = sorted(verified_values + rolling_dispersion_values)
            source = "thin verified firm targets + rolling provider consensus"
            coverage_count = len(verified_values) + min(provider_opinion_count, 12) * 0.25
            reliability_multiplier = 0.70
        else:
            anchor = verified_anchor
            dispersion_values = list(verified_values)
            source = "thin verified current-year firm targets"
            coverage_count = len(verified_values)
            reliability_multiplier = 0.55
    elif rolling_values:
        values = list(rolling_values)
        dispersion_values = rolling_dispersion_values or list(rolling_values)
        source = "rolling provider consensus"
        source_count = provider_opinion_count
        coverage_count = min(provider_opinion_count, 12) * 0.50
        reliability_multiplier = 0.55

    if not values:
        return {
            "objective": independent or price,
            "anchor": None,
            "weight": 0.0,
            "source": source,
            "source_count": 0,
            "verified_count": 0,
            "provider_opinion_count": provider_opinion_count,
            "filtered_count": filtered_count,
            "dispersion": None,
            "reliability": 0.0,
        }

    median_target = statistics.median(values)
    mean_target = statistics.fmean(values)
    if anchor is None:
        anchor = 0.70 * median_target + 0.30 * mean_target

    def percentile(sorted_values, fraction):
        if len(sorted_values) == 1:
            return sorted_values[0]
        position = (len(sorted_values) - 1) * fraction
        lower_index = int(math.floor(position))
        upper_index = int(math.ceil(position))
        if lower_index == upper_index:
            return sorted_values[lower_index]
        weight = position - lower_index
        return sorted_values[lower_index] * (1 - weight) + sorted_values[upper_index] * weight

    q1 = percentile(dispersion_values, 0.25)
    q3 = percentile(dispersion_values, 0.75)
    dispersion_denominator = anchor if anchor and anchor > 0 else median_target
    dispersion = (q3 - q1) / dispersion_denominator if dispersion_denominator > 0 else 1.0
    coverage = min(coverage_count / 12.0, 1.0)
    agreement = max(0.25, min(1.0, 1.0 - dispersion))
    reliability = max(0.0, min(1.0, 0.35 + 0.40 * coverage + 0.25 * agreement))
    cap_by_archetype = {
        "MEMORY_STORAGE": 0.40,
        "WAFER_FOUNDRY": 0.38,
        "SEMI_EQUIPMENT": 0.34,
        "SEMI_PROCESS_CONTROL": 0.34,
        "SEMICONDUCTOR_TEST": 0.34,
        "TEST_INTERFACE": 0.32,
        "BURN_IN_TEST": 0.28,
        "PACKAGING_OSAT": 0.34,
        "PACKAGING_EQUIPMENT": 0.34,
        "AI_COMPUTE": 0.34,
        "NETWORKING_OPTICS": 0.34,
        "PHOTONICS_OPTICS": 0.32,
        "DATA_CENTER_POWER": 0.32,
        "POWER_GENERATION": 0.30,
        "REGULATED_UTILITY": 0.25,
    }
    weight_cap = cap_by_archetype.get(str(archetype or "").upper(), 0.30)
    reliability *= reliability_multiplier
    weight = weight_cap * reliability if independent is not None else 1.0
    objective = (
        independent * (1.0 - weight) + anchor * weight
        if independent is not None else anchor
    )
    return {
        "objective": objective,
        "anchor": anchor,
        "weight": weight,
        "source": source,
        "source_count": source_count,
        "verified_count": (
            source_count
            if source == "verified current-year firm targets"
            else len(verified_values)
        ),
        "provider_opinion_count": provider_opinion_count,
        "filtered_count": filtered_count,
        "dispersion": dispersion,
        "reliability": reliability,
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
    # Primary-business phrases outrank incidental end-market words. An OSAT may
    # mention NAND and testing repeatedly; that does not make it a memory maker or
    # an ATE vendor. Conversely, a foundry offering CoWoS remains a foundry.
    if any(term in haystack for term in ("pure-play foundry", "wafer foundry")):
        return "WAFER_FOUNDRY"
    if any(term in haystack for term in (
        "outsourced semiconductor assembly and test",
        "outsourced semiconductor assembly",
        "semiconductor packaging and test services",
    )):
        return "ADVANCED_PACKAGING"
    if any(term in haystack for term in ("automated test equipment", "semiconductor test equipment")):
        return "SEMICONDUCTOR_TEST"
    matches = []
    for theme, keywords in AI_THEME_KEYWORDS.items():
        count = sum(1 for keyword in keywords if keyword in haystack)
        if count:
            matches.append((count, AI_THEME_PRIORITY.get(theme, 0), theme))
    return max(matches)[2] if matches else "GENERAL_AI"


def infer_secondary_ai_exposures(ticker, company_text=""):
    """Return relevant AI-chain exposures without changing primary economics."""
    symbol = str(ticker or "").strip().upper()
    primary = infer_ai_theme(symbol, company_text)
    haystack = str(company_text or "").lower()
    exposures = set(SECONDARY_AI_EXPOSURE_OVERRIDES.get(symbol, ()))
    for theme, keywords in AI_THEME_KEYWORDS.items():
        if theme != primary and any(keyword in haystack for keyword in keywords):
            exposures.add(theme)
    return sorted(
        exposures,
        key=lambda theme: (-AI_THEME_PRIORITY.get(theme, 0), theme),
    )


def infer_valuation_archetype(
    ticker,
    company_text="",
    *,
    sector="",
    market_cap=None,
):
    """Map the shared evidence taxonomy to one valuation architecture.

    Both headline relevance and fundamental valuation call this boundary so a
    packaging, test, or power supplier cannot receive two conflicting labels in
    the same report.
    """
    theme = infer_ai_theme(ticker, company_text)
    if theme == "ADVANCED_PACKAGING":
        return infer_packaging_archetype(ticker, company_text)
    if theme == "SEMICONDUCTOR_TEST":
        return infer_test_archetype(ticker, company_text)
    archetype = THEME_TO_VALUATION_ARCHETYPE.get(theme, "GENERAL_AI")
    try:
        market_cap_value = float(market_cap)
    except (TypeError, ValueError):
        market_cap_value = 0.0
    if (
        archetype == "GENERAL_AI"
        and math.isfinite(market_cap_value)
        and market_cap_value >= 250_000_000_000
        and str(sector or "").strip().lower()
        in {"technology", "communication services", "consumer cyclical"}
    ):
        return "MEGA_CAP_PLATFORM"
    return archetype


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
    return len(ticker) <= 2 or ticker in {
        "AI", "IT", "ON", "ALL", "NOW", "SO", "A", "C", "F",
        "ARM", "FORM", "FIX",
    }


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


def collect_public_items(
    ticker,
    company_name,
    *,
    yahoo_items=None,
    session=None,
    timeout=10,
    theme=None,
):
    """Collect public metadata from Yahoo, Google, GDELT, Reddit, and optional X API."""
    session = session or requests.Session()
    rows = normalize_yahoo_news(yahoo_items or [])
    diagnostics = []
    year = _utc_now().year
    quoted_company = f'"{company_name}"' if company_name else ticker
    theme = theme or infer_ai_theme(ticker, company_name)
    theme_query = {
        "ADVANCED_PACKAGING": '(CoWoS OR SoIC OR "hybrid bonding" OR OSAT OR "advanced packaging")',
        "SEMICONDUCTOR_TEST": '("semiconductor test" OR "probe card" OR "wafer probe" OR "book-to-bill")',
        "SEMI_PROCESS_CONTROL": '(metrology OR inspection OR yield OR backlog)',
        "WAFER_FOUNDRY": '(foundry OR wafer OR node OR utilization OR CoWoS)',
        "MEMORY_STORAGE": '(HBM OR DRAM OR NAND OR memory OR pricing)',
        "PHOTONICS_OPTICS": '(photonics OR transceiver OR optical OR laser)',
        "DATA_CENTER_POWER": '("data center power" OR switchgear OR backlog OR "liquid cooling" OR microgrid)',
        "POWER_GENERATION": '("data center demand" OR capacity OR power OR generation)',
    }.get(theme, '(earnings OR guidance OR contract OR "data center" OR AI)')
    queries = [
        f'{quoted_company} {ticker} stock {theme_query}',
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
        r"(?:price\s+target|target\s+price)(?:\s+(?:on|for)\s+[A-Za-z0-9&.'() -]{1,70})?\s+"
        r"(?:raised|lifted|increased|boosted|adjusted|cut|lowered|reduced)?\s*"
        r"to\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s+from\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)",
        re.I,
    ),
    re.compile(
        r"(?:price\s+target|target\s+price)(?:\s+(?:on|for)\s+[A-Za-z0-9&.'() -]{1,70})?\s+"
        r"(?:is\s+)?(?:raised|lifted|increased|boosted|adjusted|cut|lowered|reduced)?\s*"
        r"(?:from\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s+)?(?:to|at|of)\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)",
        re.I,
    ),
    re.compile(
        r"\b(?:PT|price\s+target|target\s+price)\s+(?:raised|lowered|adjusted)?\s*to\s+"
        r"\$?([0-9][0-9,]*(?:\.[0-9]+)?)",
        re.I,
    ),
    re.compile(r"\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s+price\s+target", re.I),
    re.compile(r"\$([0-9][0-9,]*(?:\.[0-9]+)?)\s+target\b", re.I),
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
    action = r"(?:raises?|cuts?|lowers?|boosts?|lifts?|increases?|decreases?|adjusts?|initiates?|upgrades?|downgrades?|maintains?|reiterates?|announces?)"
    patterns = (
        re.compile(rf"^([A-Z][A-Za-z0-9&.' -]{{2,45}}?)\s+{action}\b", re.I),
        re.compile(rf"^([A-Z][A-Za-z0-9&.' -]{{2,45}}?)\s+analyst\s+[A-Z][A-Za-z.' -]{{2,45}}?\s+{action}\b", re.I),
        re.compile(r"\b(?:at|by)\s+([A-Z][A-Za-z0-9&.' -]{2,45}?)(?:\s*[-:;,]|$)", re.I),
        re.compile(r"\b(?:upgraded|downgraded|initiated)\s+at\s+([A-Z][A-Za-z0-9&.' -]{2,45}?)(?:\s+with|\s*[-:;,]|$)", re.I),
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


def _extract_analyst_name(text):
    patterns = (
        re.compile(
            r"\b(?:analyst|strategist)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\s+"
            r"(?:raises?|cuts?|lowers?|boosts?|lifts?|adjusts?|initiates?|upgrades?|downgrades?|maintains?|reiterates?)\b",
            re.I,
        ),
        re.compile(
            r"\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}),?\s+(?:an?\s+)?analyst\s+at\b",
            re.I,
        ),
    )
    for pattern in patterns:
        match = pattern.search(str(text or ""))
        if match:
            candidate = " ".join(match.group(1).split()).strip(" -:,.;")
            if 2 <= len(candidate.split()) <= 4:
                return candidate.title()
    return "Not disclosed"


def normalize_yahoo_analyst_history(frame, ticker, *, as_of=None, limit=250):
    """Normalize Yahoo's dated firm-level rating and target history.

    Recent Yahoo responses include currentPriceTarget/priorPriceTarget columns.
    Older versions exposed ratings only, so every field remains optional. This
    deterministic provider feed works even when Gemini grounding is unavailable.
    """
    if frame is None or getattr(frame, "empty", True):
        return []
    symbol = str(ticker or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9.^=-]{1,20}", symbol):
        return []
    try:
        records = frame.reset_index().head(max(1, min(int(limit), 500))).to_dict("records")
    except Exception:
        return []

    def first(record, *names, default=None):
        for name in names:
            value = record.get(name)
            if value is not None and str(value).strip() not in {"", "nan", "NaT"}:
                return value
        return default

    def number(value):
        try:
            parsed = float(value)
            return parsed if math.isfinite(parsed) and parsed > 0 else None
        except (TypeError, ValueError):
            return None

    rows = []
    for record in records:
        date_value = first(record, "GradeDate", "date", "Date", "index")
        if not current_calendar_year(date_value, as_of=as_of):
            continue
        firm = " ".join(str(first(record, "Firm", "firm", default="")).split())
        rating = " ".join(str(first(record, "ToGrade", "toGrade", default="N/A")).split()) or "N/A"
        target = number(first(record, "currentPriceTarget", "priceTarget", "targetPrice"))
        previous_target = number(first(record, "priorPriceTarget", "previousPriceTarget"))
        if not firm or (rating.upper() == "N/A" and target is None):
            continue
        parsed_date = _coerce_datetime(date_value)
        rows.append({
            "date": parsed_date.strftime("%Y-%m-%d") if parsed_date else str(date_value),
            "analyst": "Not disclosed",
            "firm": firm,
            "previous_rating": str(first(record, "FromGrade", "fromGrade", default="N/A")),
            "new_rating": rating,
            "price_target": target,
            "previous_price_target": previous_target,
            "source_url": f"https://finance.yahoo.com/quote/{symbol}/analysis/",
            "source_title": "Yahoo Finance dated analyst history",
            "record_origin": "Yahoo Finance provider feed",
        })
    return rows


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
        if relevance < 0.42:
            continue
        text = f"{item.get('title', '')} {item.get('summary', '')}".strip()
        lower = text.lower()
        target_language = bool(re.search(
            r"\b(?:price\s+target|target\s+price|pt)\b|\$[0-9][0-9,.]*\s+target\b",
            text,
            re.I,
        ))
        # This report is for the USD-listed instrument. Never reinterpret an
        # explicitly local-currency target (for example NT$ on 2330.TW) as USD.
        explicit_non_usd_currency = bool(re.search(
            r"(?:NT\$|\bTWD\b|\bNTD\b|€|\bEUR\b|¥|\bJPY\b|₩|\bKRW\b|£|\bGBP\b|C\$|\bCAD\b|A\$|\bAUD\b)",
            text,
            re.I,
        ))
        if not target_language or explicit_non_usd_currency or not any(term in lower for term in (
            "analyst", "raises", "raised", "cuts", "cut", "lowers", "boosts",
            "initiates", "upgrades", "downgrades", "maintains", "reiterates", "adjusts", " at ", " by ",
        )):
            continue
        previous = None
        target = None
        for pattern in _TARGET_PATTERNS:
            match = pattern.search(text)
            if not match:
                continue
            if len(match.groups()) == 2:
                # Most patterns capture old/new; the explicit "to X from Y"
                # pattern captures new/old.
                if re.search(r"\bto\s+\$?[0-9][0-9,.]*\s+from\b", match.group(0), re.I):
                    target = float(match.group(1).replace(",", ""))
                    previous = float(match.group(2).replace(",", "")) if match.group(2) else None
                else:
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
            "analyst": _extract_analyst_name(text),
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
        ticker,
        company_name,
        yahoo_items=yahoo_items,
        session=session,
        theme=theme,
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
