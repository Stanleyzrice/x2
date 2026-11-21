#!/usr/bin/env python3
"""NAS-owned schedule and reports for the cheeroutdoor launch cohorts."""

import argparse
import fcntl
import hashlib
import json
import os
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


TAIPEI = ZoneInfo("Asia/Taipei")
SHOP = "cheeroutdoor"
SHOP_ID = "1554182542"
REPORT_HOUR = 10
CHECKPOINTS = (3, 7, 14)
FIELDS = ("impressions", "clicks", "visitors", "cartBuyers", "confirmedBuyers", "paidOrders", "confirmedOrders")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def report_days(batch):
    launch = date.fromisoformat(batch["launchDate"])
    return {str(launch + timedelta(days=days + 1)): days for days in CHECKPOINTS}


def local_time(value):
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("时间缺少时区")
    return stamp.astimezone(TAIPEI)


def add_events(state, incoming):
    if incoming.get("shop") != SHOP or incoming.get("shopId") != SHOP_ID or not isinstance(incoming.get("rows"), list):
        raise ValueError("上架回执店铺或结构不匹配")
    batches = state["batches"]
    known = {p["id"] for batch in batches.values() for p in batch["products"]}
    for item in incoming["rows"]:
        product = item["id"]
        if not re.fullmatch(r"[0-9]+", product) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", item["batch"]):
            raise ValueError("上架回执商品或批次编号无效")
        if product in known:
            continue
        launch = str(local_time(item["listedAt"]).date())
        key = f'{launch}:{item["batch"]}'
        batch = batches.setdefault(key, {"id": key, "launchDate": launch, "name": f'{launch} 新品批 {item["batch"][:12]}', "products": []})
        batch["products"].append({"id": product, "name": str(item["name"]), "draftId": str(item["draftId"])})
        known.add(product)


def schedule(state):
    calendar = {}
    for key, batch in state["batches"].items():
        for day, age in report_days(batch).items():
            calendar.setdefault(day, {})[key] = age
    return calendar


def rate(items, top, bottom):
    paired = [item for item in items if item.get(top) is not None and item.get(bottom) is not None]
    denominator = sum(item[bottom] for item in paired)
    return sum(item[top] for item in paired) / denominator if denominator else None


def summarize(batch, age, rows, captured=None, problem=None):
    items = [{**p, "metrics": rows.get(p["id"])} for p in batch["products"]]
    present = [item["metrics"] for item in items if item["metrics"] is not None]
    totals = {}
    for field in FIELDS:
        values = [item[field] for item in present if item[field] is not None]
        totals[field] = sum(values) if values else None
    return {
        "id": batch["id"], "name": batch["name"], "launchDate": batch["launchDate"], "age": age,
        "capturedAt": captured, "problem": problem, "registered": len(items), "reported": len(present),
        "totals": totals, "ctr": rate(present, "clicks", "impressions"), "cvr": rate(present, "confirmedBuyers", "visitors"),
        "items": items,
    }


def tick(state, now):
    """A missed date keeps its actual missing status, even after the collector returns."""
    today = str(now.date())
    due = {}
    for day, batches in sorted(schedule(state).items()):
        if day > today or day == today and now.hour < REPORT_HOUR:
            continue
        records = state["results"].setdefault(day, {})
        for key, age in batches.items():
            if key in records:
                continue
            batch = state["batches"][key]
            if day < today:
                error = state["errors"].get(day, "当日没有收到已登录浏览器的数据。")
                records[key] = summarize(batch, age, {}, problem=error)
            else:
                due[key] = age
    return {"day": today, "ids": sorted({p["id"] for key in due for p in state["batches"][key]["products"]})}


def validated_rows(rows, requested):
    output = {}
    for row in rows:
        key = row["id"]
        if key not in requested or key in output:
            raise ValueError("表现回执存在重复或请求范围外商品")
        values = {field: row.get(field) for field in FIELDS}
        if any(value is not None and (type(value) is not int or value < 0) for value in values.values()):
            raise ValueError("计数必须为非负整数或缺失值")
        output[key] = values
    return output


def accept(state, body, now, baseline=False):
    captured = local_time(body["capturedAt"])
    day = str(captured.date())
    if body.get("shop") != SHOP or body.get("period") != "past7days" or day != body.get("day") or captured.date() != now.date():
        raise ValueError("表现回执与当日滚动窗口不匹配")
    batches = state["batches"]
    result = state["results"].setdefault(day, {})
    due = {key: None for key in batches} if baseline else {
        key: age for key, age in schedule(state).get(day, {}).items() if key not in result
    }
    if not baseline and (captured.hour < REPORT_HOUR or not due):
        return {"accepted": False}
    ids = {p["id"] for key in due for p in batches[key]["products"]}
    rows = validated_rows(body["rows"], ids)
    summary = {key: summarize(batches[key], age, rows, captured.isoformat()) for key, age in due.items()}
    if baseline:
        return {"batches": list(summary.values())}
    result.update(summary)
    state["errors"].pop(day, None)
    return {"accepted": True, "day": day}


