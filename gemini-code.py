# Install missing dependencies only. A failed optional Gemini installation must
# not prevent the valuation engine from running; analyst-source enrichment will
# simply be skipped.
import importlib.util
import os
import subprocess
import sys

def _install_if_missing(module_name, package_name):
    if importlib.util.find_spec(module_name) is not None:
        return
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", package_name, "-q"])
    except Exception as exc:
        print(f"Dependency installation note for {package_name}: {exc}")

_install_if_missing("yfinance", "yfinance>=0.2.65")
_install_if_missing("google.genai", "google-genai")
_install_if_missing("pandas", "pandas>=2.2.0")
_install_if_missing("requests", "requests>=2.31.0")

try:
    from google import genai
except Exception:
    genai = None

import json
import math
import requests
import yfinance as yf
import pandas as pd
from datetime import datetime
from html import escape
from urllib.parse import urlparse
try:
    from google.colab import files, userdata
except ImportError:
    class _LocalFiles:
        @staticmethod
        def download(path):
            print(f"Generated file: {path}")
    class _LocalUserdata:
        @staticmethod
        def get(key):
            return os.environ.get(key, "")
    files = _LocalFiles()
    userdata = _LocalUserdata()


# A single batch shares the same Gemini Search quota. Once Google reports a
# quota/rate-limit error, skip the remaining grounded-enrichment calls in that
# process and continue with Yahoo/fallback analyst data. Core valuation and HTML
# generation remain independent of this optional enrichment.
_GEMINI_GROUNDING_DISABLED = False
_GEMINI_GROUNDING_DISABLE_REASON = ""



