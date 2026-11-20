"""Checks for the journal's tags and accounting. Run: uv run pytest tests/test_journal.py"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from journal import HINDSIGHT, Trade, tag  # noqa: E402


def trade(side="yes", price=0.30, result="no", **kw):
    t = Trade("live", 0.0, "T", side, price, 1.0, 0.04, 0.34, 300.0, 100.0, result, None)
    for k, v in kw.items():
        setattr(t, k, v)
    return t


def test_up_after_sharp_drop_is_against_trend():
    got = tag(trade(ret_6h=-0.02), None)
    assert "up_after_6h_drop" in got and "against_6h_trend" in got and "with_6h_trend" not in got


def test_down_in_a_drop_is_with_trend():
    got = tag(trade(side="no", ret_6h=-0.02), None)
    assert "with_6h_trend" in got and "up_after_6h_drop" not in got


def test_flat_market_has_no_trend_tag():
    got = tag(trade(ret_6h=0.001), None)
    assert not {"with_6h_trend", "against_6h_trend"} & set(got)


def test_lost_after_leading_needs_a_loss():
    assert "lost_after_leading" in tag(trade(bid_2m=0.8), None)
    assert "lost_after_leading" not in tag(trade(result="yes", bid_2m=0.8), None)


def test_down_side_wins_on_no():
    t = trade(side="no", price=0.40, result="no")
    assert t.won == 1
    assert t.cents == pytest.approx(1 - 0.40 - 0.07 * 0.4 * 0.6)


def test_sold_fill_is_judged_as_held_and_hindsight_only():
    t = trade(result="yes", sold=True)  # sold, then the side it held won: counted as the win holding would have been
    assert "sold_early" in tag(t, None) and "sold_early" in HINDSIGHT
    assert t.won == 1
