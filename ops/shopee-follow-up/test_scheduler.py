import unittest
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory

import scheduler


class ScheduleTest(unittest.TestCase):
    def setUp(self):
        self.batch = {"id": "mats-01", "name": "第一批", "launchDate": "2026-11-19", "products": [{"id": "11", "name": "甲"}, {"id": "22", "name": "乙"}]}
        self.state = {"batches": {"mats-01": self.batch}, "results": {}, "errors": {}}

    def time(self, value):
        return datetime.fromisoformat(value).replace(tzinfo=scheduler.TAIPEI)

    def data(self, today, rows):
        return {"day": today, "shop": scheduler.SHOP, "period": "past7days", "capturedAt": f"{today}T10:05:00+08:00", "rows": rows}

    def test_requested_days_and_count_based_rates(self):
        self.assertEqual(scheduler.report_days(self.batch), {"2026-11-23": 3, "2026-11-27": 7, "2026-12-04": 14})
        self.assertEqual(scheduler.tick(self.state, self.time("2026-11-23T09:59:00"))["ids"], [])
        now = self.time("2026-11-23T10:05:00")
        self.assertEqual(scheduler.tick(self.state, now)["ids"], ["11", "22"])
        payload = self.data("2026-11-23", [{"id": "11", "impressions": 200, "clicks": 10, "visitors": 8, "confirmedBuyers": 2, "confirmedOrders": 2, "paidOrders": 0}])
        self.assertTrue(scheduler.accept(self.state, payload, now)["accepted"])
        self.assertFalse(scheduler.accept(self.state, payload, now)["accepted"])
        summary = self.state["results"]["2026-11-23"]["mats-01"]
        self.assertEqual((summary["reported"], summary["registered"], summary["ctr"], summary["cvr"]), (1, 2, 0.05, 0.25))
        self.assertEqual(summary["totals"]["paidOrders"], 0)
        self.assertIsNone(summary["items"][1]["metrics"])

    def test_missed_date_kept_and_new_batch_grouped(self):
        now = self.time("2026-11-27T10:05:00")
        events = {"shop": scheduler.SHOP, "shopId": scheduler.SHOP_ID, "rows": [
            {"id": "33", "name": "丙", "draftId": "3", "batch": "follow-up", "listedAt": "2026-11-23T10:45:00+08:00"},
            {"id": "44", "name": "丁", "draftId": "4", "batch": "follow-up", "listedAt": "2026-11-23T11:00:00+08:00"},
        ]}
        scheduler.add_events(self.state, events)
        scheduler.add_events(self.state, events)
        self.assertEqual(scheduler.tick(self.state, now)["ids"], ["11", "22", "33", "44"])
        self.assertTrue(self.state["results"]["2026-11-23"]["mats-01"]["problem"])
        with self.assertRaises(ValueError):
            scheduler.accept(self.state, self.data("2026-11-23", []), now)
        with TemporaryDirectory() as directory:
            root = Path(directory)
            first = scheduler.update_reports(root, self.state)
            self.assertEqual(scheduler.update_reports(root, self.state), first)
            self.assertIn("当日缺数", (root / "reports/2026-11-23.md").read_text())


if __name__ == "__main__":
    unittest.main()
