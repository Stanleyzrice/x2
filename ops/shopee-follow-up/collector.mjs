import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const configPath = process.argv[2];
if (!configPath || (process.argv[3] !== undefined && process.argv[3] !== "--baseline")) {
	throw new Error("用法：node collector.mjs <worker.json> [--baseline]");
}
const config = JSON.parse(await readFile(configPath, "utf8"));
const shop = "cheeroutdoor";
const period = "past7days";
const day = (stamp) => new Date(Date.parse(stamp) + 8 * 3_600_000).toISOString().slice(0, 10);
const offsetDay = (today, offset) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const log = (message) => process.stderr.write(`${new Date().toISOString()} ${message}\n`);

function command(program, args, input, timeout = 90_000) {
	const result = spawnSync(program, args, { cwd: repo, input, encoding: "utf8", maxBuffer: 24 * 1024 * 1024, timeout });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		let detail;
		try {
			detail = JSON.parse(result.stdout).error?.message;
		} catch {
			detail = undefined;
		}
		throw new Error(detail || `${program} 退出码 ${result.status ?? result.signal} ${result.stderr.trim().slice(0, 240)}`);
	}
	return result.stdout;
}

const x2 = (...args) => JSON.parse(command(process.execPath, ["x2.ts", ...args, "--json"]));
function nas(action, data, reportDay) {
	if (reportDay && !/^\d{4}-\d{2}-\d{2}$/.test(reportDay)) throw new Error("报告日期无效");
	const remote = ["/run/current-system/sw/bin/python3", "/srv/work/rice/x2/shopee-follow-up/scheduler.py", action, reportDay].filter(Boolean).join(" ");
	return JSON.parse(command(config.nasTool, [remote], data === undefined ? undefined : JSON.stringify(data)));
}

const fields = {
	impressions: "product_card_impressions",
	clicks: "product_card_clicks",
	visitors: "uv",
	cartBuyers: "add_to_cart_buyers",
	confirmedBuyers: "confirmed_buyers",
	paidOrders: "paid_orders",
	confirmedOrders: "confirmed_orders",
};

function collect(today, ids) {
	if (day(new Date().toISOString()) !== today) throw new Error("NAS 与采集端日期不一致");
	const receipt = x2("shopee", "performance", "--shop", "1554182542", "--start", offsetDay(today, -7), "--end", offsetDay(today, -1), "--period", period);
	const capturedAt = new Date().toISOString();
	if (!Array.isArray(receipt.rows) || receipt.next !== null || new Set(receipt.rows.map((row) => row.id)).size !== receipt.rows.length) {
		throw new Error("商品表现回执分页不完整或商品编号重复");
	}
	const requested = new Set(ids);
	const rows = receipt.rows
		.filter((row) => requested.has(row.id))
		.map((row) => ({
			id: row.id,
			...Object.fromEntries(
				Object.entries(fields).map(([name, native]) => {
					const raw = row[native];
					const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
					return [name, Number.isSafeInteger(value) && value >= 0 ? value : null];
				}),
			),
		}));
	return { day: today, shop, period, capturedAt, rows };
}

async function writeAtomic(path, text) {
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, text, { mode: 0o600 });
	await rename(temporary, path);
}

const notification = ["on run argv", '  display notification (item 2 of argv) with title "X2 · cheeroutdoor" subtitle (item 1 of argv)', "end run"].join("\n");

async function deliver(index) {
	if (!index.length) return;
	const marker = join(config.reports, ".delivered.json");
	let delivered = {};
	try {
		delivered = JSON.parse(await readFile(marker, "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	for (const { day: reportDay, revision } of index) {
		if (delivered[reportDay] === revision) continue;
		const report = nas("report", undefined, reportDay);
		if (createHash("sha256").update(report.markdown).digest("hex") !== report.revision) throw new Error("NAS 报告校验不一致");
		await writeAtomic(join(config.reports, `${reportDay}.md`), report.markdown);
		if (reportDay === index.at(-1).day) await writeAtomic(join(config.reports, "latest.md"), report.markdown);
		command("/usr/bin/osascript", ["-e", notification, reportDay, report.notification], undefined, 20_000);
		delivered[reportDay] = report.revision;
		await writeAtomic(marker, `${JSON.stringify(delivered)}\n`);
		log(`报告已同步并交给系统通知 ${reportDay}`);
	}
}

process.umask(0o077);
await mkdir(config.reports, { recursive: true });
if (process.argv[3] === "--baseline") {
	const status = nas("status");
	const ids = status.batches.flatMap((batch) => batch.products.map((p) => p.id));
	const report = nas("baseline", collect(status.pending.day, ids));
	await writeAtomic(join(config.reports, "baseline.md"), report.markdown);
	log(`NAS 基线已回读 ${report.batches.length} 批，${ids.length} 款`);
} else {
	let events;
	try {
		events = x2("listing", "follow-up-events", "--after", config.after);
	} catch (error) {
		log(`新品登记暂不可用 ${error.message}`);
	}
	let status = events ? nas("exchange", events) : nas("tick");
	if (status.pending.ids.length) {
		try {
			const result = nas("submit", collect(status.pending.day, status.pending.ids));
			if (result.accepted) status = nas("tick");
		} catch (error) {
			log(`商品数据暂不可用 ${error.message}`);
			nas("failure", { day: status.pending.day, reason: "采集端当日未能取得完整的 Shopee 商品表现。请检查 Mac、Ego 登录和网络。" });
		}
	}
	await deliver(status.reports);
}
