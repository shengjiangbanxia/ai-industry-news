from datetime import datetime
from unittest.mock import patch

from scripts.update_news import maybe_fetch_x_api_updates, update_paid_source_state


def test_x_daily_delayed_attempt_is_persisted_and_rolls_over_at_beijing_midnight():
    state = {"sources": {}}
    env = {"X_BEARER_TOKEN": "test", "X_API_FIRST_RUN_DAILY": "1"}
    with patch.dict("os.environ", env, clear=True), patch(
        "scripts.update_news.fetch_x_api_recent_search", return_value=[]
    ) as fetch:
        now = datetime.fromisoformat("2026-11-21T07:48:00+00:00")
        _, status = maybe_fetch_x_api_updates(None, now, state)
        assert status["attempted"] and status["ok"]
        update_paid_source_state(state, "x_api", status, now)
        _, skipped = maybe_fetch_x_api_updates(None, datetime.fromisoformat("2026-11-21T15:59:00+00:00"), state)
        assert skipped["skip_reason"] == "already_attempted_today"
        assert fetch.call_count == 1
        maybe_fetch_x_api_updates(None, datetime.fromisoformat("2026-11-21T16:00:00+00:00"), state)
        assert fetch.call_count == 2


def test_x_daily_failed_attempt_skips_retries_unless_forced():
    state = {"sources": {}}
    now = datetime.fromisoformat("2026-11-21T07:48:00+00:00")
    with patch.dict("os.environ", {"X_BEARER_TOKEN": "test", "X_API_FIRST_RUN_DAILY": "1"}, clear=True), patch(
        "scripts.update_news.fetch_x_api_recent_search", side_effect=RuntimeError
    ) as fetch:
        _, status = maybe_fetch_x_api_updates(None, now, state)
        update_paid_source_state(state, "x_api", status, now)
        assert not status["ok"]
        _, skipped = maybe_fetch_x_api_updates(None, now, state)
        assert skipped["skipped"]
        assert fetch.call_count == 1
        with patch.dict("os.environ", {"X_API_FORCE_RUN": "1"}):
            maybe_fetch_x_api_updates(None, now, state)
        assert fetch.call_count == 2