def generate_report(TICKER_SYMBOL, output_dir=None):
    global _GEMINI_GROUNDING_DISABLED, _GEMINI_GROUNDING_DISABLE_REASON
    # ==========================================
    # 1. API KEYS & TICKER SETUP
    # ==========================================
    TICKER_SYMBOL = str(TICKER_SYMBOL).strip().upper()
    CURRENT_DATE = datetime.now().strftime("%d %B %Y")

    # FMP analyst endpoints are paid/legacy for most new accounts. Keep disabled unless
    # you separately subscribe to the required FMP datasets.
    USE_FMP = True

    FMP_API_KEY = ""
    if USE_FMP:
        try:
            FMP_API_KEY = userdata.get('FMP_API_KEY') or ""
        except Exception:
            FMP_API_KEY = ""

    try:
        GEMINI_API_KEY = userdata.get('GEMINI_API_KEY') or ""
    except Exception:
        GEMINI_API_KEY = ""

    print(
        f"[{CURRENT_DATE}] Fetching market data and individually sourced "
        f"analyst actions for {TICKER_SYMBOL}..."
    )

    # ==========================================
    # 2. OPTIONAL DIRECT-PROVIDER DATA (FMP)
    # ==========================================
    fmp_profile = {}
    fmp_price_target = {}
    fmp_grades = []


    def get_json(url, params=None, timeout=20):
        """Return parsed JSON or None, while printing useful API diagnostics."""
        response = requests.get(
            url,
            params=params,
            timeout=timeout,
            headers={"User-Agent": "Mozilla/5.0 analyst-report/1.0"},
        )
        if response.status_code != 200:
            print(f"HTTP {response.status_code}: {response.url}")
            print(response.text[:500])
            return None
        try:
            return response.json()
        except ValueError:
            print(f"Non-JSON response from {response.url}: {response.text[:500]}")
            return None


    if USE_FMP and FMP_API_KEY:
        try:
            # Current non-legacy FMP profile endpoint. Analyst endpoints are deliberately
            # not called here because they require a separate paid entitlement.
            profile_payload = get_json(
                "https://financialmodelingprep.com/stable/profile",
                {"symbol": TICKER_SYMBOL, "apikey": FMP_API_KEY},
            )
            if isinstance(profile_payload, list) and profile_payload:
                fmp_profile = profile_payload[0]
            print("FMP company profile loaded. Individual analysts will still come from Gemini Search.")
        except Exception as exc:
            print(f"Optional FMP profile note: {exc}")
    else:
        print("FMP disabled; using Yahoo for market data and Gemini Search for individual analysts.")

    # ==========================================
    # 3. TECHNICAL CALCULATIONS (YFINANCE OHLC)
    # ==========================================
    stock = yf.Ticker(TICKER_SYMBOL)
    info = stock.info
    hist_1y = stock.history(period="2y", auto_adjust=False, repair=False)

    if hist_1y.empty:
        raise ValueError(f"Failed to fetch market price data for {TICKER_SYMBOL}.")

    # Market-data unit policy -------------------------------------------------------
    # Do NOT automatically rescale market prices, price history, analyst targets,
    # market capitalization, book value, or EPS estimates. A previous version tried
    # to infer a power-of-ten mismatch by comparing forward EPS with CURRENT revenue
    # per share. That test is invalid for fast-growing cyclical businesses because
    # forward EPS belongs to a future forecast period and can legitimately differ
    # sharply from current trailing revenue. It caused valid MU data around $920 and
    # analyst targets around $1,500 to be divided by 10.
    #
    # Provider values are now preserved exactly. Any suspect field should be rejected
    # or flagged later by a period-matched sanity check; it must never trigger a
    # report-wide silent scale conversion.
    raw_current_price = (
        fmp_profile.get("price")
        or info.get("currentPrice")
        or info.get("regularMarketPrice")
        or hist_1y["Close"].dropna().iloc[-1]
    )
    current_price = float(raw_current_price)
    quote_scale_factor = 1.0
    quote_scale_reason = (
        "Automatic quote scaling disabled; prices, history, analyst targets, market "
        "capitalization and per-share estimates are used exactly as returned"
    )
    print(f"Market-data unit check: {quote_scale_reason}.")
    if current_price <= 0:
        raise ValueError("Current market price must be positive.")

    # Cross-check quote against the latest unadjusted historical close. Warn only;
    # never change either series automatically. The last history row can represent
    # the previous completed session when the quote is intraday, so a tolerance is
    # intentional.
    latest_raw_history_close = float(hist_1y["Close"].dropna().iloc[-1])
    price_history_ratio = (
        current_price / latest_raw_history_close
        if latest_raw_history_close > 0 else None
    )
    if price_history_ratio is not None and not (0.75 <= price_history_ratio <= 1.25):
        print(
            "WARNING: Current quote and latest historical close differ materially "
            f"({current_price:,.2f} vs {latest_raw_history_close:,.2f}). "
            "No automatic scaling was applied; inspect the provider data manually."
        )


    def early_positive_float(value):
        try:
            number = float(value)
            return number if math.isfinite(number) and number > 0 else None
        except (TypeError, ValueError):
            return None


    def normalize_per_share_quote(value):
        """Compatibility helper: validate a per-share value without rescaling it."""
        return early_positive_float(value)

    prev_high = hist_1y['High'].iloc[-2]
    prev_low = hist_1y['Low'].iloc[-2]
    prev_close = hist_1y['Close'].iloc[-2]

    # Floor Pivots
    pp = (prev_high + prev_low + prev_close) / 3
    r1 = (2 * pp) - prev_low
    s1 = (2 * pp) - prev_high

    # Moving Averages
    sma_20 = hist_1y['Close'].rolling(window=20).mean().iloc[-1]
    sma_50 = hist_1y['Close'].rolling(window=50).mean().iloc[-1]
    sma_200 = hist_1y['Close'].rolling(window=200).mean().iloc[-1]

    ema_9 = hist_1y['Close'].ewm(span=9, adjust=False).mean().iloc[-1]
    ema_20 = hist_1y['Close'].ewm(span=20, adjust=False).mean().iloc[-1]
    ema_50 = hist_1y['Close'].ewm(span=50, adjust=False).mean().iloc[-1]
    ema_200 = hist_1y['Close'].ewm(span=200, adjust=False).mean().iloc[-1]

    delta = hist_1y['Close'].diff()
    gain = (delta.where(delta > 0, 0)).fillna(0)
    loss = (-delta.where(delta < 0, 0)).fillna(0)
    avg_gain = gain.ewm(com=13, adjust=False).mean()
    avg_loss = loss.ewm(com=13, adjust=False).mean()
    rsi_14 = (100 - (100 / (1 + (avg_gain / avg_loss)))).iloc[-1]

    # Institutional risk and momentum diagnostics.
    price_series = hist_1y['Close'].dropna()
    high_series = hist_1y['High'].dropna()
    low_series = hist_1y['Low'].dropna()
    returns = price_series.pct_change().dropna()

    true_range = pd.concat([
        high_series - low_series,
        (high_series - price_series.shift(1)).abs(),
        (low_series - price_series.shift(1)).abs(),
    ], axis=1).max(axis=1)
    atr_14 = true_range.rolling(14).mean().iloc[-1]
    atr_pct = (atr_14 / current_price) if current_price else None
    volatility_30d = returns.tail(30).std() * math.sqrt(252) if len(returns) >= 20 else None
    volatility_90d = returns.tail(90).std() * math.sqrt(252) if len(returns) >= 60 else None

    last_252 = price_series.tail(252)
    high_52w = last_252.max() if not last_252.empty else None
    low_52w = last_252.min() if not last_252.empty else None
    rolling_peak = last_252.cummax() if not last_252.empty else pd.Series(dtype=float)
    max_drawdown_1y = ((last_252 / rolling_peak) - 1).min() if not rolling_peak.empty else None


    def period_return(series, sessions):
        if len(series) <= sessions:
            return None
        start = float(series.iloc[-sessions - 1])
        end = float(series.iloc[-1])
        return (end / start) - 1 if start else None


    momentum_3m = period_return(price_series, 63)
    momentum_6m = period_return(price_series, 126)
    momentum_12m = period_return(price_series, 252)
    trend_regime = (
        "Bullish" if current_price > sma_50 > sma_200
        else "Bearish" if current_price < sma_50 < sma_200
        else "Mixed / Transitional"
    )

    # --- WALL STREET CONSENSUS ---
    def positive_float(value):
        try:
            number = float(value)
            return number if math.isfinite(number) and number > 0 else None
        except (TypeError, ValueError):
            return None

    # Prefer yfinance's dedicated analyst-price-target endpoint. It normally returns
    # current, low, high, mean and median and is more reliable than stock.info keys.
    yahoo_price_targets = {}
    try:
        yahoo_price_targets = stock.get_analyst_price_targets() or {}
    except Exception as exc:
        print(f"Yahoo analyst-price-target note: {exc}")

    raw_target_mean = (
        normalize_per_share_quote(yahoo_price_targets.get("mean"))
        or normalize_per_share_quote(fmp_price_target.get("targetMean"))
        or normalize_per_share_quote(info.get("targetMeanPrice"))
    )
    target_median = (
        normalize_per_share_quote(yahoo_price_targets.get("median"))
        or normalize_per_share_quote(fmp_price_target.get("targetMedian"))
        or normalize_per_share_quote(info.get("targetMedianPrice"))
    )
    target_high = (
        normalize_per_share_quote(yahoo_price_targets.get("high"))
        or normalize_per_share_quote(fmp_price_target.get("targetHigh"))
        or normalize_per_share_quote(info.get("targetHighPrice"))
    )
    target_low = (
        normalize_per_share_quote(yahoo_price_targets.get("low"))
        or normalize_per_share_quote(fmp_price_target.get("targetLow"))
        or normalize_per_share_quote(info.get("targetLowPrice"))
    )
    consensus_current_price = normalize_per_share_quote(yahoo_price_targets.get("current")) or current_price

    # Analyst-count estimate: Yahoo's direct opinion count first; recommendation
    # distribution second. Keep it separate from the number of target rows collected.
    consensus_analyst_count = info.get("numberOfAnalystOpinions")
    try:
        consensus_analyst_count = int(consensus_analyst_count)
    except (TypeError, ValueError):
        consensus_analyst_count = None

    try:
        rec_frame = stock.get_recommendations()
        if (consensus_analyst_count is None or consensus_analyst_count <= 0) and rec_frame is not None and not rec_frame.empty:
            latest_rec = rec_frame.iloc[0]
            consensus_analyst_count = int(sum(
                positive_float(latest_rec.get(column)) or 0
                for column in ["strongBuy", "buy", "hold", "sell", "strongSell"]
            ))
    except Exception as exc:
        print(f"Yahoo recommendation-count note: {exc}")

    target_is_model_fallback = (
        raw_target_mean is None
        or not (current_price * 0.4 <= raw_target_mean <= current_price * 3.5)
    )
    target_mean = current_price * 1.15 if target_is_model_fallback else raw_target_mean

    # These ranges are used only by the valuation engine when Yahoo has no usable
    # values. The report labels them as model fallbacks rather than analyst data.
    if target_high is None:
        target_high = target_mean * 1.25
    if target_low is None:
        target_low = target_mean * 0.75
    if target_median is None and not target_is_model_fallback:
        target_median = target_mean

    target_metric_label = (
        "Model Fallback Target (Not Analyst Consensus)"
        if target_is_model_fallback
        else "Published 1-Year Analyst Consensus Target"
    )
    target_metric_reason = (
        "No usable published consensus target was returned, so this is a transparent model placeholder."
        if target_is_model_fallback
        else "Mean 12-month target returned by Yahoo's dedicated analyst-price-target feed."
    )

    # --- FUNDAMENTAL METRICS ---
    raw_market_cap = fmp_profile.get("mktCap") or info.get("marketCap", 10000000000)
    market_cap = raw_market_cap  # Never rescale provider market capitalization.
    total_debt = info.get("totalDebt", 0)
    total_cash = info.get("totalCash", 0)

    if current_price and current_price > 0:
        shares_out = market_cap / current_price
    else:
        shares_out = info.get("sharesOutstanding", 100000000)

    company_name = fmp_profile.get("companyName") or info.get('longName', TICKER_SYMBOL)
    industry = fmp_profile.get("industry") or info.get('industry', 'N/A')
    sector = fmp_profile.get("sector") or info.get('sector', 'N/A')

    trailing_pe = info.get("trailingPE") or 15.0
    fwd_pe = info.get("forwardPE") or 14.0
    peg_ratio = info.get("pegRatio") or 1.0
    ps_ratio = info.get("priceToSalesTrailing12Months") or 2.0
    ev_ebitda = info.get("enterpriseToEbitda") or 10.0
    debt_to_equity = info.get("debtToEquity") or 0.0
    op_margin = info.get("operatingMargin") or info.get("operatingMargins") or 0.15

    # =========================================================
    # 4. GEMINI CLIENT (ANALYST-SOURCE ENRICHMENT ONLY)
    # =========================================================
    # Gemini is used only to find and structure public analyst-action sources.
    # It does not choose the valuation method or supply any fair-value assumption.
    client = None
    if _GEMINI_GROUNDING_DISABLED:
        print(
            "Gemini Search enrichment skipped for this ticker because the current "
            f"batch already hit its grounding quota: {_GEMINI_GROUNDING_DISABLE_REASON}"
        )
    else:
        try:
            if not GEMINI_API_KEY:
                raise ValueError("GEMINI_API_KEY is not configured in Colab Secrets")
            if genai is None:
                raise ImportError("google-genai is unavailable")
            client = genai.Client(api_key=GEMINI_API_KEY)
        except Exception as exc:
            print(f"Gemini client note: {exc}")

    # =========================================================
    # 5. INSTITUTIONAL MULTI-STAGE VALUATION & RISK ENGINE
    # =========================================================
    # This is an institutional-style public-data framework, not a reproduction of
    # any investment bank's proprietary research model. It keeps intrinsic value,
    # sell-side consensus, and market-implied expectations clearly separated.


    def clamp(value, low, high):
        try:
            return max(low, min(high, float(value)))
        except (TypeError, ValueError):
            return low


    def safe_ratio(numerator, denominator, default=None):
        try:
            numerator = float(numerator)
            denominator = float(denominator)
            if denominator == 0 or not math.isfinite(numerator) or not math.isfinite(denominator):
                return default
            return numerator / denominator
        except (TypeError, ValueError):
            return default


    def fmt_money(value):
        return f"${value:,.2f}" if isinstance(value, (int, float)) and math.isfinite(value) else "N/A"


    def fmt_pct(value, decimals=1):
        return f"{value * 100:.{decimals}f}%" if isinstance(value, (int, float)) and math.isfinite(value) else "N/A"


    def fmt_multiple(value, decimals=1):
        return f"{value:.{decimals}f}x" if isinstance(value, (int, float)) and math.isfinite(value) else "N/A"


    def safe_statement(fetcher, freq="yearly"):
        try:
            frame = fetcher(freq=freq)
            return frame if isinstance(frame, pd.DataFrame) else pd.DataFrame()
        except Exception as exc:
            print(f"Statement fetch note ({getattr(fetcher, '__name__', 'statement')} / {freq}): {exc}")
            return pd.DataFrame()


    def statement_series(frame, aliases):
        if frame is None or frame.empty:
            return pd.Series(dtype="float64")
        normalized = {str(index).lower().replace(" ", ""): index for index in frame.index}
        for alias in aliases:
            key = str(alias).lower().replace(" ", "")
            if key in normalized:
                series = pd.to_numeric(frame.loc[normalized[key]], errors="coerce").dropna()
                series.index = pd.to_datetime(series.index, errors="coerce")
                return series[~series.index.isna()]
        return pd.Series(dtype="float64")


    def latest_statement_value(frame, aliases, default=None):
        series = statement_series(frame, aliases)
        if series.empty:
            return default
        return float(series.sort_index().iloc[-1])


    def ttm_sum(frame, aliases, default=None):
        series = statement_series(frame, aliases)
        if series.empty:
            return default
        values = series.sort_index().tail(4)
        return float(values.sum()) if not values.empty else default


    def finite_median(values, default=None):
        series = pd.Series(list(values), dtype="float64").replace([math.inf, -math.inf], pd.NA).dropna()
        return float(series.median()) if not series.empty else default


    def finite_mean(values, default=None):
        series = pd.Series(list(values), dtype="float64").replace([math.inf, -math.inf], pd.NA).dropna()
        return float(series.mean()) if not series.empty else default


    def aligned_ratio(numerator_series, denominator_series, low=None, high=None):
        frame = pd.concat([numerator_series.rename("n"), denominator_series.rename("d")], axis=1).dropna()
        if frame.empty:
            return pd.Series(dtype="float64")
        ratios = frame["n"] / frame["d"].replace(0, pd.NA)
        ratios = ratios.replace([math.inf, -math.inf], pd.NA).dropna()
        if low is not None:
            ratios = ratios[ratios >= low]
        if high is not None:
            ratios = ratios[ratios <= high]
        return ratios


    def frame_cell(frame, row, column, default=None):
        try:
            value = frame.loc[row, column]
            value = float(value)
            return value if math.isfinite(value) else default
        except Exception:
            return default


    annual_income = safe_statement(stock.get_income_stmt, "yearly")
    quarterly_income = safe_statement(stock.get_income_stmt, "quarterly")
    annual_balance = safe_statement(stock.get_balance_sheet, "yearly")
    quarterly_balance = safe_statement(stock.get_balance_sheet, "quarterly")
    annual_cash = safe_statement(stock.get_cash_flow, "yearly")
    quarterly_cash = safe_statement(stock.get_cash_flow, "quarterly")

    # Core historical series.
    revenue_annual = statement_series(annual_income, ["TotalRevenue", "OperatingRevenue"])
    ebit_annual = statement_series(annual_income, ["EBIT", "OperatingIncome"])
    ebitda_annual = statement_series(annual_income, ["EBITDA", "NormalizedEBITDA"])
    pretax_annual = statement_series(annual_income, ["PretaxIncome", "IncomeBeforeTax"])
    tax_annual = statement_series(annual_income, ["TaxProvision", "IncomeTaxExpense"])
    interest_annual = statement_series(annual_income, ["InterestExpense", "InterestExpenseNonOperating"])
    net_income_annual = statement_series(annual_income, ["NetIncome", "NetIncomeCommonStockholders"])

    cfo_annual = statement_series(annual_cash, ["OperatingCashFlow", "TotalCashFromOperatingActivities"])
    capex_annual_raw = statement_series(annual_cash, ["CapitalExpenditure", "CapitalExpenditures"])
    capex_annual = capex_annual_raw.abs()
    da_annual = statement_series(annual_cash, ["DepreciationAndAmortization", "Depreciation"])
    sbc_annual = statement_series(annual_cash, ["StockBasedCompensation"])

    cash_annual = statement_series(annual_balance, [
        "CashCashEquivalentsAndShortTermInvestments", "CashAndCashEquivalents", "Cash"
    ])
    debt_annual = statement_series(annual_balance, ["TotalDebt", "LongTermDebtAndCapitalLeaseObligation"])
    equity_annual = statement_series(annual_balance, ["StockholdersEquity", "CommonStockEquity", "TotalEquityGrossMinorityInterest"])
    invested_capital_annual = statement_series(annual_balance, ["InvestedCapital"])

    # TTM figures use quarterly statements first, then Yahoo summary fields.
    revenue_ttm = ttm_sum(quarterly_income, ["TotalRevenue", "OperatingRevenue"], positive_float(info.get("totalRevenue")))
    summary_operating_margin = info.get("operatingMargins") or info.get("operatingMargin")
    summary_ebit = (
        float(revenue_ttm) * float(summary_operating_margin)
        if revenue_ttm and summary_operating_margin is not None
        else positive_float(info.get("ebitda"))
    )
    ebit_ttm = ttm_sum(quarterly_income, ["EBIT", "OperatingIncome"], summary_ebit)
    ebitda_ttm = ttm_sum(quarterly_income, ["EBITDA", "NormalizedEBITDA"], positive_float(info.get("ebitda")))
    pretax_ttm = ttm_sum(quarterly_income, ["PretaxIncome", "IncomeBeforeTax"], None)
    tax_ttm = ttm_sum(quarterly_income, ["TaxProvision", "IncomeTaxExpense"], None)
    interest_ttm = abs(ttm_sum(quarterly_income, ["InterestExpense", "InterestExpenseNonOperating"], 0) or 0)
    net_income_ttm = ttm_sum(quarterly_income, ["NetIncome", "NetIncomeCommonStockholders"], info.get("netIncomeToCommon"))
    cfo_ttm = ttm_sum(quarterly_cash, ["OperatingCashFlow", "TotalCashFromOperatingActivities"], info.get("operatingCashflow"))
    capex_ttm = abs(ttm_sum(quarterly_cash, ["CapitalExpenditure", "CapitalExpenditures"], 0) or 0)
    da_ttm = ttm_sum(quarterly_cash, ["DepreciationAndAmortization", "Depreciation"], 0) or 0
    sbc_ttm = ttm_sum(quarterly_cash, ["StockBasedCompensation"], 0) or 0

    latest_cash = latest_statement_value(
        quarterly_balance,
        ["CashCashEquivalentsAndShortTermInvestments", "CashAndCashEquivalents", "Cash"],
        total_cash,
    ) or 0
    latest_debt = latest_statement_value(
        quarterly_balance,
        ["TotalDebt", "LongTermDebtAndCapitalLeaseObligation"],
        total_debt,
    ) or 0
    latest_equity = latest_statement_value(
        quarterly_balance,
        ["StockholdersEquity", "CommonStockEquity", "TotalEquityGrossMinorityInterest"],
        (normalize_per_share_quote(info.get("bookValue")) or 0) * shares_out if info.get("bookValue") else 0,
    ) or 0
    latest_invested_capital = latest_statement_value(quarterly_balance, ["InvestedCapital"], None)
    if not latest_invested_capital or latest_invested_capital <= 0:
        latest_invested_capital = max(latest_debt + latest_equity - latest_cash, 1.0)

    # Normalize tax rate across reported years; avoid distorted one-off tax years.
    effective_tax_series = aligned_ratio(tax_annual, pretax_annual, low=0.0, high=0.50)
    effective_tax_rate = finite_median(effective_tax_series.values, None)
    if effective_tax_rate is None and pretax_ttm and pretax_ttm > 0 and tax_ttm is not None:
        effective_tax_rate = safe_ratio(tax_ttm, pretax_ttm, None)
    effective_tax_rate = clamp(effective_tax_rate if effective_tax_rate is not None else 0.21, 0.15, 0.30)

    # Historical margins and normalized mid-cycle profitability.
    ebit_margin_series = aligned_ratio(ebit_annual, revenue_annual, low=-0.50, high=0.70)
    fcf_components = pd.concat([cfo_annual.rename("cfo"), capex_annual.rename("capex")], axis=1).dropna()
    fcf_annual = (fcf_components["cfo"] - fcf_components["capex"]) if not fcf_components.empty else pd.Series(dtype="float64")
    fcf_margin_series = aligned_ratio(fcf_annual, revenue_annual, low=-0.75, high=0.75)
    current_ebit_margin = safe_ratio(ebit_ttm, revenue_ttm, info.get("operatingMargins") or 0.0)
    normalized_ebit_margin = finite_median(ebit_margin_series.values, current_ebit_margin)
    normalized_ebit_margin = clamp(normalized_ebit_margin if normalized_ebit_margin is not None else 0.10, -0.15, 0.55)

    # Build historical invested capital when the direct line is unavailable.
    if invested_capital_annual.empty:
        aligned_bs = pd.concat([
            debt_annual.rename("debt"), equity_annual.rename("equity"), cash_annual.rename("cash")
        ], axis=1).dropna(how="all")
        if not aligned_bs.empty:
            invested_capital_annual = (
                aligned_bs.get("debt", 0).fillna(0)
                + aligned_bs.get("equity", 0).fillna(0)
                - aligned_bs.get("cash", 0).fillna(0)
            )

    nopat_annual = ebit_annual * (1 - effective_tax_rate)
    roic_series = aligned_ratio(nopat_annual, invested_capital_annual, low=-1.0, high=1.0)
    normalized_roic = finite_median(roic_series.values, None)
    if normalized_roic is None:
        normalized_roic = safe_ratio(
            (ebit_ttm or 0) * (1 - effective_tax_rate),
            latest_invested_capital,
            0.10,
        )
    normalized_roic = clamp(normalized_roic if normalized_roic is not None else 0.10, -0.50, 0.50)
    model_roic = clamp(normalized_roic if normalized_roic > 0 else 0.08, 0.04, 0.40)

    # Cash-flow and balance-sheet diagnostics.
    fcf_ttm = (cfo_ttm - capex_ttm) if cfo_ttm is not None else info.get("freeCashflow")
    fcff_ttm = (
        cfo_ttm + interest_ttm * (1 - effective_tax_rate) - capex_ttm
        if cfo_ttm is not None else info.get("freeCashflow")
    )
    fcf_margin = safe_ratio(fcf_ttm, revenue_ttm, None)
    cash_conversion = safe_ratio(cfo_ttm, net_income_ttm, None) if net_income_ttm and net_income_ttm > 0 else None
    capex_intensity = safe_ratio(capex_ttm, revenue_ttm, None)
    sbc_intensity = safe_ratio(sbc_ttm, revenue_ttm, None)
    interest_coverage = safe_ratio(ebit_ttm, interest_ttm, None) if interest_ttm > 0 else 99.0
    net_debt = latest_debt - latest_cash
    net_debt_to_ebitda = safe_ratio(net_debt, ebitda_ttm, None) if ebitda_ttm and ebitda_ttm > 0 else None

    # Revenue CAGR and margin stability use all available annual periods (usually 4-5).
    revenue_sorted = revenue_annual.sort_index().dropna()
    if len(revenue_sorted) >= 2 and revenue_sorted.iloc[0] > 0:
        revenue_cagr = (revenue_sorted.iloc[-1] / revenue_sorted.iloc[0]) ** (1 / (len(revenue_sorted) - 1)) - 1
    else:
        revenue_cagr = info.get("revenueGrowth")
    margin_volatility = float(ebit_margin_series.std()) if len(ebit_margin_series) >= 2 else None

    # Forward revenue and earnings expectations.
    try:
        revenue_estimates = stock.get_revenue_estimate()
    except Exception:
        revenue_estimates = pd.DataFrame()
    try:
        earnings_estimates = stock.get_earnings_estimate()
    except Exception:
        earnings_estimates = pd.DataFrame()
    try:
        growth_estimates = stock.get_growth_estimates()
    except Exception:
        growth_estimates = pd.DataFrame()
    try:
        eps_revisions = stock.get_eps_revisions()
    except Exception:
        eps_revisions = pd.DataFrame()

    next_year_revenue_growth = frame_cell(revenue_estimates, "+1y", "growth", None)
    long_term_growth_estimate = frame_cell(growth_estimates, "+5y", "stock", None)
    if next_year_revenue_growth is None:
        next_year_revenue_growth = revenue_cagr if revenue_cagr is not None else info.get("revenueGrowth")
    if long_term_growth_estimate is None:
        long_term_growth_estimate = info.get("earningsGrowth") or revenue_cagr
    next_year_revenue_growth = clamp(next_year_revenue_growth if next_year_revenue_growth is not None else 0.06, -0.15, 0.35)
    long_term_growth_estimate = clamp(long_term_growth_estimate if long_term_growth_estimate is not None else 0.06, 0.01, 0.20)

    revision_up_30 = frame_cell(eps_revisions, "+1y", "upLast30days", 0) or 0
    revision_down_30 = frame_cell(eps_revisions, "+1y", "downLast30days", 0) or 0
    revision_breadth = safe_ratio(revision_up_30 - revision_down_30, revision_up_30 + revision_down_30, None)

    # Dynamic cost of capital: current 10-year Treasury proxy, current implied ERP
    # default, adjusted beta, and a synthetic credit spread from interest coverage.
    try:
        treasury_hist = yf.Ticker("^TNX").history(period="1mo", auto_adjust=False)
        risk_free_rate = float(treasury_hist["Close"].dropna().iloc[-1]) / 100
    except Exception as exc:
        print(f"Risk-free-rate fallback note: {exc}")
        risk_free_rate = 0.0445
    risk_free_rate = clamp(risk_free_rate, 0.02, 0.08)

    US_IMPLIED_ERP = 0.0418  # Damodaran implied ERP, 1 July 2026 snapshot.
    raw_beta = positive_float(info.get("beta")) or 1.0
    adjusted_beta = clamp(0.67 * raw_beta + 0.33, 0.50, 2.50)
    cost_of_equity = risk_free_rate + adjusted_beta * US_IMPLIED_ERP

    # January 2026 synthetic-rating spreads for large non-financial firms.
    SYNTHETIC_RATING_TABLE = [
        (0.20, "D", 0.1900), (0.65, "C", 0.1600), (0.80, "CC", 0.1261),
        (1.25, "CCC", 0.0885), (1.50, "B-", 0.0509), (1.75, "B", 0.0321),
        (2.00, "B+", 0.0275), (2.25, "BB", 0.0184), (2.50, "BB+", 0.0138),
        (3.00, "BBB", 0.0111), (4.25, "A-", 0.0089), (5.50, "A", 0.0078),
        (6.50, "A+", 0.0070), (8.50, "AA", 0.0055), (float("inf"), "AAA", 0.0040),
    ]


    def synthetic_rating(coverage):
        coverage = float(coverage) if coverage is not None and math.isfinite(float(coverage)) else 0.0
        for upper, rating, spread in SYNTHETIC_RATING_TABLE:
            if coverage < upper:
                return rating, spread
        return "AAA", 0.0040


    credit_rating, default_spread = synthetic_rating(interest_coverage)
    pre_tax_cost_of_debt = risk_free_rate + default_spread
    after_tax_cost_of_debt = pre_tax_cost_of_debt * (1 - effective_tax_rate)
    capital_total = max(market_cap + latest_debt, 1.0)
    equity_weight = market_cap / capital_total
    debt_weight = latest_debt / capital_total
    wacc = equity_weight * cost_of_equity + debt_weight * after_tax_cost_of_debt
    wacc = clamp(wacc, 0.055, 0.18)

    # Stable growth must remain below the discount rate.
    terminal_growth = clamp(risk_free_rate - 0.015, 0.015, 0.030)
    stable_roic = clamp(model_roic, wacc + 0.005, wacc + 0.050)


    # -----------------------------------------------------------------------------
    # AI-value-chain independent valuation architecture
    # -----------------------------------------------------------------------------
    # Non-negotiable invariant:
    #   Analyst PRICE TARGETS are never used in the valuation calculation.
    # Near-term analyst OPERATING estimates (revenue/EPS) may be used for FY1/FY2
    # after sanity checks and shrinkage toward company history and peer fundamentals.
    # This mirrors the information set used by sell-side analysts without copying
    # their valuation conclusion.
    USE_ANALYST_PRICE_TARGETS_IN_VALUATION = False
    USE_ANALYST_OPERATING_ESTIMATES = True
    MANUAL_ARCHETYPE = None  # Example: "MEMORY_STORAGE"; leave None for auto-classification.

    # Explicit AI value-chain taxonomy. Unknown tickers are classified from business
    # description, industry, profitability and growth. Users can add overrides safely.
    TICKER_ARCHETYPE_OVERRIDES = {
        # AI compute / semiconductor design
        "NVDA": "AI_COMPUTE", "AMD": "AI_COMPUTE", "AVGO": "AI_COMPUTE",
        "MRVL": "AI_COMPUTE", "CRDO": "AI_COMPUTE", "ARM": "AI_COMPUTE",
        # Memory / storage cycle
        "MU": "MEMORY_STORAGE", "WDC": "MEMORY_STORAGE", "STX": "MEMORY_STORAGE",
        "SNDK": "MEMORY_STORAGE", "SIMO": "MEMORY_STORAGE", "RMBS": "MEMORY_STORAGE",
        # Semiconductor equipment / process control
        "ASML": "SEMI_EQUIPMENT", "AMAT": "SEMI_EQUIPMENT", "LRCX": "SEMI_EQUIPMENT",
        "KLAC": "SEMI_EQUIPMENT", "ONTO": "SEMI_EQUIPMENT", "CAMT": "SEMI_EQUIPMENT",
        "ACMR": "SEMI_EQUIPMENT", "UCTT": "SEMI_EQUIPMENT", "MKSI": "SEMI_EQUIPMENT",
        # Networking, optics and interconnect
        "ANET": "NETWORKING_OPTICS", "COHR": "NETWORKING_OPTICS", "LITE": "NETWORKING_OPTICS",
        "AAOI": "NETWORKING_OPTICS", "FN": "NETWORKING_OPTICS",
        # Data-center electrical, cooling and distributed power
        "VRT": "DATA_CENTER_POWER", "ETN": "DATA_CENTER_POWER", "GEV": "DATA_CENTER_POWER",
        "PWR": "DATA_CENTER_POWER", "CARR": "DATA_CENTER_POWER", "BE": "DATA_CENTER_POWER",
        # AI cloud / GPU infrastructure
        "CRWV": "AI_CLOUD_INFRA", "NBIS": "AI_CLOUD_INFRA", "IREN": "AI_CLOUD_INFRA",
        # AI software / data platforms
        "PLTR": "AI_SOFTWARE", "SNOW": "AI_SOFTWARE", "NOW": "AI_SOFTWARE",
        "CRM": "AI_SOFTWARE", "DDOG": "AI_SOFTWARE",
        # Hyperscalers and mega-cap platforms
        "MSFT": "MEGA_CAP_PLATFORM", "GOOGL": "MEGA_CAP_PLATFORM", "GOOG": "MEGA_CAP_PLATFORM",
        "AMZN": "MEGA_CAP_PLATFORM", "META": "MEGA_CAP_PLATFORM", "AAPL": "MEGA_CAP_PLATFORM",
        # Power generators benefiting from data-center load growth
        "CEG": "POWER_GENERATION", "VST": "POWER_GENERATION", "NRG": "POWER_GENERATION",
        # Data-center real estate
        "EQIX": "DATA_CENTER_REIT", "DLR": "DATA_CENTER_REIT",
    }

    PEER_GROUPS = {
        "AI_COMPUTE": ["NVDA", "AMD", "AVGO", "MRVL", "CRDO", "ARM"],
        "MEMORY_STORAGE": ["MU", "WDC", "STX", "SNDK", "SIMO", "RMBS"],
        "SEMI_EQUIPMENT": ["ASML", "AMAT", "LRCX", "KLAC", "ONTO", "CAMT"],
        "NETWORKING_OPTICS": ["ANET", "COHR", "LITE", "AAOI", "FN"],
        "DATA_CENTER_POWER": ["VRT", "ETN", "GEV", "PWR", "CARR", "BE"],
        "AI_CLOUD_INFRA": ["CRWV", "NBIS", "IREN", "VRT", "ANET"],
        "AI_SOFTWARE": ["PLTR", "SNOW", "NOW", "CRM", "DDOG"],
        "MEGA_CAP_PLATFORM": ["MSFT", "GOOGL", "AMZN", "META", "AAPL"],
        "POWER_GENERATION": ["CEG", "VST", "NRG", "GEV"],
        "DATA_CENTER_REIT": ["EQIX", "DLR"],
        "GENERAL_AI": ["MSFT", "NVDA", "AVGO", "VRT", "ANET"],
    }

    ARCHETYPE_LABELS = {
        "AI_COMPUTE": "AI Compute Semiconductors",
        "MEMORY_STORAGE": "Memory & Storage Cycle",
        "SEMI_EQUIPMENT": "Semiconductor Equipment",
        "NETWORKING_OPTICS": "AI Networking & Optics",
        "DATA_CENTER_POWER": "Data-Center Power & Cooling",
        "AI_CLOUD_INFRA": "AI Cloud Infrastructure",
        "AI_SOFTWARE": "AI Software & Data Platforms",
        "MEGA_CAP_PLATFORM": "Mega-Cap Platform / Hyperscaler",
        "POWER_GENERATION": "Power Generation",
        "DATA_CENTER_REIT": "Data-Center Real Estate",
        "GENERAL_AI": "General AI Value Chain",
    }

    # The defaults are starting points, not hard-coded target multiples. Actual
    # valuation multiples come from the current peer group and are adjusted for the
    # subject company's growth, margin, risk and cash-conversion profile.
    ARCHETYPE_CONFIG = {
        "AI_COMPUTE": {
            "weights": {"DCF": 0.15, "Forward P/E": 0.50, "EV/EBITDA": 0.35},
            "forecast_years": 12, "sales_to_capital": 1.35, "growth_cap": 0.45,
            "terminal_margin_floor": 0.18, "terminal_margin_cap": 0.48,
            "rd_life": 4, "outlier_band": (0.45, 2.20),
        },
        "MEMORY_STORAGE": {
            "weights": {"DCF": 0.10, "Normalized P/E": 0.55, "EV/EBITDA": 0.35},
            "forecast_years": 8, "sales_to_capital": 0.80, "growth_cap": 0.40,
            "terminal_margin_floor": 0.08, "terminal_margin_cap": 0.28,
            "rd_life": 4, "outlier_band": (0.50, 1.90),
        },
        "SEMI_EQUIPMENT": {
            "weights": {"DCF": 0.20, "Forward P/E": 0.48, "EV/EBITDA": 0.32},
            "forecast_years": 9, "sales_to_capital": 1.20, "growth_cap": 0.32,
            "terminal_margin_floor": 0.16, "terminal_margin_cap": 0.38,
            "rd_life": 5, "outlier_band": (0.50, 2.00),
        },
        "NETWORKING_OPTICS": {
            "weights": {"DCF": 0.18, "Forward P/E": 0.45, "EV/EBITDA": 0.37},
            "forecast_years": 10, "sales_to_capital": 1.45, "growth_cap": 0.40,
            "terminal_margin_floor": 0.10, "terminal_margin_cap": 0.36,
            "rd_life": 4, "outlier_band": (0.42, 2.30),
        },
        "DATA_CENTER_POWER": {
            "weights": {"DCF": 0.18, "Forward P/E": 0.30, "EV/EBITDA": 0.52},
            "forecast_years": 9, "sales_to_capital": 1.05, "growth_cap": 0.35,
            "terminal_margin_floor": 0.08, "terminal_margin_cap": 0.28,
            "rd_life": 5, "outlier_band": (0.42, 2.25),
        },
        "AI_CLOUD_INFRA": {
            "weights": {"DCF": 0.08, "EV/Sales": 0.70, "EV/EBITDA": 0.22},
            "forecast_years": 12, "sales_to_capital": 0.65, "growth_cap": 0.60,
            "terminal_margin_floor": 0.10, "terminal_margin_cap": 0.35,
            "rd_life": 4, "outlier_band": (0.32, 2.60),
        },
        "AI_SOFTWARE": {
            "weights": {"DCF": 0.15, "EV/Sales": 0.40, "EV/FCF": 0.45},
            "forecast_years": 12, "sales_to_capital": 1.90, "growth_cap": 0.50,
            "terminal_margin_floor": 0.16, "terminal_margin_cap": 0.42,
            "rd_life": 3, "outlier_band": (0.38, 2.45),
        },
        "MEGA_CAP_PLATFORM": {
            "weights": {"DCF": 0.15, "Forward P/E": 0.50, "EV/FCF": 0.35},
            "forecast_years": 12, "sales_to_capital": 1.65, "growth_cap": 0.30,
            "terminal_margin_floor": 0.18, "terminal_margin_cap": 0.48,
            "rd_life": 4, "outlier_band": (0.58, 1.75),
        },
        "POWER_GENERATION": {
            "weights": {"DCF": 0.40, "Forward P/E": 0.20, "EV/EBITDA": 0.40},
            "forecast_years": 8, "sales_to_capital": 0.65, "growth_cap": 0.25,
            "terminal_margin_floor": 0.10, "terminal_margin_cap": 0.35,
            "rd_life": 6, "outlier_band": (0.50, 1.95),
        },
        "DATA_CENTER_REIT": {
            "weights": {"DCF": 0.35, "EV/EBITDA": 0.65},
            "forecast_years": 8, "sales_to_capital": 0.45, "growth_cap": 0.22,
            "terminal_margin_floor": 0.25, "terminal_margin_cap": 0.60,
            "rd_life": 6, "outlier_band": (0.55, 1.85),
        },
        "GENERAL_AI": {
            "weights": {"DCF": 0.40, "Forward P/E": 0.30, "EV/EBITDA": 0.30},
            "forecast_years": 8, "sales_to_capital": 1.10, "growth_cap": 0.30,
            "terminal_margin_floor": 0.08, "terminal_margin_cap": 0.35,
            "rd_life": 4, "outlier_band": (0.45, 2.15),
        },
    }


    def estimate_value(frame, period, column, default=None):
        return frame_cell(frame, period, column, default)


    def plausible_estimate(value, reference=None, low_factor=0.25, high_factor=4.0):
        value = positive_float(value)
        reference = positive_float(reference)
        if value is None:
            return None
        if reference is None:
            return value
        return value if reference * low_factor <= value <= reference * high_factor else None


    # Period-matched operating estimates. No target-price field enters this block.
    rev_0y_avg = plausible_estimate(estimate_value(revenue_estimates, "0y", "avg"), revenue_ttm)
    rev_0y_low = plausible_estimate(estimate_value(revenue_estimates, "0y", "low"), revenue_ttm)
    rev_0y_high = plausible_estimate(estimate_value(revenue_estimates, "0y", "high"), revenue_ttm)
    rev_1y_avg = plausible_estimate(estimate_value(revenue_estimates, "+1y", "avg"), revenue_ttm)
    rev_1y_low = plausible_estimate(estimate_value(revenue_estimates, "+1y", "low"), revenue_ttm)
    rev_1y_high = plausible_estimate(estimate_value(revenue_estimates, "+1y", "high"), revenue_ttm)

    eps_0y_avg = normalize_per_share_quote(estimate_value(earnings_estimates, "0y", "avg"))
    eps_0y_low = normalize_per_share_quote(estimate_value(earnings_estimates, "0y", "low"))
    eps_0y_high = normalize_per_share_quote(estimate_value(earnings_estimates, "0y", "high"))
    eps_1y_avg = normalize_per_share_quote(estimate_value(earnings_estimates, "+1y", "avg"))
    eps_1y_low = normalize_per_share_quote(estimate_value(earnings_estimates, "+1y", "low"))
    eps_1y_high = normalize_per_share_quote(estimate_value(earnings_estimates, "+1y", "high"))

    reported_shares = positive_float(info.get("sharesOutstanding")) or shares_out
    implied_market_cap = current_price * reported_shares
    if market_cap and implied_market_cap:
        mcap_ratio = market_cap / implied_market_cap
        if not 0.75 <= mcap_ratio <= 1.25:
            print(
                "WARNING: marketCap is inconsistent with price x shares. "
                "Using price x shares for internally consistent valuation; no field was rescaled."
            )
            market_cap = implied_market_cap
    shares_out = reported_shares
    share_count = shares_out
    minority_interest = positive_float(info.get("minorityInterest")) or 0.0
    preferred_stock = positive_float(info.get("preferredStock")) or 0.0
    enterprise_value_current = max(market_cap + latest_debt - latest_cash, 1.0)


    def classify_ai_archetype():
        if MANUAL_ARCHETYPE in ARCHETYPE_CONFIG:
            return MANUAL_ARCHETYPE
        symbol = TICKER_SYMBOL.upper()
        if symbol in TICKER_ARCHETYPE_OVERRIDES:
            return TICKER_ARCHETYPE_OVERRIDES[symbol]

        text = " ".join([
            str(company_name), str(sector), str(industry),
            str(info.get("longBusinessSummary") or "")
        ]).lower()
        rules = [
            ("MEMORY_STORAGE", ["memory chip", "dram", "nand", "storage device", "hard disk"]),
            ("SEMI_EQUIPMENT", ["semiconductor equipment", "wafer fabrication", "process control", "lithography"]),
            ("NETWORKING_OPTICS", ["optical", "photonics", "transceiver", "network switch", "networking equipment"]),
            ("DATA_CENTER_POWER", ["fuel cell", "electrical equipment", "power management", "cooling", "thermal management"]),
            ("AI_SOFTWARE", ["application software", "cloud software", "data analytics", "artificial intelligence software"]),
            ("AI_COMPUTE", ["graphics processor", "gpu", "semiconductor design", "integrated circuits"]),
            ("POWER_GENERATION", ["independent power producer", "electric generation", "nuclear power"]),
            ("DATA_CENTER_REIT", ["data center reit", "real estate investment trust"]),
        ]
        for archetype, keywords in rules:
            if any(keyword in text for keyword in keywords):
                return archetype
        if market_cap >= 250_000_000_000 and str(sector).lower() in {
            "technology", "communication services", "consumer cyclical"
        }:
            return "MEGA_CAP_PLATFORM"
        return "GENERAL_AI"


    valuation_archetype_id = classify_ai_archetype()
    valuation_archetype = ARCHETYPE_LABELS[valuation_archetype_id]
    config = ARCHETYPE_CONFIG[valuation_archetype_id]

    # A stage overlay matters as much as sector. Bloom Energy and Eaton both benefit
    # from data-center power demand, but one may require an EV/Sales / margin-ramp
    # framework while the other can support P/E and EV/EBITDA.
    current_operating_margin = current_ebit_margin if current_ebit_margin is not None else op_margin
    weak_profitability = (
        net_income_ttm is None or net_income_ttm <= 0
        or fcf_ttm is None or fcf_ttm <= 0
        or current_operating_margin is None or current_operating_margin < 0.06
    )
    high_growth_signal = max(
        next_year_revenue_growth or 0.0,
        long_term_growth_estimate or 0.0,
        info.get("revenueGrowth") or 0.0,
    ) >= 0.15
    high_growth_stage = weak_profitability and high_growth_signal

    if valuation_archetype_id == "DATA_CENTER_POWER" and high_growth_stage:
        # BE-like high-growth power platform: earnings multiples are not yet reliable.
        config = dict(config)
        config["weights"] = {"DCF": 0.05, "EV/Sales": 0.80, "EV/EBITDA": 0.15}
        config["outlier_band"] = (0.34, 2.55)
        valuation_archetype += " — High-Growth Stage"


    # -----------------------------------------------------------------------------
    # Peer market layer: current market multiples, never analyst targets.
    # -----------------------------------------------------------------------------
    _peer_cache = {}


    def peer_snapshot(symbol):
        if symbol in _peer_cache:
            return _peer_cache[symbol]
        try:
            peer = yf.Ticker(symbol)
            peer_info = peer.info or {}
            peer_price = positive_float(peer_info.get("currentPrice") or peer_info.get("regularMarketPrice"))
            peer_market_cap = positive_float(peer_info.get("marketCap"))
            peer_ev = positive_float(peer_info.get("enterpriseValue"))
            peer_revenue = positive_float(peer_info.get("totalRevenue"))
            peer_ebitda = positive_float(peer_info.get("ebitda"))
            peer_fcf = positive_float(peer_info.get("freeCashflow"))
            snapshot = {
                "ticker": symbol,
                "price": peer_price,
                "market_cap": peer_market_cap,
                "forward_pe": positive_float(peer_info.get("forwardPE")),
                "ev_ebitda": positive_float(peer_info.get("enterpriseToEbitda")),
                "ev_sales": safe_ratio(peer_ev, peer_revenue, None),
                "ev_fcf": safe_ratio(peer_ev, peer_fcf, None),
                "growth": peer_info.get("revenueGrowth"),
                "operating_margin": peer_info.get("operatingMargins") or peer_info.get("operatingMargin"),
                "fcf_margin": safe_ratio(peer_fcf, peer_revenue, None),
                "beta": positive_float(peer_info.get("beta")) or 1.0,
            }
            _peer_cache[symbol] = snapshot
            return snapshot
        except Exception as exc:
            print(f"Peer-data note for {symbol}: {exc}")
            _peer_cache[symbol] = None
            return None


    def median_valid(items, key, low=None, high=None, default=None):
        values = []
        for item in items:
            if not item:
                continue
            value = item.get(key)
            try:
                value = float(value)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(value):
                continue
            if low is not None and value < low:
                continue
            if high is not None and value > high:
                continue
            values.append(value)
        return finite_median(values, default)


    peer_symbols = [s for s in PEER_GROUPS[valuation_archetype_id] if s != TICKER_SYMBOL.upper()][:6]
    peer_data = [peer_snapshot(symbol) for symbol in peer_symbols]
    peer_data = [item for item in peer_data if item]
    peer_count = len(peer_data)

    peer_forward_pe = median_valid(peer_data, "forward_pe", 3.0, 100.0, None)
    peer_ev_ebitda = median_valid(peer_data, "ev_ebitda", 2.0, 80.0, None)
    peer_ev_sales = median_valid(peer_data, "ev_sales", 0.2, 40.0, None)
    peer_ev_fcf = median_valid(peer_data, "ev_fcf", 3.0, 100.0, None)
    peer_growth = median_valid(peer_data, "growth", -0.30, 1.00, next_year_revenue_growth or 0.08)
    peer_operating_margin = median_valid(peer_data, "operating_margin", -0.40, 0.75, normalized_ebit_margin)
    peer_fcf_margin = median_valid(peer_data, "fcf_margin", -0.40, 0.65, fcf_margin)
    peer_beta = median_valid(peer_data, "beta", 0.20, 4.00, 1.0)


    # -----------------------------------------------------------------------------
    # Forecast construction: shared near-term evidence, independent long-term view.
    # -----------------------------------------------------------------------------
    def estimate_analyst_count(frame, period="+1y"):
        for column in ["numberOfAnalysts", "numberofAnalysts", "analystCount"]:
            value = frame_cell(frame, period, column, None)
            if value is not None:
                return max(int(value), 0)
        return consensus_analyst_count or 0


    operating_estimate_count = max(
        estimate_analyst_count(revenue_estimates, "+1y"),
        estimate_analyst_count(earnings_estimates, "+1y"),
    )
    # The model uses consensus operating estimates more heavily when coverage is broad,
    # but never more than 80%; the remaining weight comes from company and peer data.
    operating_estimate_weight = clamp(0.50 + 0.012 * operating_estimate_count, 0.50, 0.80)
    if not USE_ANALYST_OPERATING_ESTIMATES:
        operating_estimate_weight = 0.0

    historical_growth_anchor = finite_median([
        revenue_cagr,
        info.get("revenueGrowth"),
        next_year_revenue_growth,
    ], 0.08)
    historical_growth_anchor = clamp(historical_growth_anchor, -0.15, config["growth_cap"])
    peer_growth_anchor = clamp(peer_growth if peer_growth is not None else historical_growth_anchor, -0.10, config["growth_cap"])
    standalone_growth_anchor = 0.60 * historical_growth_anchor + 0.40 * peer_growth_anchor

    standalone_rev_1 = revenue_ttm * (1 + standalone_growth_anchor) if revenue_ttm else None
    standalone_rev_2 = (
        standalone_rev_1 * (1 + clamp(0.65 * standalone_growth_anchor + 0.35 * peer_growth_anchor, -0.10, config["growth_cap"]))
        if standalone_rev_1 else None
    )


    def blend_estimate(consensus_value, standalone_value, weight):
        consensus_value = positive_float(consensus_value)
        standalone_value = positive_float(standalone_value)
        if consensus_value is None:
            return standalone_value
        if standalone_value is None:
            return consensus_value
        return weight * consensus_value + (1 - weight) * standalone_value


    forward_revenue_year1 = blend_estimate(rev_0y_avg, standalone_rev_1, operating_estimate_weight)
    forward_revenue_year2 = blend_estimate(rev_1y_avg, standalone_rev_2, operating_estimate_weight)
    if forward_revenue_year1 is None:
        forward_revenue_year1 = revenue_ttm
    if forward_revenue_year2 is None:
        forward_revenue_year2 = forward_revenue_year1 * (1 + standalone_growth_anchor)

    # Reject EPS estimates that imply an impossible period-matched net margin. Never
    # repair them with a power-of-ten conversion.
    def validated_eps(eps_value, revenue_value):
        eps_value = positive_float(eps_value)
        revenue_value = positive_float(revenue_value)
        if eps_value is None or revenue_value is None or share_count <= 0:
            return None
        implied_margin = eps_value * share_count / revenue_value
        return eps_value if -0.25 <= implied_margin <= 0.75 else None


    forward_eps_year1 = validated_eps(eps_0y_avg, forward_revenue_year1)
    forward_eps_year2 = validated_eps(eps_1y_avg, forward_revenue_year2)
    if forward_eps_year2 is None:
        forward_eps_year2 = validated_eps(info.get("forwardEps"), forward_revenue_year2)

    # A sell-side target is normally a 12-month value, while +1y estimates can end at
    # a fiscal year boundary before or after that date. Roll the next-fiscal-year
    # operating base forward by half of a faded growth year. This uses no target price.
    target_date_growth_roll = clamp(
        0.50 * (0.60 * standalone_growth_anchor + 0.40 * long_term_growth_estimate),
        -0.08,
        0.18 if valuation_archetype_id != "MEMORY_STORAGE" else 0.12,
    )
    target_date_revenue = forward_revenue_year2 * (1 + target_date_growth_roll) if forward_revenue_year2 else None
    if forward_eps_year2 is not None:
        eps_roll = target_date_growth_roll
        if valuation_archetype_id == "MEMORY_STORAGE":
            eps_roll = clamp(eps_roll, -0.05, 0.08)
        target_date_eps = forward_eps_year2 * (1 + eps_roll)
    else:
        target_date_eps = None


    def eps_implied_ebit_margin(eps_value, revenue_value):
        if eps_value is None or revenue_value is None or share_count <= 0:
            return None
        net_income = eps_value * share_count
        pretax_income = net_income / max(1 - effective_tax_rate, 0.55)
        ebit = pretax_income + interest_ttm
        margin = safe_ratio(ebit, revenue_value, None)
        return margin if margin is not None and -0.35 <= margin <= 0.70 else None


    forward_margin_year1 = eps_implied_ebit_margin(forward_eps_year1, forward_revenue_year1)
    forward_margin_year2 = eps_implied_ebit_margin(forward_eps_year2, forward_revenue_year2)

    # Normalized margin depends on the economics of the specific AI sub-sector.
    # Cyclical memory uses a mid-cycle margin; scalable platforms use a peer-informed
    # mature margin; early-stage infrastructure uses a credible margin-ramp endpoint.
    historical_margin_anchor = normalized_ebit_margin
    peer_margin_anchor = peer_operating_margin if peer_operating_margin is not None else historical_margin_anchor
    if valuation_archetype_id == "MEMORY_STORAGE":
        target_operating_margin = 0.65 * historical_margin_anchor + 0.35 * peer_margin_anchor
    elif high_growth_stage or valuation_archetype_id in {"AI_CLOUD_INFRA", "AI_SOFTWARE"}:
        target_operating_margin = 0.25 * max(current_operating_margin or 0.0, 0.0) + 0.75 * peer_margin_anchor
    elif valuation_archetype_id == "MEGA_CAP_PLATFORM":
        target_operating_margin = (
            0.45 * (current_operating_margin or historical_margin_anchor)
            + 0.35 * peer_margin_anchor
            + 0.20 * historical_margin_anchor
        )
    else:
        target_operating_margin = 0.45 * historical_margin_anchor + 0.35 * peer_margin_anchor + 0.20 * (current_operating_margin or historical_margin_anchor)

    target_operating_margin = clamp(
        target_operating_margin,
        config["terminal_margin_floor"],
        config["terminal_margin_cap"],
    )

    # Forward EBITDA margin is built from operating margin plus normalized D&A.
    da_margin_series = aligned_ratio(da_annual, revenue_annual, low=0.0, high=0.40)
    normalized_da_margin = finite_median(da_margin_series.values, safe_ratio(da_ttm, revenue_ttm, 0.04))
    normalized_da_margin = clamp(normalized_da_margin if normalized_da_margin is not None else 0.04, 0.01, 0.30)

    # Sales-to-capital captures the cost of growth. It is more stable than forcing
    # growth/ROIC into a reinvestment rate for young or cyclical firms.
    own_sales_to_capital = safe_ratio(revenue_ttm, latest_invested_capital, None)
    sales_to_capital = finite_median([
        own_sales_to_capital,
        config["sales_to_capital"],
    ], config["sales_to_capital"])
    sales_to_capital = clamp(sales_to_capital, 0.25, 4.0)


    # -----------------------------------------------------------------------------
    # Scenario DCF: archetype-specific growth fade, margin path and reinvestment.
    # -----------------------------------------------------------------------------
    def scenario_parameters(name):
        if name == "Bear":
            return {"growth_shift": -0.22, "margin_shift": -0.18, "wacc_shift": 0.015, "multiple_shift": -0.16}
        if name == "Bull":
            return {"growth_shift": 0.18, "margin_shift": 0.14, "wacc_shift": -0.010, "multiple_shift": 0.16}
        return {"growth_shift": 0.0, "margin_shift": 0.0, "wacc_shift": 0.0, "multiple_shift": 0.0}


    def interpolate(start, end, step, total_steps):
        if total_steps <= 1:
            return end
        weight = clamp(step / total_steps, 0.0, 1.0)
        return start + (end - start) * weight


    def build_growth_path(name):
        params = scenario_parameters(name)
        years = config["forecast_years"]
        rev0 = revenue_ttm or forward_revenue_year1
        g1 = safe_ratio(forward_revenue_year1, rev0, 1.0) - 1.0 if rev0 else standalone_growth_anchor
        g2 = safe_ratio(forward_revenue_year2, forward_revenue_year1, 1.0) - 1.0 if forward_revenue_year1 else standalone_growth_anchor
        g1 = clamp(g1 * (1 + params["growth_shift"]), -0.25, config["growth_cap"])
        g2 = clamp(g2 * (1 + params["growth_shift"]), -0.20, config["growth_cap"])
        terminal_g = clamp(terminal_growth, 0.015, min(0.035, wacc - 0.025))
        path = [g1, g2]
        for year in range(3, years + 1):
            # Smooth fade from year-two growth to terminal growth.
            fade = (year - 2) / max(years - 2, 1)
            curved_fade = 1 - (1 - fade) ** 1.35
            growth = g2 + (terminal_g - g2) * curved_fade
            path.append(clamp(growth, -0.10, config["growth_cap"]))
        return path, terminal_g


    def build_margin_path(name):
        params = scenario_parameters(name)
        years = config["forecast_years"]
        base_start = forward_margin_year1
        if base_start is None:
            base_start = current_operating_margin if current_operating_margin is not None else historical_margin_anchor
        second = forward_margin_year2 if forward_margin_year2 is not None else base_start
        target = target_operating_margin * (1 + params["margin_shift"])
        target = clamp(target, -0.20, config["terminal_margin_cap"])

        if valuation_archetype_id == "MEMORY_STORAGE":
            # Use near-term cycle economics for FY1/FY2, then normalize over years 3-5.
            normalization_year = min(5, years)
        elif high_growth_stage or valuation_archetype_id in {"AI_CLOUD_INFRA", "AI_SOFTWARE"}:
            normalization_year = min(7, years)
        else:
            normalization_year = min(5, years)

        path = [clamp(base_start, -0.35, 0.70), clamp(second, -0.35, 0.70)]
        for year in range(3, years + 1):
            if year <= normalization_year:
                margin = interpolate(path[1], target, year - 2, normalization_year - 2)
            else:
                margin = target
            path.append(clamp(margin, -0.35, 0.70))
        return path, target


    def run_independent_dcf(name):
        params = scenario_parameters(name)
        growth_path, stable_g = build_growth_path(name)
        margin_path, stable_margin = build_margin_path(name)
        peer_cost_of_equity = risk_free_rate + clamp(peer_beta, 0.50, 2.50) * US_IMPLIED_ERP
        base_model_wacc = wacc
        if valuation_archetype_id in {"MEGA_CAP_PLATFORM", "AI_COMPUTE", "AI_SOFTWARE", "SEMI_EQUIPMENT"}:
            base_model_wacc = 0.60 * wacc + 0.40 * peer_cost_of_equity
        scenario_wacc = clamp(base_model_wacc + params["wacc_shift"], 0.055, 0.20)
        revenue = revenue_ttm or forward_revenue_year1
        if not revenue or revenue <= 0:
            return None

        pv_fcff = 0.0
        forecast_rows = []
        for year, (growth, margin) in enumerate(zip(growth_path, margin_path), start=1):
            previous_revenue = revenue
            revenue = revenue * (1 + growth)
            ebit = revenue * margin
            nopat = ebit * (1 - effective_tax_rate)
            change_revenue = max(revenue - previous_revenue, 0.0)

            # Recovery growth in cyclical businesses partly uses existing capacity;
            # do not charge full greenfield reinvestment in the first two years.
            if valuation_archetype_id == "MEMORY_STORAGE":
                utilization_factor = 0.35 if year == 1 else 0.55 if year == 2 else 0.80 if year == 3 else 1.0
            elif high_growth_stage or valuation_archetype_id == "AI_CLOUD_INFRA":
                utilization_factor = 1.15
            else:
                utilization_factor = 1.0
            cash_margin_archetype = valuation_archetype_id in {
                "MEGA_CAP_PLATFORM", "AI_SOFTWARE", "AI_COMPUTE"
            }
            starting_fcff_margin = safe_ratio(fcff_ttm, revenue_ttm, None)
            peer_cash_margin = peer_fcf_margin if peer_fcf_margin is not None else starting_fcff_margin
            target_fcff_margin = finite_median([
                starting_fcff_margin,
                peer_cash_margin,
                max(target_operating_margin * (1 - effective_tax_rate) * 0.72, 0.0),
            ], None)
            if cash_margin_archetype and target_fcff_margin is not None and target_fcff_margin > 0.02:
                start_cash_margin = starting_fcff_margin if starting_fcff_margin is not None else target_fcff_margin * 0.75
                cash_margin = interpolate(
                    start_cash_margin,
                    target_fcff_margin * (1 + 0.65 * params["margin_shift"]),
                    year,
                    min(6, config["forecast_years"]),
                )
                cash_margin = clamp(cash_margin, 0.01, 0.50)
                reinvestment = max(nopat - revenue * cash_margin, 0.0)
                fcff = revenue * cash_margin
            else:
                reinvestment = change_revenue / max(sales_to_capital, 0.25) * utilization_factor
                fcff = nopat - reinvestment
            discount_factor = (1 + scenario_wacc) ** year
            pv_fcff += fcff / discount_factor
            forecast_rows.append({
                "year": year, "revenue": revenue, "growth": growth,
                "margin": margin, "nopat": nopat, "reinvestment": reinvestment,
                "fcff": fcff,
            })

        terminal_roic = clamp(max(model_roic, scenario_wacc + 0.01), scenario_wacc + 0.005, scenario_wacc + 0.08)
        terminal_nopat = revenue * stable_margin * (1 - effective_tax_rate)
        cash_margin_archetype = valuation_archetype_id in {
            "MEGA_CAP_PLATFORM", "AI_SOFTWARE", "AI_COMPUTE"
        }
        starting_fcff_margin = safe_ratio(fcff_ttm, revenue_ttm, None)
        target_fcff_margin = finite_median([
            starting_fcff_margin,
            peer_fcf_margin,
            max(stable_margin * (1 - effective_tax_rate) * 0.72, 0.0),
        ], None)
        if cash_margin_archetype and target_fcff_margin is not None and target_fcff_margin > 0.02:
            terminal_fcff = revenue * clamp(target_fcff_margin, 0.01, 0.50) * (1 + stable_g)
        else:
            terminal_reinvestment_rate = clamp(stable_g / max(terminal_roic, stable_g + 0.01), 0.0, 0.65)
            terminal_fcff = terminal_nopat * (1 + stable_g) * (1 - terminal_reinvestment_rate)
        terminal_value = terminal_fcff / max(scenario_wacc - stable_g, 0.025)
        pv_terminal = terminal_value / ((1 + scenario_wacc) ** config["forecast_years"])
        enterprise_value = pv_fcff + pv_terminal
        equity_value = enterprise_value + latest_cash - latest_debt - minority_interest - preferred_stock
        per_share = equity_value / max(share_count, 1.0)
        return max(per_share, 0.0)


    # -----------------------------------------------------------------------------
    # Relative valuation: current peer market pricing adjusted for fundamentals.
    # -----------------------------------------------------------------------------
    def subject_growth_for_relative():
        if forward_revenue_year1 and forward_revenue_year2:
            return safe_ratio(forward_revenue_year2, forward_revenue_year1, 1.0) - 1.0
        return standalone_growth_anchor


    def relative_adjustment():
        subject_growth = clamp(subject_growth_for_relative() or 0.0, -0.20, 0.80)
        comparison_growth = clamp(peer_growth or subject_growth, -0.20, 0.80)
        subject_margin = target_operating_margin
        comparison_margin = peer_operating_margin if peer_operating_margin is not None else subject_margin
        growth_factor = math.exp(clamp(1.15 * (subject_growth - comparison_growth), -0.35, 0.40))
        margin_factor = math.exp(clamp(0.65 * (subject_margin - comparison_margin), -0.25, 0.25))
        risk_factor = clamp(math.sqrt(max(peer_beta, 0.2) / max(adjusted_beta, 0.2)), 0.78, 1.22)
        quality_factor = 1.0
        if fcf_margin is not None and peer_fcf_margin is not None:
            quality_factor *= math.exp(clamp(0.50 * (fcf_margin - peer_fcf_margin), -0.20, 0.20))
        if sbc_intensity is not None and valuation_archetype_id in {"AI_SOFTWARE", "AI_CLOUD_INFRA"}:
            quality_factor *= clamp(1.0 - max(sbc_intensity - 0.08, 0.0) * 1.5, 0.78, 1.0)
        return clamp(growth_factor * margin_factor * risk_factor * quality_factor, 0.62, 1.55)


    relative_factor = relative_adjustment()


    def scenario_forward_eps(name):
        params = scenario_parameters(name)
        base = target_date_eps or forward_eps_year2 or forward_eps_year1
        if base is None:
            # Derive EPS from normalized operating economics when sell-side EPS is unusable.
            revenue = forward_revenue_year2 or forward_revenue_year1
            if revenue:
                ebit = revenue * target_operating_margin
                net_income = max((ebit - interest_ttm) * (1 - effective_tax_rate), 0.0)
                base = net_income / max(share_count, 1.0)
        if base is None:
            return None
        return max(base * (1 + 0.65 * params["growth_shift"] + 0.55 * params["margin_shift"]), 0.0)


    def forward_pe_value(name):
        eps = scenario_forward_eps(name)
        if eps is None or eps <= 0:
            return None
        observed_pe = positive_float(info.get("forwardPE"))
        justified_pe = None
        normalized_roe = safe_ratio(net_income_ttm, latest_equity, None) if latest_equity > 0 else None
        if normalized_roe and normalized_roe > terminal_growth:
            retention = clamp(terminal_growth / normalized_roe, 0.0, 0.80)
            justified_pe = (1 - retention) / max(cost_of_equity - terminal_growth, 0.025)
        candidates = []
        if peer_forward_pe:
            candidates.append((peer_forward_pe * relative_factor, 0.40))
        if observed_pe and 3 <= observed_pe <= 100:
            candidates.append((observed_pe, 0.55))
        if justified_pe and 3 <= justified_pe <= 100:
            candidates.append((justified_pe, 0.10))
        if not candidates:
            return None
        multiple = sum(v * w for v, w in candidates) / sum(w for _, w in candidates)
        multiple *= 1 + scenario_parameters(name)["multiple_shift"]
        return eps * clamp(multiple, 4.0, 90.0)


    def normalized_pe_value(name):
        # For memory/storage, value current scale on normalized mid-cycle earnings.
        normalized_revenue = finite_mean([
            revenue_ttm,
            forward_revenue_year1,
            forward_revenue_year2,
        ], forward_revenue_year2 or revenue_ttm)
        if not normalized_revenue:
            return None
        params = scenario_parameters(name)
        normalized_margin = clamp(target_operating_margin * (1 + params["margin_shift"]), 0.02, 0.45)
        normalized_ebit = normalized_revenue * normalized_margin
        normalized_net_income = max((normalized_ebit - interest_ttm) * (1 - effective_tax_rate), 0.0)
        normalized_eps = normalized_net_income / max(share_count, 1.0)
        if normalized_eps <= 0:
            return None
        forward_eps = scenario_forward_eps(name)
        forward_growth = subject_growth_for_relative() or 0.0
        structural_upcycle = (
            forward_eps is not None
            and forward_growth > 0.10
            and (forward_margin_year2 or target_operating_margin) > target_operating_margin + 0.04
        )
        forward_weight = 0.65 if structural_upcycle else 0.45
        if forward_growth < 0 or (forward_margin_year2 is not None and forward_margin_year2 < target_operating_margin):
            forward_weight = 0.25
        valuation_eps = (
            forward_weight * forward_eps + (1 - forward_weight) * normalized_eps
            if forward_eps is not None else normalized_eps
        )
        base_multiple = peer_forward_pe or positive_float(info.get("forwardPE")) or 14.0
        # Mid-cycle multiples should not capitalize peak growth indefinitely.
        multiple = clamp(base_multiple * relative_factor, 6.0, 28.0)
        multiple *= 1 + params["multiple_shift"]
        return valuation_eps * multiple


    def forward_ebitda_value(name):
        revenue = target_date_revenue or forward_revenue_year2 or forward_revenue_year1
        if not revenue:
            return None
        params = scenario_parameters(name)
        base_ebit_margin = target_operating_margin
        if valuation_archetype_id == "MEMORY_STORAGE" and forward_margin_year2 is not None:
            base_ebit_margin = 0.60 * forward_margin_year2 + 0.40 * target_operating_margin
        ebit_margin = clamp(base_ebit_margin * (1 + params["margin_shift"]), -0.20, 0.65)
        ebitda_margin = ebit_margin + normalized_da_margin
        if ebitda_margin <= 0.01:
            return None
        ebitda = revenue * ebitda_margin
        observed = positive_float(info.get("enterpriseToEbitda"))
        candidates = []
        if peer_ev_ebitda:
            candidates.append((peer_ev_ebitda * relative_factor, 0.65))
        if observed and 2 <= observed <= 80:
            candidates.append((observed, 0.20))
        # Fundamentally justified EV/EBITDA cross-check from steady FCFF conversion.
        steady_nopat_margin = max(ebit_margin * (1 - effective_tax_rate), 0.0)
        stable_reinvestment = clamp(terminal_growth / max(stable_roic, terminal_growth + 0.01), 0.0, 0.65)
        fcff_margin_steady = steady_nopat_margin * (1 - stable_reinvestment)
        justified = safe_ratio(fcff_margin_steady * (1 + terminal_growth),
                                max(wacc - terminal_growth, 0.025) * ebitda_margin, None)
        if justified and 2 <= justified <= 80:
            candidates.append((justified, 0.15))
        if not candidates:
            return None
        multiple = sum(v * w for v, w in candidates) / sum(w for _, w in candidates)
        multiple *= 1 + params["multiple_shift"]
        enterprise_value = ebitda * clamp(multiple, 2.0, 70.0)
        equity_value = enterprise_value + latest_cash - latest_debt - minority_interest - preferred_stock
        return max(equity_value / max(share_count, 1.0), 0.0)


    def forward_sales_value(name):
        revenue = target_date_revenue or forward_revenue_year2 or forward_revenue_year1
        if not revenue:
            return None
        params = scenario_parameters(name)
        observed = safe_ratio(enterprise_value_current, revenue_ttm, None)
        candidates = []
        if peer_ev_sales:
            candidates.append((peer_ev_sales * relative_factor, 0.35))
        if observed and 0.2 <= observed <= 40:
            observed_weight = 0.60 if high_growth_stage or valuation_archetype_id == "AI_CLOUD_INFRA" else 0.50
            candidates.append((observed, observed_weight))
        # Fundamental EV/Sales bridge: value of a dollar of mature revenue.
        mature_after_tax_margin = max(target_operating_margin * (1 - effective_tax_rate), 0.0)
        stable_reinvestment = clamp(terminal_growth / max(stable_roic, terminal_growth + 0.01), 0.0, 0.65)
        justified = mature_after_tax_margin * (1 - stable_reinvestment) * (1 + terminal_growth) / max(wacc - terminal_growth, 0.025)
        if 0.2 <= justified <= 40:
            candidates.append((justified, 0.05))
        if not candidates:
            return None
        multiple = sum(v * w for v, w in candidates) / sum(w for _, w in candidates)
        multiple *= 1 + params["multiple_shift"]
        enterprise_value = revenue * clamp(multiple, 0.3, 40.0)
        equity_value = enterprise_value + latest_cash - latest_debt - minority_interest - preferred_stock
        return max(equity_value / max(share_count, 1.0), 0.0)


    def forward_fcf_value(name):
        revenue = target_date_revenue or forward_revenue_year2 or forward_revenue_year1
        if not revenue:
            return None
        params = scenario_parameters(name)
        target_fcf_margin = finite_median([
            fcf_margin,
            peer_fcf_margin,
            target_operating_margin * (1 - effective_tax_rate) * 0.72,
        ], None)
        if target_fcf_margin is None:
            return None
        target_fcf_margin = clamp(target_fcf_margin * (1 + params["margin_shift"]), 0.02, 0.45)
        forward_fcf = revenue * target_fcf_margin
        observed = safe_ratio(enterprise_value_current, fcf_ttm, None) if fcf_ttm and fcf_ttm > 0 else None
        candidates = []
        if peer_ev_fcf:
            candidates.append((peer_ev_fcf * relative_factor, 0.45))
        if observed and 3 <= observed <= 100:
            candidates.append((observed, 0.50))
        justified = (1 + terminal_growth) / max(wacc - terminal_growth, 0.025)
        if 3 <= justified <= 100:
            candidates.append((justified, 0.05))
        if not candidates:
            return None
        multiple = sum(v * w for v, w in candidates) / sum(w for _, w in candidates)
        multiple *= 1 + params["multiple_shift"]
        enterprise_value = forward_fcf * clamp(multiple, 3.0, 90.0)
        equity_value = enterprise_value + latest_cash - latest_debt - minority_interest - preferred_stock
        return max(equity_value / max(share_count, 1.0), 0.0)


    def method_values(name):
        dcf_present_value = run_independent_dcf(name)
        dcf_target_value = dcf_present_value * (1 + cost_of_equity) if dcf_present_value else None
        values = {
            "DCF": dcf_target_value,
            "Forward P/E": forward_pe_value(name),
            "Normalized P/E": normalized_pe_value(name),
            "EV/EBITDA": forward_ebitda_value(name),
            "EV/Sales": forward_sales_value(name),
            "EV/FCF": forward_fcf_value(name),
        }
        return {key: value for key, value in values.items()
                if isinstance(value, (int, float)) and math.isfinite(value) and value > 0}


    def robust_weighted_composite(values, weights, band):
        valid = {key: value for key, value in values.items() if key in weights and weights[key] > 0}
        if not valid:
            return None, {}
        center = finite_median(valid.values(), None)
        if center is None or center <= 0:
            return None, valid
        low_band, high_band = band
        winsorized = {
            key: clamp(value, center * low_band, center * high_band)
            for key, value in valid.items()
        }
        total_weight = sum(weights[key] for key in winsorized)
        composite = sum(winsorized[key] * weights[key] / total_weight for key in winsorized)
        return composite, winsorized


    scenario_method_values = {}
    scenario_values = {}
    for scenario_name in ["Bear", "Base", "Bull"]:
        raw_values = method_values(scenario_name)
        composite, used_values = robust_weighted_composite(
            raw_values, config["weights"], config["outlier_band"]
        )
        scenario_method_values[scenario_name] = used_values
        scenario_values[scenario_name] = composite

    intrinsic_value = scenario_values.get("Base")
    bear_price = scenario_values.get("Bear")
    bull_price = scenario_values.get("Bull")
    if intrinsic_value is None:
        # Last-resort valuation uses the current peer-adjusted market price, not an
        # analyst price target. This should be rare and is explicitly logged.
        intrinsic_value = current_price * relative_factor
        print("WARNING: no complete valuation method set; peer-adjusted market fallback used.")
    if bear_price is None:
        bear_price = intrinsic_value * 0.75
    if bull_price is None:
        bull_price = intrinsic_value * 1.30

    bear_price = min(bear_price, intrinsic_value)
    bull_price = max(bull_price, intrinsic_value)
    fundamental_target = intrinsic_value

    # Analyst consensus is a comparison output only. It cannot alter intrinsic value.
    has_published_consensus = not target_is_model_fallback and raw_target_mean is not None
    consensus_anchor = None
    if has_published_consensus:
        consensus_anchor = (
            0.65 * raw_target_mean + 0.35 * target_median
            if target_median is not None else raw_target_mean
        )
    street_gap = safe_ratio(intrinsic_value, consensus_anchor, None)
    if street_gap is not None:
        street_gap -= 1.0

    upside = safe_ratio(intrinsic_value - current_price, current_price, 0.0)
    if upside >= 0.25:
        model_rating, rating_class = "STRONG BUY", "buy"
    elif upside >= 0.10:
        model_rating, rating_class = "BUY", "buy"
    elif upside > -0.10:
        model_rating, rating_class = "HOLD", "hold"
    else:
        model_rating, rating_class = "SELL", "sell"

    rsi_class = "buy" if rsi_14 < 30 else "sell" if rsi_14 > 70 else "hold"
    fair_value_low = bear_price
    fair_value_high = bull_price
    accumulation_zone = intrinsic_value * 0.85
    high_conviction_zone = min(intrinsic_value * 0.75, fair_value_low * 0.95)
    methodology = f"Independent {valuation_archetype} Composite"

    # Confidence comes from source quality and agreement among independent methods,
    # not from closeness to Wall Street.
    base_methods = scenario_method_values.get("Base", {})
    method_dispersion = None
    if len(base_methods) >= 2:
        method_series = pd.Series(list(base_methods.values()), dtype="float64")
        method_dispersion = safe_ratio(method_series.std(), method_series.mean(), None)
    data_quality_score = 0.35
    if revenue_ttm and revenue_ttm > 0:
        data_quality_score += 0.12
    if forward_revenue_year1 and forward_revenue_year2:
        data_quality_score += 0.13
    if share_count and share_count > 0:
        data_quality_score += 0.08
    if peer_count >= 3:
        data_quality_score += 0.12
    if len(base_methods) >= 2:
        data_quality_score += 0.12
    if forward_eps_year2 or valuation_archetype_id in {"AI_SOFTWARE", "AI_CLOUD_INFRA"}:
        data_quality_score += 0.08
    if method_dispersion is not None:
        data_quality_score -= clamp(method_dispersion - 0.20, 0.0, 0.25)
    model_confidence = int(clamp(round(data_quality_score * 100), 35, 92))

    street_comparison = (
        f"{street_gap:+.1%} vs published consensus"
        if street_gap is not None else "Published consensus unavailable"
    )

    print(
        f"Architecture: {valuation_archetype}; peers={peer_count}; "
        f"operating-estimate weight={operating_estimate_weight:.0%}; "
        f"analyst-target weight=0%; independent fair value=${intrinsic_value:,.2f}; "
        f"Street comparison={street_comparison}."
    )


    # =========================================================
    # 6. INDIVIDUAL ANALYST FEED: DIRECT DATA + GROUNDED WEB SEARCH
    # =========================================================
    print("Building individually sourced analyst table...")


    def first_present(mapping, *keys, default=None):
        for key in keys:
            value = mapping.get(key)
            if value not in (None, "", "null", "None"):
                return value
        return default


    def to_float(value):
        if value in (None, "", "N/A", "null"):
            return None
        try:
            cleaned = str(value).replace("$", "").replace(",", "").strip()
            number = float(cleaned)
            return number if math.isfinite(number) and number > 0 else None
        except (TypeError, ValueError):
            return None


    def normalized_date(value):
        parsed = pd.to_datetime(value, errors="coerce", utc=True)
        if pd.isna(parsed):
            return "N/A"
        return parsed.strftime("%b %d, %Y")


    def sortable_date(value):
        parsed = pd.to_datetime(value, errors="coerce", utc=True)
        return parsed if not pd.isna(parsed) else pd.Timestamp("1900-01-01", tz="UTC")


    def safe_url(value):
        value = str(value or "").strip()
        try:
            parsed = urlparse(value)
            return value if parsed.scheme in {"http", "https"} and parsed.netloc else ""
        except Exception:
            return ""


    def normalize_direct_record(item):
        """Normalize FMP-style records without inventing missing fields."""
        if not isinstance(item, dict):
            return None

        record = {
            "date": first_present(item, "publishedDate", "date", "gradingDate", "gradeTime", default="N/A"),
            "analyst": first_present(item, "analystName", "analyst", default="Not disclosed"),
            "firm": first_present(item, "gradingCompany", "newsPublisher", "company", "firm", default="Not disclosed"),
            "previous_rating": first_present(item, "previousGrade", "fromGrade", "previousRating", default="N/A"),
            "new_rating": first_present(item, "newGrade", "toGrade", "rating", default="N/A"),
            "price_target": to_float(first_present(item, "priceTarget", "adjPriceTarget", "newTarget", "target")),
            "source_url": safe_url(first_present(item, "newsURL", "url", "sourceURL", default="")),
            "source_title": first_present(item, "newsTitle", "title", default="FMP analyst feed"),
        }

        if record["firm"] == "Not disclosed" and record["analyst"] == "Not disclosed":
            return None
        if record["new_rating"] == "N/A" and record["price_target"] is None:
            return None
        return record


    ANALYST_FEED_SCHEMA = {
        "type": "object",
        "properties": {
            "records": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "date": {"type": "string", "description": "ISO date YYYY-MM-DD"},
                        "analyst": {"type": "string"},
                        "firm": {"type": "string"},
                        "previous_rating": {"type": "string"},
                        "new_rating": {"type": "string"},
                        "price_target": {
                            "type": ["number", "null"],
                            "description": "New price target in USD, or null when not published",
                        },
                        "source_url": {"type": "string"},
                        "source_title": {"type": "string"},
                    },
                    "required": [
                        "date", "analyst", "firm", "previous_rating", "new_rating",
                        "price_target", "source_url", "source_title"
                    ],
                },
            }
        },
        "required": ["records"],
    }


    def fetch_grounded_analyst_records():
        """Use Gemini Interactions API + Google Search to produce sourced firm-level rows."""
        global _GEMINI_GROUNDING_DISABLED, _GEMINI_GROUNDING_DISABLE_REASON
        if client is None:
            if _GEMINI_GROUNDING_DISABLED:
                print("Gemini Search skipped because grounding was disabled after a batch quota error.")
            else:
                print("Gemini Search skipped because GEMINI_API_KEY is unavailable.")
            return []

        prompt = f"""
    Search the live public web for recent SELL-SIDE Wall Street analyst rating and
    price-target actions for {company_name} ({TICKER_SYMBOL}) through {CURRENT_DATE}.

    Return up to 25 separate, individually attributable actions, newest first. Search
    reputable financial-news pages and public analyst-action reports. Prefer the last
    18 months, but extend to 24 months when needed to find enough records.

    Required fields:
    - date: exact action/publication date in YYYY-MM-DD
    - analyst: human analyst's full name; "Not disclosed" only when the firm is named but the person is not
    - firm: brokerage or sell-side research firm
    - previous_rating: exact prior rating, or "N/A" when not stated
    - new_rating: exact new/current rating, or "N/A" when only the target changed
    - price_target: newly published USD target as a number, or null when not stated
    - source_url: public page URL supporting that exact row
    - source_title: concise page title

    Strict rules:
    1. Return individual actions only, never aggregate consensus rows.
    2. Never infer or invent a person, firm, rating, date, or target.
    3. Never assign a consensus mean/high/low target to an individual analyst.
    4. Exclude crowd ratings, technical signals, anonymous forecasts, and AI predictions.
    5. Deduplicate the same analyst/firm/action/date.
    6. Every row must include a public source URL supporting the action.
    7. Return {{"records": []}} when no individually verifiable records are found.
    """

        print("Starting Gemini Google Search for individual analyst actions...")
        try:
            if not hasattr(client, "interactions"):
                raise RuntimeError(
                    "Installed google-genai SDK does not expose client.interactions. "
                    "Re-run the installation cell, then restart the Colab runtime once."
                )

            interaction = client.interactions.create(
                model="gemini-3.6-flash",
                input=prompt,
                tools=[{"type": "google_search"}],
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": ANALYST_FEED_SCHEMA,
                },
            )
            raw_text = interaction.output_text or ""
            if not raw_text.strip():
                print("Gemini Search returned no text.")
                return []
            payload = json.loads(raw_text)
            print(f"Gemini Search returned {len(payload.get('records', []))} candidate rows.")
        except Exception as exc:
            message = str(exc)
            print(f"Grounded analyst search failed: {type(exc).__name__}: {message}")
            if "429" in message or "RESOURCE_EXHAUSTED" in message or "too_many_requests" in message:
                _GEMINI_GROUNDING_DISABLED = True
                _GEMINI_GROUNDING_DISABLE_REASON = "429 quota/rate limit"
                print(
                    "Gemini quota/rate limit reached. Remaining grounded searches in "
                    "this batch will be skipped; fallback analyst data will be used."
                )
            elif "403" in message or "PERMISSION_DENIED" in message:
                print("Gemini API key lacks permission for this model/tool. Create the key in Google AI Studio and enable billing if required.")
            elif "interactions" in message.lower():
                print("Restart the Colab runtime after upgrading google-genai, then run all cells again.")
            return []

        grounded = []
        for item in payload.get("records", []):
            if not isinstance(item, dict):
                continue
            source_url = safe_url(item.get("source_url"))
            firm = str(item.get("firm") or "").strip()
            analyst = str(item.get("analyst") or "Not disclosed").strip()
            new_rating = str(item.get("new_rating") or "N/A").strip()
            target = to_float(item.get("price_target"))

            if not source_url or not firm:
                continue
            if new_rating == "N/A" and target is None:
                continue

            grounded.append({
                "date": str(item.get("date") or "N/A"),
                "analyst": analyst or "Not disclosed",
                "firm": firm,
                "previous_rating": str(item.get("previous_rating") or "N/A"),
                "new_rating": new_rating,
                "price_target": target,
                "source_url": source_url,
                "source_title": str(item.get("source_title") or urlparse(source_url).netloc),
            })
        return grounded



    TARGET_ONLY_SCHEMA = {
        "type": "object",
        "properties": {
            "records": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "date": {"type": "string", "description": "ISO date YYYY-MM-DD"},
                        "analyst": {"type": "string"},
                        "firm": {"type": "string"},
                        "previous_rating": {"type": "string"},
                        "new_rating": {"type": "string"},
                        "price_target": {"type": "number"},
                        "previous_price_target": {"type": ["number", "null"]},
                        "source_url": {"type": "string"},
                        "source_title": {"type": "string"},
                    },
                    "required": [
                        "date", "analyst", "firm", "previous_rating", "new_rating",
                        "price_target", "previous_price_target", "source_url", "source_title"
                    ],
                },
            }
        },
        "required": ["records"],
    }


    def fetch_grounded_target_records():
        """Second, target-specific search pass that returns only numeric targets."""
        global _GEMINI_GROUNDING_DISABLED, _GEMINI_GROUNDING_DISABLE_REASON
        if client is None or _GEMINI_GROUNDING_DISABLED:
            if _GEMINI_GROUNDING_DISABLED:
                print("Dedicated target search skipped because this batch already hit Gemini grounding quota.")
            return []

        prompt = f"""
    Search the live public web specifically for individually attributable SELL-SIDE
    price-target actions for {company_name} ({TICKER_SYMBOL}) through {CURRENT_DATE}.

    Return up to 25 recent rows, newest first, but include a row ONLY when a public
    source explicitly states a numeric USD price target for that firm or analyst.
    Search phrases such as:
    - {TICKER_SYMBOL} price target raised to
    - {company_name} analyst price target
    - brokerage maintains rating raises target {TICKER_SYMBOL}

    Required fields:
    - date: exact publication/action date, YYYY-MM-DD
    - analyst: full human analyst name, or "Not disclosed"
    - firm: sell-side brokerage/research firm
    - previous_rating: prior rating, or "N/A"
    - new_rating: current/new rating, or "N/A" if the article only states a target change
    - price_target: the exact newly published USD target as a number
    - previous_price_target: old target as a number, or null
    - source_url and source_title when exposed by the source

    Strict rules:
    1. Omit every row lacking an explicit numeric target.
    2. Never use aggregate mean/median/high/low consensus as an individual target.
    3. Never estimate, infer, currency-convert or split-adjust a target.
    4. Do not confuse EPS/revenue estimates with share-price targets.
    5. Deduplicate matching firm/date/target actions.
    6. Return {{"records": []}} if no explicit targets are found.
    """

        print("Starting dedicated Gemini Search for numeric analyst price targets...")
        try:
            interaction = client.interactions.create(
                model="gemini-3.6-flash",
                input=prompt,
                tools=[{"type": "google_search"}],
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": TARGET_ONLY_SCHEMA,
                },
            )
            payload = json.loads(interaction.output_text or "{}")
        except Exception as exc:
            message = str(exc)
            print(f"Target-only grounded search failed: {type(exc).__name__}: {message}")
            if "429" in message or "RESOURCE_EXHAUSTED" in message or "too_many_requests" in message:
                _GEMINI_GROUNDING_DISABLED = True
                _GEMINI_GROUNDING_DISABLE_REASON = "429 quota/rate limit"
                print("Remaining grounded searches in this batch will be skipped.")
            return []

        rows = []
        for item in payload.get("records", []):
            if not isinstance(item, dict):
                continue
            target = to_float(item.get("price_target"))
            firm = str(item.get("firm") or "").strip()
            if target is None or not firm:
                continue
            rows.append({
                "date": str(item.get("date") or "N/A"),
                "analyst": str(item.get("analyst") or "Not disclosed").strip(),
                "firm": firm,
                "previous_rating": str(item.get("previous_rating") or "N/A").strip(),
                "new_rating": str(item.get("new_rating") or "N/A").strip(),
                "price_target": target,
                "previous_price_target": to_float(item.get("previous_price_target")),
                "source_url": safe_url(item.get("source_url")),
                "source_title": str(item.get("source_title") or "Gemini Google Search grounded result"),
            })
        print(f"Dedicated target search returned {len(rows)} target-bearing rows.")
        return rows


    def canonical_firm(value):
        """Normalize common brokerage-name variants for record matching only."""
        name = str(value or "").strip().lower()
        for token in [",", ".", " inc", " llc", " ltd", " securities", " capital markets", " research"]:
            name = name.replace(token, "")
        aliases = {
            "b of a": "bank of america",
            "bofa": "bank of america",
            "bofa global": "bank of america",
            "keybanc": "keybank",
            "key bank": "keybank",
            "rbc": "rbc",
            "rbc capital": "rbc",
            "jpmorgan": "jp morgan",
            "j p morgan": "jp morgan",
            "goldman": "goldman sachs",
            "citi": "citigroup",
        }
        name = " ".join(name.split())
        return aliases.get(name, name)


    def completeness(record):
        return sum([
            str(record.get("analyst") or "").strip() not in {"", "Not disclosed"},
            str(record.get("previous_rating") or "").strip() not in {"", "N/A"},
            str(record.get("new_rating") or "").strip() not in {"", "N/A"},
            record.get("price_target") is not None,
            record.get("previous_price_target") is not None,
            bool(record.get("source_url")),
        ])


    def records_match(left, right):
        """Match rows describing the same firm action so target-only data can enrich ratings."""
        if normalized_date(left.get("date")) != normalized_date(right.get("date")):
            return False
        if canonical_firm(left.get("firm")) != canonical_firm(right.get("firm")):
            return False
        left_analyst = str(left.get("analyst") or "Not disclosed").strip().lower()
        right_analyst = str(right.get("analyst") or "Not disclosed").strip().lower()
        return (
            left_analyst == right_analyst
            or left_analyst in {"", "not disclosed"}
            or right_analyst in {"", "not disclosed"}
        )


    def merge_analyst_records(records):
        """Merge rating-only and target-only rows without inventing missing values."""
        merged = []
        for incoming in records:
            match = next((row for row in merged if records_match(row, incoming)), None)
            if match is None:
                merged.append(dict(incoming))
                continue

            for field, missing_values in {
                "analyst": {None, "", "Not disclosed"},
                "previous_rating": {None, "", "N/A"},
                "new_rating": {None, "", "N/A"},
                "source_url": {None, ""},
                "source_title": {None, "", "Source"},
            }.items():
                if match.get(field) in missing_values and incoming.get(field) not in missing_values:
                    match[field] = incoming.get(field)

            if match.get("price_target") is None and incoming.get("price_target") is not None:
                match["price_target"] = incoming.get("price_target")
            if match.get("previous_price_target") is None and incoming.get("previous_price_target") is not None:
                match["previous_price_target"] = incoming.get("previous_price_target")
        return merged

    def fetch_yahoo_fallback_records():
        """Last-resort firm-level actions. Yahoo generally lacks analyst names and targets."""
        try:
            frame = stock.get_upgrades_downgrades()
        except Exception as exc:
            print(f"Yahoo upgrades/downgrades fallback failed: {exc}")
            return []
        if frame is None or frame.empty:
            return []

        frame = frame.reset_index()
        rows = []
        for _, row in frame.head(20).iterrows():
            row_dict = row.to_dict()
            date_value = first_present(row_dict, "GradeDate", "date", "Date", "index", default="N/A")
            firm = first_present(row_dict, "Firm", "firm", default="Not disclosed")
            new_rating = first_present(row_dict, "ToGrade", "toGrade", default="N/A")
            previous_rating = first_present(row_dict, "FromGrade", "fromGrade", default="N/A")
            if firm == "Not disclosed" or new_rating == "N/A":
                continue
            rows.append({
                "date": str(date_value),
                "analyst": "Not disclosed",
                "firm": str(firm),
                "previous_rating": str(previous_rating),
                "new_rating": str(new_rating),
                "price_target": None,
                "source_url": "",
                "source_title": "Yahoo Finance upgrades/downgrades",
            })
        return rows


    analyst_records = []
    for raw_item in fmp_grades:
        normalized = normalize_direct_record(raw_item)
        if normalized:
            analyst_records.append(normalized)

    # Run both searches: one broad rating/action pass and one stricter numeric-target pass.
    grounded_records = fetch_grounded_analyst_records()
    target_records = fetch_grounded_target_records()
    yahoo_records = fetch_yahoo_fallback_records()

    analyst_records.extend(yahoo_records)
    analyst_records.extend(grounded_records)
    analyst_records.extend(target_records)
    analyst_records = merge_analyst_records(analyst_records)

    # Final exact deduplication after enrichment.
    deduped = {}
    for record in analyst_records:
        key = (
            normalized_date(record.get("date")),
            str(record.get("analyst") or "").strip().lower(),
            str(record.get("firm") or "").strip().lower(),
            str(record.get("new_rating") or "").strip().lower(),
            record.get("price_target"),
        )
        existing = deduped.get(key)
        if existing is None or completeness(record) > completeness(existing):
            deduped[key] = record

    analyst_records = sorted(
        deduped.values(),
        key=lambda item: sortable_date(item.get("date")),
        reverse=True,
    )[:15]

    # Statistics from the actual individually collected target-bearing rows.
    collected_target_values = [
        float(record["price_target"])
        for record in analyst_records
        if isinstance(record.get("price_target"), (int, float))
    ]
    if collected_target_values:
        collected_target_series = pd.Series(collected_target_values, dtype="float64")
        collected_target_count = int(collected_target_series.count())
        collected_target_mean = float(collected_target_series.mean())
        collected_target_median = float(collected_target_series.median())
        collected_target_high = float(collected_target_series.max())
        collected_target_low = float(collected_target_series.min())
    else:
        collected_target_count = 0
        collected_target_mean = None
        collected_target_median = None
        collected_target_high = None
        collected_target_low = None

    # Published consensus is preferred. If unavailable, use the mean of individually
    # collected target actions and label it clearly as a calculated sample.
    published_consensus_available = not target_is_model_fallback and raw_target_mean is not None
    combined_target_mean = raw_target_mean if published_consensus_available else collected_target_mean
    combined_target_median = target_median if published_consensus_available else collected_target_median
    combined_target_high = (
        normalize_per_share_quote(yahoo_price_targets.get("high")) if published_consensus_available else collected_target_high
    )
    combined_target_low = (
        normalize_per_share_quote(yahoo_price_targets.get("low")) if published_consensus_available else collected_target_low
    )
    combined_target_source = (
        "Published Yahoo analyst-price-target consensus"
        if published_consensus_available
        else "Calculated from target-bearing rows collected in this report"
    )

    def money_or_na(value):
        return f"${value:,.2f}" if isinstance(value, (int, float)) else "N/A"

    combined_upside = (
        ((combined_target_mean - current_price) / current_price) * 100
        if isinstance(combined_target_mean, (int, float)) and current_price
        else None
    )
    analyst_rows_html = ""
    for record in analyst_records:
        date_text = escape(normalized_date(record.get("date")))
        analyst_text = escape(str(record.get("analyst") or "Not disclosed"))
        firm_text = escape(str(record.get("firm") or "Not disclosed"))
        previous_text = escape(str(record.get("previous_rating") or "N/A"))
        new_text = escape(str(record.get("new_rating") or "N/A"))
        target = record.get("price_target")
        previous_target = record.get("previous_price_target")
        target_text = f"${target:,.2f}" if isinstance(target, (int, float)) else "N/A"
        if isinstance(previous_target, (int, float)):
            target_text += f'<br><span style="font-size:11px; color:#777;">Prev: ${previous_target:,.2f}</span>'
        source_url = safe_url(record.get("source_url"))
        source_title = escape(str(record.get("source_title") or "Source"))
        source_html = (
            f'<br><a href="{escape(source_url, quote=True)}" target="_blank" rel="noopener" '
            f'style="font-size:11px; font-weight:normal;">Source: {source_title}</a>'
            if source_url else
            '<br><span style="font-size:11px; color:#777; font-weight:normal;">Source URL unavailable</span>'
        )

        rating_upper = str(record.get("new_rating") or "").upper()
        if any(word in rating_upper for word in ["BUY", "OUTPERFORM", "OVERWEIGHT", "STRONG", "POSITIVE"]):
            row_class = "buy"
        elif any(word in rating_upper for word in ["SELL", "UNDERPERFORM", "UNDERWEIGHT", "NEGATIVE", "REDUCE"]):
            row_class = "sell"
        else:
            row_class = "hold"

        analyst_rows_html += f"""
        <tr>
            <td class="metric-name">{date_text}</td>
            <td style="font-weight:bold; color:#002060;">{analyst_text}</td>
            <td style="font-weight:bold;">{firm_text}{source_html}</td>
            <td>{previous_text}</td>
            <td><span class="{row_class}">{new_text}</span></td>
            <td style="font-weight:bold;">{target_text}</td>
        </tr>
        """

    analyst_count_found = len(analyst_records)
    if analyst_count_found == 0:
        analyst_rows_html = """
        <tr>
            <td colspan="6" style="text-align:center; color:#666; font-style:italic; padding:20px;">
                No individually verifiable analyst actions were returned. Check GEMINI_API_KEY and its Google Search grounding quota.
            </td>
        </tr>
        """

    print(
        f"Compiled {analyst_count_found} individual analyst records; "
        f"{collected_target_count} contain explicit numeric targets "
        f"({len(target_records)} from the dedicated target search)."
    )



    # ==========================================
    # 7. COMPACT HTML REPORT GENERATOR
    # ==========================================
    # Keep the displayed HTML report intentionally concise. More detailed calculations
    # remain in the background and are used only to produce the valuation outputs.

    consensus_mean_display = combined_target_mean
    consensus_median_display = combined_target_median
    consensus_high_display = combined_target_high
    consensus_low_display = combined_target_low

    html_content = f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>{TICKER_SYMBOL} Compact Institutional Report v8.3</title>
        <style>
            body {{ font-family: 'Segoe UI', Arial, sans-serif; background:#f4f7f6; color:#333; margin:0; padding:24px; }}
            .container {{ max-width:1080px; margin:auto; background:#fff; padding:34px; border-radius:8px; box-shadow:0 3px 14px rgba(0,0,0,.08); }}
            h1 {{ color:#002060; border-bottom:3px solid #1F4E78; padding-bottom:10px; margin:0; font-size:27px; }}
            h2 {{ color:#1F4E78; margin-top:32px; border-bottom:1px solid #ccd4dc; padding-bottom:6px; font-size:19px; }}
            .header {{ display:flex; justify-content:space-between; gap:20px; margin:20px 0; background:#f8f9fa; padding:16px; border-left:5px solid #1F4E78; border-radius:5px; }}
            .header p {{ margin:5px 0; }}
            .price {{ font-size:25px; font-weight:700; color:#002060; }}
            .summary-grid {{ display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin:14px 0; }}
            .card {{ background:#f8fafc; border:1px solid #e0e6eb; border-radius:6px; padding:12px; text-align:center; }}
            .card .label {{ color:#68737d; font-size:10px; text-transform:uppercase; letter-spacing:.4px; }}
            .card .value {{ color:#002060; font-weight:700; font-size:18px; margin-top:5px; }}
            table {{ width:100%; border-collapse:collapse; margin-top:12px; font-size:12.5px; }}
            th, td {{ padding:10px 11px; text-align:left; border-bottom:1px solid #e7ebef; vertical-align:top; }}
            th {{ background:#002060; color:#fff; text-transform:uppercase; font-size:10.5px; letter-spacing:.4px; }}
            tr:nth-child(even) {{ background:#fcfcfc; }}
            .metric-name {{ font-weight:700; color:#1F4E78; }}
            .buy {{ color:#155724; font-weight:700; background:#d4edda; padding:4px 8px; border-radius:4px; display:inline-block; }}
            .sell {{ color:#721c24; font-weight:700; background:#f8d7da; padding:4px 8px; border-radius:4px; display:inline-block; }}
            .hold {{ color:#856404; font-weight:700; background:#fff3cd; padding:4px 8px; border-radius:4px; display:inline-block; }}
            .note {{ background:#fff8df; border-left:4px solid #c59b22; padding:10px 13px; font-size:11.5px; margin-top:12px; }}
            a {{ color:#1F4E78; text-decoration:none; }}
            @media(max-width:760px) {{ .summary-grid {{ grid-template-columns:repeat(2,1fr); }} .header {{ flex-direction:column; }} }}
        </style>
    </head>
    <body>
    <div class="container">
        <h1>{TICKER_SYMBOL} - Institutional Valuation Report</h1>
        <div class="header">
            <div>
                <p><strong>Company:</strong> {escape(str(company_name))}</p>
                <p><strong>Industry:</strong> {escape(str(industry))}</p>
                <p><strong>Valuation framework:</strong> {escape(methodology)}</p>
            </div>
            <div style="text-align:right;">
                <p class="price">Current Price: {fmt_money(current_price)}</p>
                <p><strong>Date:</strong> {CURRENT_DATE}</p>
            </div>
        </div>

        <h2>1. Core Valuation & Buy-In Zones</h2>
        <table>
            <tr><th>Valuation Metric</th><th>Value</th><th>Recommended Buy-In Zone</th><th>Interpretation</th></tr>
            <tr>
                <td class="metric-name">Independent Model Fair Value</td>
                <td><strong>{fmt_money(intrinsic_value)}</strong></td>
                <td>{fmt_money(accumulation_zone)}</td>
                <td>Independent sector-specific DCF and peer-relative valuation; analyst price targets are excluded.</td>
            </tr>
            <tr>
                <td class="metric-name">Bear / Base / Bull Range</td>
                <td>{fmt_money(fair_value_low)} / {fmt_money(intrinsic_value)} / {fmt_money(fair_value_high)}</td>
                <td>{fmt_money(accumulation_zone)}</td>
                <td>Scenario range generated from the same independent architecture with different growth, margin, multiple and discount-rate assumptions.</td>
            </tr>
            <tr>
                <td class="metric-name">Published Analyst Mean Target</td>
                <td>{money_or_na(consensus_mean_display)}</td>
                <td>{money_or_na(consensus_mean_display * 0.80 if isinstance(consensus_mean_display, (int, float)) else None)}</td>
                <td>{escape(combined_target_source)}.</td>
            </tr>
            <tr>
                <td class="metric-name">Conservative Entry (Strong Buy)</td>
                <td>{fmt_money(high_conviction_zone)}</td>
                <td><strong>Below {fmt_money(high_conviction_zone)}</strong></td>
                <td>Uses the lower of a deep discount to fair value and the downside scenario.</td>
            </tr>
            <tr>
                <td class="metric-name">Quantitative Model Rating</td>
                <td colspan="2"><span class="{rating_class}">{model_rating}</span></td>
                <td>Based on the independent model fair value relative to the current price.</td>
            </tr>
        </table>
        <div class="note"><strong>Architecture:</strong> {escape(valuation_archetype)}. Analyst price-target weight: 0%. FY1/FY2 operating-estimate weight: {operating_estimate_weight:.0%}. Model versus Street: {escape(street_comparison)}.</div>

        <h2>2. Wall Street Analyst Consensus & Recent Actions</h2>
        <div class="summary-grid">
            <div class="card"><div class="label">Mean Target</div><div class="value">{money_or_na(consensus_mean_display)}</div></div>
            <div class="card"><div class="label">Median Target</div><div class="value">{money_or_na(consensus_median_display)}</div></div>
            <div class="card"><div class="label">High / Low</div><div class="value">{money_or_na(consensus_high_display)} / {money_or_na(consensus_low_display)}</div></div>
            <div class="card"><div class="label">Analyst Count</div><div class="value">{consensus_analyst_count or 'N/A'}</div></div>
        </div>
        <table>
            <tr><th>Date</th><th>Analyst</th><th>Firm</th><th>Previous Rating</th><th>New Rating</th><th>Price Target</th></tr>
            {analyst_rows_html}
        </table>

        <h2>3. Technical Analysis & Momentum Indicators</h2>
        <table>
            <tr><th>Technical Indicator</th><th>Current Value</th><th>Type</th><th>How to Use</th></tr>
            <tr><td class="metric-name">Resistance 1 (R1)</td><td>{fmt_money(r1)}</td><td>Ceiling</td><td>Short-term resistance and potential profit-taking area.</td></tr>
            <tr><td class="metric-name">Support 1 (S1)</td><td>{fmt_money(s1)}</td><td>Floor</td><td>First tactical support area for staged entries.</td></tr>
            <tr><td class="metric-name">9-Day EMA</td><td>{fmt_money(ema_9)}</td><td>Fast Trend</td><td>Short-term momentum reference.</td></tr>
            <tr><td class="metric-name">20-Day EMA</td><td>{fmt_money(ema_20)}</td><td>Pullback Zone</td><td>Common pullback reference during an active trend.</td></tr>
            <tr><td class="metric-name">50-Day SMA</td><td>{fmt_money(sma_50)}</td><td>Medium Trend</td><td>Intermediate institutional trend reference.</td></tr>
            <tr><td class="metric-name">200-Day SMA</td><td>{fmt_money(sma_200)}</td><td>Macro Trend</td><td>Long-term trend and regime reference.</td></tr>
            <tr><td class="metric-name">14-Day RSI</td><td><span class="{rsi_class}">{rsi_14:.1f}</span></td><td>Oscillator</td><td>Below 30 is oversold; above 70 is overbought.</td></tr>
        </table>

        <h2>4. Extended Fundamental Health Metrics</h2>
        <table>
            <tr><th>Metric</th><th>Value</th><th>Reference</th><th>Interpretation</th></tr>
            <tr><td class="metric-name">Trailing P/E</td><td>{fmt_multiple(trailing_pe)}</td><td>Sector dependent</td><td>Use cautiously for cyclical or loss-making businesses.</td></tr>
            <tr><td class="metric-name">Forward P/E</td><td>{fmt_multiple(fwd_pe)}</td><td>Sector dependent</td><td>More relevant when forward EPS estimates are positive and credible.</td></tr>
            <tr><td class="metric-name">PEG Ratio</td><td>{fmt_multiple(peg_ratio, 2)}</td><td>About 1.0x-2.0x</td><td>Less useful for highly cyclical or negative-earnings companies.</td></tr>
            <tr><td class="metric-name">Price-to-Sales</td><td>{fmt_multiple(ps_ratio, 2)}</td><td>Industry dependent</td><td>Important for high-growth firms when earnings are not yet normalized.</td></tr>
            <tr><td class="metric-name">EV / EBITDA</td><td>{fmt_multiple(ev_ebitda)}</td><td>Industry dependent</td><td>Useful for capital-intensive and cyclical businesses.</td></tr>
            <tr><td class="metric-name">Debt-to-Equity</td><td>{fmt_multiple((debt_to_equity / 100) if debt_to_equity else 0, 2)}</td><td>Lower is safer</td><td>Measures financial leverage and balance-sheet risk.</td></tr>
            <tr><td class="metric-name">Operating Margin</td><td>{fmt_pct(current_operating_margin)}</td><td>Higher is better</td><td>Measures current operating profitability.</td></tr>
        </table>

        <div class="note"><strong>Important:</strong> This automated model uses public data only.</div>
    </div>
    </body>
    </html>
    """

    output_dir = os.path.abspath(output_dir or os.getcwd())
    os.makedirs(output_dir, exist_ok=True)
    html_path = os.path.join(output_dir, f"{TICKER_SYMBOL}_AI_Valuation_Report_v8_3.html")
    with open(html_path, "w", encoding="utf-8") as file:
        file.write(html_content)


    print(f"HTML report successfully generated: {html_path}")
    return os.path.abspath(html_path)


# ==========================================
# MULTI-TICKER BATCH INPUT & EXECUTION
# ==========================================
# Enter one ticker or multiple comma-separated tickers. Whitespace, lowercase,
# duplicates and blank entries are handled automatically.
TICKER_INPUT = "MU, BE, MSFT, GOOG, ASML, AMD, RMBS, TSM, SNDK, IREN, SIMO, FORM, AMAT, LRCX"

# Colab browsers can block several simultaneous automatic downloads. By default,
# the script creates one full HTML report per ticker and downloads a single ZIP
# containing all reports. Set this to True to also trigger separate downloads.
DOWNLOAD_INDIVIDUAL_REPORTS = False
DOWNLOAD_BATCH_ZIP = True


def parse_ticker_input(raw_value):
    """Parse, normalize and deduplicate a comma-separated ticker string."""
    if isinstance(raw_value, (list, tuple, set)):
        candidates = raw_value
    else:
        candidates = str(raw_value or "").split(",")

    tickers = []
    seen = set()
    for candidate in candidates:
        ticker = str(candidate).strip().upper()
        if not ticker:
            continue
        # Permit common Yahoo symbols such as BRK-B, BF-B, ^TNX and BTC-USD.
        if not all(character.isalnum() or character in {"-", ".", "^", "="} for character in ticker):
            print(f"Skipping invalid ticker entry: {candidate!r}")
            continue
        if ticker not in seen:
            seen.add(ticker)
            tickers.append(ticker)
    return tickers


def run_batch(ticker_input, output_dir=None):
    """Generate one independent HTML report per ticker and return file paths."""
    import zipfile

    output_dir = os.path.abspath(output_dir or os.getcwd())
    os.makedirs(output_dir, exist_ok=True)
    tickers = parse_ticker_input(ticker_input)
    if not tickers:
        raise ValueError("No valid ticker symbols were supplied. Use a comma-separated value such as 'MU, BE, MSFT'.")

    print(f"Preparing {len(tickers)} report(s): {', '.join(tickers)}")
    generated_paths = []
    failures = []

    for position, ticker in enumerate(tickers, start=1):
        print("\n" + "=" * 72)
        print(f"[{position}/{len(tickers)}] Generating report for {ticker}")
        print("=" * 72)
        try:
            report_path = generate_report(ticker, output_dir=output_dir)
            generated_paths.append(report_path)
            print(f"Completed {ticker}: {report_path}")
            if DOWNLOAD_INDIVIDUAL_REPORTS:
                files.download(report_path)
        except Exception as exc:
            failures.append((ticker, f"{type(exc).__name__}: {exc}"))
            print(f"FAILED {ticker}: {type(exc).__name__}: {exc}")

    if not generated_paths:
        failure_text = "; ".join(f"{ticker}: {message}" for ticker, message in failures)
        raise RuntimeError(f"No reports were generated. {failure_text}")

    zip_path = None
    if len(generated_paths) == 1 and not DOWNLOAD_INDIVIDUAL_REPORTS:
        # For a single ticker, download the HTML directly rather than wrapping it in a ZIP.
        files.download(generated_paths[0])
    elif DOWNLOAD_BATCH_ZIP:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        zip_path = os.path.join(output_dir, f"AI_Valuation_Reports_{timestamp}.zip")
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for report_path in generated_paths:
                archive.write(report_path, arcname=os.path.basename(report_path))
            if failures:
                failure_path = os.path.join(output_dir, "report_generation_failures.txt")
                with open(failure_path, "w", encoding="utf-8") as failure_file:
                    for ticker, message in failures:
                        failure_file.write(f"{ticker}: {message}\n")
                archive.write(failure_path, arcname=os.path.basename(failure_path))
                try:
                    os.remove(failure_path)
                except OSError:
                    pass
        print(f"\nBatch ZIP successfully generated: {zip_path}")
        files.download(zip_path)

    print("\nBatch summary")
    print(f"Successful: {len(generated_paths)}")
    print(f"Failed: {len(failures)}")
    for path in generated_paths:
        print(f"  HTML: {path}")
    for ticker, message in failures:
        print(f"  ERROR {ticker}: {message}")

    return {
        "tickers": tickers,
        "reports": generated_paths,
        "zip": zip_path,
        "failures": failures,
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Generate institutional stock valuation HTML reports.")
    parser.add_argument(
        "--tickers",
        help="One ticker or a comma-separated list. If omitted, the configured TICKER_INPUT batch is used.",
    )
    parser.add_argument(
        "--output-dir",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports"),
        help="Directory for generated HTML and ZIP files.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print a machine-readable result marker for the WhatsApp agent.",
    )
    args = parser.parse_args()

    batch_result = run_batch(args.tickers or TICKER_INPUT, output_dir=args.output_dir)
    if args.json:
        print("REPORT_RESULT_JSON=" + json.dumps(batch_result))