def markdown(day, records):
    def count(value):
        return "—" if value is None else f"{value:,}"

    def pct(value):
        return "—" if value is None else f"{value:.2%}"

    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", " ").replace("\r", " ")

    lines = [f"# cheeroutdoor 批次报告 {day}", "", "台北时间。Shopee 商品表现近 7 天滚动窗口。第 3 天复查前的上架日数据也可能计入。",
             "CTR（商品卡点击率）＝点击 ÷ 曝光。CVR（确认购买转化率）＝确认订单买家数 ÷ 商品访客。— 表示缺数或分母为零。",
             "访客和订单按商品汇总，跨商品可重复。",
             "", "| 批次 | 复查 | 有数据／登记 | 曝光 | 点击 | CTR | 商品访客 | 加购 | CVR | 确认单 | 付款单 |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    messages = []
    for row in records:
        t = row["totals"]
        age = f'第 {row["age"]} 天' if row["age"] else "起始基线"
        coverage = f'{row["reported"]}/{row["registered"]}'
        lines.append(f'| {cell(row["name"])} | {age} | {coverage} | {count(t["impressions"])} | {count(t["clicks"])} | {pct(row["ctr"])} | {count(t["visitors"])} | {count(t["cartBuyers"])} | {pct(row["cvr"])} | {count(t["confirmedOrders"])} | {count(t["paidOrders"])} |')
        message = (f'曝光 {count(t["impressions"])} · 点击率 {pct(row["ctr"])} · 转化率 {pct(row["cvr"])} · 确认/付款 {count(t["confirmedOrders"])}/{count(t["paidOrders"])}')
        messages.append(f'{row["name"]} {"当日缺数" if row["problem"] or not row["reported"] else message}')
    for row in records:
        lines.extend(["", f'## {row["name"]}', "", f'采集时间 {row["capturedAt"] or "当日缺数"}。'])
        if row["problem"]:
            lines.extend(["", row["problem"]])
        lines.extend(["", "| 商品 | 曝光 | 点击 | CTR | 访客 | CVR | 确认单 | 付款单 |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"])
        for item in row["items"]:
            t = item["metrics"] or {field: None for field in FIELDS}
            link = f'[{cell(item["name"])}](https://shopee.tw/product/{SHOP_ID}/{item["id"]})'
            lines.append(f'| {link} | {count(t["impressions"])} | {count(t["clicks"])} | {pct(rate([t], "clicks", "impressions"))} | {count(t["visitors"])} | {pct(rate([t], "confirmedBuyers", "visitors"))} | {count(t["confirmedOrders"])} | {count(t["paidOrders"])} |')
    return "\n".join(lines) + "\n", "\n".join(messages)


def render(day, records):
    text, notification = markdown(day, records)
    revision = hashlib.sha256(text.encode()).hexdigest()
    return {"day": day, "revision": revision, "batches": records, "markdown": text, "notification": notification}


def update_reports(folder, state):
    index = []
    cache = state.setdefault("reportIndex", {})
    for day, grouped in sorted(state["results"].items()):
        if not grouped:
            continue
        path = folder / "reports" / f"{day}.json"
        previous = cache.get(day)
        if previous and previous["count"] == len(grouped) and path.is_file() and path.with_suffix(".md").is_file():
            index.append({"day": day, "revision": previous["revision"]})
            continue
        report = render(day, list(grouped.values()))
        save(path, report)
        temporary = path.with_suffix(".md.tmp")
        temporary.write_text(report["markdown"], encoding="utf-8")
        temporary.replace(path.with_suffix(".md"))
        cache[day] = {"count": len(grouped), "revision": report["revision"]}
        index.append({"day": day, "revision": report["revision"]})
    return index


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("tick", "exchange", "submit", "failure", "report", "baseline", "status"))
    parser.add_argument("day", nargs="?")
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    folder = args.directory
    os.umask(0o077)
    path = folder / "state.json"
    with (folder / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        seed = read(folder / "seed.json")
        state = read(path) if path.exists() else {"batches": {b["id"]: b for b in seed["batches"]}, "results": {}, "errors": {}}
        previous = json.dumps(state, ensure_ascii=False) if path.exists() else None
        now = datetime.now(TAIPEI)
        if args.action == "exchange":
            add_events(state, json.load(sys.stdin))
        pending = tick(state, now)
        answer = None
        if args.action == "submit":
            answer = accept(state, json.load(sys.stdin), now)
        elif args.action == "failure":
            payload = json.load(sys.stdin)
            if payload["day"] == pending["day"] and pending["ids"]:
                state["errors"][payload["day"]] = str(payload["reason"])[:240]
            answer = {"recorded": True}
        elif args.action == "baseline":
            baseline = accept(state, json.load(sys.stdin), now, baseline=True)
            answer = render(f'{pending["day"]} 起始基线', baseline["batches"])
            save(folder / "baseline.json", answer)
        if json.dumps(state, ensure_ascii=False) != previous:
            save(path, state)
        old_index = state.get("reportIndex", {}).copy()
        reports = update_reports(folder, state)
        if state["reportIndex"] != old_index:
            save(path, state)
        if args.action == "report":
            day = str(date.fromisoformat(args.day))
            answer = read(folder / "reports" / f"{day}.json")
        elif answer is None:
            answer = {"pending": pending, "reports": reports}
            if args.action == "status":
                answer.update({"hour": REPORT_HOUR, "timeZone": "Asia/Taipei", "schedule": schedule(state), "batches": list(state["batches"].values())})
        print(json.dumps(answer, ensure_ascii=False))


if __name__ == "__main__":
    main()
