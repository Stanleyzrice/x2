// 策略研究：验证真实工具事实、取消、请求去重、组合件数与备选导入边界。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { NeedsHuman, Usage } from "../../platform/errors.ts";
import type { RunCandidate, RunCreation, RunDetail, RunStatus, RunStore } from "./run-store.ts";
import {
	categoryPaths,
	createSelectionRunner,
	discountsAreInactive,
	planningCategoryPaths,
	requestFingerprint,
	type SelectionRunConfig,
	type SelectionServices,
	trendQualification,
} from "./runs.ts";
import { dateWindow } from "./social-discovery.ts";
import { summarizeTimeSeries, timeSeriesInputSchema } from "./time-series.ts";

const trendParameters = {
	windowDays: 7,
	minPoints: 7,
	maxLagDays: 3,
	minGrowthRate: 0.1,
	minPreviousGrowthRate: 0,
	minRobustGrowthRate: 0.05,
	minBaselineMean: 10,
};
function temporalSummary(values: number[], basis: "daily" | "observed" | "unknown" = "daily") {
	return summarizeTimeSeries({
		metric: "sales",
		basis,
		windowDays: 7,
		minPoints: 7,
		maxLagDays: 3,
		asOfDate: "2026-11-18",
		points: values.map((value, index) => ({ date: new Date(Date.UTC(2026, 9, 29 + index)).toISOString().slice(0, 10), value })),
	});
}

test("趋势准入只执行快照参数，持续上升可通过，低基数、下降、单日尖峰及未知口径不冒充上升", () => {
	const rising = temporalSummary([...Array<number>(7).fill(100), ...Array<number>(7).fill(110), ...Array<number>(7).fill(130)]);
	assert.equal(trendQualification(rising, trendParameters).qualified, true);
	assert.equal(trendQualification(rising, { ...trendParameters, minGrowthRate: 0.5 }).qualified, false);
	for (const summary of [
		temporalSummary([...Array<number>(7).fill(130), ...Array<number>(7).fill(110), ...Array<number>(7).fill(100)]),
		temporalSummary([...Array<number>(14).fill(100), ...Array<number>(6).fill(100), 1000]),
		temporalSummary([...Array<number>(7).fill(1), ...Array<number>(7).fill(2), ...Array<number>(7).fill(3)]),
		temporalSummary([...Array<number>(7).fill(100), ...Array<number>(7).fill(110), ...Array<number>(7).fill(130)], "unknown"),
	]) {
		const result = trendQualification(summary, trendParameters);
		assert.equal(result.qualified, false);
		assert.ok(result.reasons.length);
	}
	assert.equal(trendQualification(rising, undefined).qualified, false);
});

test("有日期的样本指标仅能通过观察初筛，不能升级为日销量或同期总成交", () => {
	const summary = temporalSummary([...Array<number>(7).fill(100), ...Array<number>(7).fill(110), ...Array<number>(7).fill(130)], "observed");
	assert.equal(summary.observationComparable, true);
	assert.equal(summary.dailyComparable, false);
	assert.equal(summary.recent.total, null);
	assert.equal(trendQualification(summary, trendParameters).qualified, true);
	assert.ok(summary.limitations.some((limitation) => limitation.includes("聚合窗口")));
});

const config = (): SelectionRunConfig => ({
	shop: "cheeroutdoor",
	strategy: {
		id: "peer-benchmark",
		name: "竞品对标",
		description: "研究",
		steps: [],
		policyPath: "skills/selection/references/workbench.md",
		instructions: "只分析事实",
	},
	limit: 1,
	brief: "手机带",
	policyText: "市场资料优先参考，供货与成本齐可入备选",
	pricingTemplate: { fx: 4.8, feeRate: 0.16, freightPerKgRmb: 10, labelFeeRmb: 1.5, minMargin: 0.2, maxMargin: 0.3 },
	constraints: { requireOnePieceSale: true, requireShip48h: true, maxMinQty: 1, maxSkuCount: 50, minSinglePriceTwd: 120 },
	allowedCategories: null,
	sellerDiscountTwd: 0,
	existingOfferIds: [],
});

function memoryStore(): RunStore {
	const runs = new Map<string, RunDetail>(),
		requests = new Map<string, { id: string; fingerprint: string }>();
	return {
		open: async (input: RunCreation) => {
			const old = requests.get(input.requestId);
			if (old) {
				if (old.fingerprint !== input.fingerprint) throw new Usage("同requestId输入不同");
				return { run: structuredClone(runs.get(old.id)!), created: false, release: async () => {} };
			}
			if ([...runs.values()].some((r) => ["queued", "running"].includes(r.status))) throw new Usage("已有研究");
			const id = randomUUID(),
				now = new Date().toISOString();
			const run: RunDetail = {
				id,
				shop: input.shop,
				strategyId: input.strategyId,
				strategyName: input.strategyName,
				limit: input.limit,
				brief: input.brief,
				status: "queued",
				step: "等待",
				found: 0,
				createdAt: now,
				updatedAt: now,
				error: null,
				events: [],
				candidates: [],
				cancelRequested: false,
			};
			runs.set(id, run);
			requests.set(input.requestId, { id, fingerprint: input.fingerprint });
			return { run: structuredClone(run), created: true, release: async () => {} };
		},
		get: async (id) => structuredClone(runs.get(id) ?? null),
		list: async () => [...runs.values()].map((r) => structuredClone(r)),
		event: async (id, step, message, data) => {
			const r = runs.get(id)!;
			r.step = step;
			r.events.push({ id: randomUUID(), step, message, at: new Date().toISOString(), ...(data ? { data: structuredClone(data) } : {}) });
		},
		candidate: async (id, candidate: RunCandidate) => {
			const r = runs.get(id)!;
			r.candidates.push(structuredClone(candidate));
			if (candidate.status === "added") r.found++;
		},
		running: async (id) => {
			runs.get(id)!.status = "running";
		},
		cancel: async (id) => {
			const r = runs.get(id);
			if (r && ["queued", "running"].includes(r.status)) r.cancelRequested = true;
			return structuredClone(r ?? null);
		},
		shouldStop: async (id) => {
			const r = runs.get(id);
			return !r || r.cancelRequested || !["queued", "running"].includes(r.status);
		},
		finish: async (id, status: Exclude<RunStatus, "queued" | "running">, error = null) => {
			const r = runs.get(id)!;
			r.status = r.cancelRequested ? "cancelled" : status;
			r.error = error;
		},
		recover: async () => 0,
	};
}

function fixture() {
	const calls: { tool: string; input: Record<string, unknown> }[] = [];
	let asks = 0;
	const choice = {
		offerId: "123",
		skuId: "456",
		reason: "用途一致且来源真实",
		evidence: "工具提供的需求与来源",
		hardProblems: [] as string[],
		warnings: [] as string[],
		relevant: true,
		prohibited: false,
		categoryMatch: true,
		units: 1,
	};
	const offer = {
		offerId: "123",
		title: "手机带",
		url: "https://detail.1688.com/offer/123.html",
		image: "https://example.test/image.jpg",
		minQty: 1,
		skus: [{ skuId: "456", name: "黑色", price: 10, stock: 30, weightKg: 0.1 }],
		tags: { onePsale: true, ship48h: true, freeShipping: false },
		freight: { costRmb: 3 },
	};
	const services: SelectionServices = {
		agentStatus: async () => ({ available: true, version: "test", error: null }),
		ask: async (input) => {
			asks++;
			return input.schema.properties && typeof input.schema.properties === "object" && "focus" in input.schema.properties
				? { focus: "手机带", queries: [{ keyword: "手機掛繩", sourceKeyword: "手机带", categoryPath: [100, 101] }] }
				: { summary: "分析完成", candidates: [choice] };
		},
		callTool: async (tool, input) => {
			calls.push({ tool, input });
			switch (tool) {
				case "zhixia.categories":
					return { rows: [{ id: "100", name: "手機", children: [{ id: "101", name: "掛繩", children: [] }] }], next: null };
				case "zhixia.hot-words":
					return { rows: [{ hotWordId: 5, word: "手機掛繩", searchVal: 100, sales30day: 50 }], updateTime: "2026-11-16" };
				case "zhixia.hot-word-items":
					return { rows: [{ itemId: "789", itemDataList: [{ sales30Day: 20 }] }], next: null };
				case "zhixia.competition":
					return { itemCount: 40 };
				case "zhixia.long-tail":
				case "zhixia.complaints":
					return { rows: [], next: null };
				case "1688.search":
					return { rows: [{ offerId: "123", title: "手机带" }], next: null };
				case "1688.offer":
					return offer;
				case "listing.calculator-preview":
					return { status: "CALCULATED", priceTwd: 129, totalCostRmb: 17, profitRmb: 5.575, margin: 0.247, withinTarget: true, problems: [] };
				case "listing.collect-source":
					return {
						sourceId: "7",
						offerId: "123",
						title: "手机带",
						status: "added",
						problems: [],
						sourceCapturedAt: "2026-11-17T00:00:00Z",
						reusedSnapshot: false,
					};
				case "shopee.vouchers":
				case "shopee.bundles":
					return { rows: [], next: null };
				case "shopee.discounts":
					return { discount_list: [], total_count: 0, error_list: [] };
				default:
					throw new Error(`未允许的测试调用${tool}`);
			}
		},
	};
	return { calls, services, choice, offer, askCount: () => asks };
}

test("研究真通路使用工具事实进入现有备选，不建稿不刊登；相同请求只执行一次", async () => {
	const f = fixture(),
		runner = createSelectionRunner(memoryStore(), f.services),
		input = config();
	const run = await runner.start(input, "request-a");
	assert.equal(run.status, "completed");
	assert.equal(run.found, 1);
	assert.equal(run.candidates[0]?.sourceId, "7");
	assert.equal(f.askCount(), 2);
	assert.equal(
		f.calls.some((c) => /publish|make|cart|source-prepare/.test(c.tool)),
		false,
	);
	const callCount = f.calls.length;
	f.services.agentStatus = async () => ({ available: false, version: null, error: "离线" });
	const retry = await runner.start({ ...input, existingOfferIds: ["123"], pricingTemplate: { ...input.pricingTemplate, feeRate: 0.2 } }, "request-a");
	assert.equal(retry.id, run.id);
	assert.equal(f.calls.length, callCount);
	await assert.rejects(runner.start({ ...input, brief: "另一输入" }, "request-a"), /输入不同/);
});

test("市场资料缺项仅留警示；真实供货与成本齐可进入备选", async () => {
	const f = fixture();
	f.choice.warnings = ["同规格市场价格未知"];
	const original = f.services.callTool;
	f.services.callTool = async (id, input) => {
		if (id === "zhixia.hot-words") throw new Error("市场数据字段暂缺");
		return original(id, input);
	};
	const run = await createSelectionRunner(memoryStore(), f.services).start(config(), "market-unknown");
	assert.equal(run.status, "completed");
	assert.equal(run.found, 1);
	assert.equal(
		run.candidates[0]?.problems.some((p) => p.includes("需求尚未验证")),
		true,
	);
	const provenance = f.calls.find((c) => c.tool === "listing.collect-source")?.input.provenance as { evidence: string };
	assert.match(provenance.evidence, /同规格市场价格未知/);
	assert.match(provenance.evidence, /需求尚未验证/);
	assert.match(provenance.evidence, /skuId=456，规格黑色/);
	assert.match(provenance.evidence, /整套成本17元，建议价129新台币，利润5.575元/);
	assert.ok(provenance.evidence.length <= 12_000);
});

test("登录或验证要求立即停止，不降级为市场警示继续读取其他站点", async () => {
	for (const stage of ["shopee.vouchers", "zhixia.categories", "zhixia.hot-words", "zhixia.similar-1688", "1688.offer"]) {
		const f = fixture(),
			seen: string[] = [],
			original = f.services.callTool;
		f.services.callTool = async (id, input) => {
			seen.push(id);
			if (id === stage) throw new NeedsHuman("请完成当前站点登录或验证");
			if (id === "zhixia.hot-word-items") return { rows: [{ itemId: "789", imgUrl: "https://example.test/item.jpg" }], next: null };
			return original(id, input);
		};
		const run = await createSelectionRunner(memoryStore(), f.services).start({ ...config(), sellerDiscountTwd: null }, `needs-human-${stage}`);
		assert.equal(run.status, "needs-human", stage);
		assert.equal(run.found, 0, stage);
		assert.equal(run.error, "请完成当前站点登录或验证", stage);
		assert.equal(seen.at(-1), stage, "遇到人工操作要求后不再继续工具调用");
		assert.equal(seen.includes("listing.collect-source"), false, stage);
	}
});

test("仅有来源备选可跨策略复用；本店已有商品稿不重复添加", async () => {
	const f = fixture(),
		original = f.services.callTool;
	f.services.callTool = async (id, input) => {
		const result = await original(id, input);
		return id === "listing.collect-source" ? { ...(result as object), status: "existing", reusedSnapshot: true } : result;
	};
	const reused = await createSelectionRunner(memoryStore(), f.services).start(config(), "reuse-source");
	assert.equal(reused.status, "completed");
	assert.equal(reused.found, 0);
	assert.equal(reused.candidates[0]?.status, "existing");
	assert.equal(reused.candidates[0]?.sourceId, "7");
	assert.equal(f.calls.find((c) => c.tool === "listing.collect-source")?.input.provenance !== undefined, true);
	const listed = fixture();
	const rejected = await createSelectionRunner(memoryStore(), listed.services).start({ ...config(), existingOfferIds: ["123"] }, "already-listed");
	assert.equal(rejected.candidates[0]?.status, "rejected");
	assert.equal(
		rejected.candidates[0]?.problems.some((p) => p.includes("已有店铺商品稿")),
		true,
	);
	assert.equal(
		listed.calls.some((c) => c.tool === "listing.collect-source"),
		false,
	);
});

test("图搜错用途不能耗尽来源名额，关键词来源优先读取并可正常入备选", async () => {
	const f = fixture(),
		original = f.services.callTool,
		readOffers: string[] = [];
	f.services.callTool = async (id, input) => {
		if (id === "zhixia.hot-word-items") return { rows: [{ itemId: "789", imgUrl: "https://example.test/item.jpg" }], next: null };
		if (id === "zhixia.similar-1688") return { rows: ["901", "902", "903", "904"].map((offerId) => ({ offerId, title: "抹布" })) };
		if (id === "1688.search") return { rows: ["123", "124", "125", "126"].map((offerId) => ({ offerId, title: "手机带" })) };
		if (id === "1688.offer") {
			const offerId = String(input.id);
			readOffers.push(offerId);
			return { ...f.offer, offerId, url: `https://detail.1688.com/offer/${offerId}.html`, title: offerId.startsWith("9") ? "抹布" : "手机带" };
		}
		return original(id, input);
	};
	const run = await createSelectionRunner(memoryStore(), f.services).start(config(), "wrong-image-results");
	assert.deepEqual(readOffers.slice(0, 3), ["123", "124", "125"]);
	assert.equal(readOffers.length, 6);
	assert.equal(readOffers.includes("901"), true);
	assert.equal(run.status, "completed");
	assert.equal(run.candidates[0]?.offerId, "123");
	assert.equal(run.found, 1);
});

test("模型编造货源或SKU会先拒绝整份选择，不导入前面的合法项", async () => {
	const f = fixture();
	let calls = 0;
	f.services.ask = async () =>
		++calls === 1
			? { focus: "方向", queries: [{ keyword: "手機掛繩", sourceKeyword: "手机带", categoryPath: [100, 101] }] }
			: { summary: "选择", candidates: [f.choice, { ...f.choice, offerId: "999" }] };
	const run = await createSelectionRunner(memoryStore(), f.services).start({ ...config(), limit: 2 }, "invented");
	assert.equal(run.status, "failed");
	assert.equal(run.found, 0);
	assert.equal(
		f.calls.some((c) => c.tool === "listing.collect-source"),
		false,
	);
});

test("取消后迟到成本结果不能继续导入，后台任务独立于start响应", async () => {
	const f = fixture(),
		store = memoryStore();
	let release: () => void = () => {},
		entered: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
			release = resolve;
		}),
		waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
	const original = f.services.callTool;
	f.services.callTool = async (id, input) => {
		if (id === "listing.calculator-preview") {
			entered();
			await gate;
		}
		return original(id, input);
	};
	const runner = createSelectionRunner(store, f.services),
		run = await runner.start(config(), "cancel", true);
	assert.equal(["queued", "running"].includes(run.status), true);
	await waiting;
	await runner.cancel(run.id);
	release();
	const final = await runner.wait(run.id);
	assert.equal(final?.status, "cancelled");
	assert.equal(final?.found, 0);
	assert.equal(
		f.calls.some((c) => c.tool === "listing.collect-source"),
		false,
	);
});

test("供货失败仍拒绝，优惠未知只入研究备选且不冒充已核价；非法模型输出失败", async () => {
	const f = fixture();
	f.offer.tags.onePsale = false;
	const supply = await createSelectionRunner(memoryStore(), f.services).start(config(), "bad-supply");
	assert.equal(supply.found, 0);
	assert.equal(supply.candidates[0]?.status, "rejected");
	const unknown = fixture(),
		original = unknown.services.callTool;
	unknown.services.callTool = async (id, input) =>
		id === "shopee.vouchers" ? { rows: [{ start_time: Date.now() / 1000 - 10, end_time: Date.now() / 1000 + 1000 }], next: null } : original(id, input);
	const discount = await createSelectionRunner(memoryStore(), unknown.services).start({ ...config(), sellerDiscountTwd: null }, "unknown-discount");
	assert.equal(discount.found, 1);
	assert.equal(discount.candidates[0]?.pricing, undefined);
	assert.equal(
		unknown.calls.some((call) => call.tool === "listing.calculator-preview"),
		false,
	);
	assert.match(discount.candidates[0]?.evidence ?? "", /未完成成本试算，仅为研究备选/);
	assert.equal(
		discount.candidates[0]?.problems.some((p) => p.includes("优惠仍未知")),
		true,
	);
	const bad = fixture();
	bad.services.ask = async () => ({ fabricated: true });
	const malformed = await createSelectionRunner(memoryStore(), bad.services).start(config(), "malformed");
	assert.equal(malformed.status, "failed");
	assert.equal(malformed.found, 0);
});

test("组合策略按显式件数累加成本与重量，采集原始单件不改商品", async () => {
	const f = fixture();
	f.choice.units = 3;
	const input = config();
	input.strategy = { ...input.strategy, id: "bundle-sales", name: "组合销售" };
	const run = await createSelectionRunner(memoryStore(), f.services).start(input, "bundle");
	const cost = f.calls.find((c) => c.tool === "listing.calculator-preview")!.input;
	assert.equal(cost.costRmb, 30);
	assert.ok(Math.abs(Number(cost.weightKg) - 0.3) < 1e-9);
	assert.equal(cost.units, 1);
	assert.equal(run.found, 1);
	assert.match(run.candidates[0]!.evidence, /同SKU3件/);
	assert.match(run.candidates[0]!.evidence, /skuId=456，规格黑色/);
	assert.match(run.candidates[0]!.evidence, /整套采购价30元，单重0.1kg/);
	assert.match(run.candidates[0]!.evidence, /国内运费3元/);
	assert.equal(
		run.candidates[0]!.problems.some((p) => p.includes("固定套装")),
		true,
	);
	assert.equal(f.calls.find((c) => c.tool === "listing.collect-source")?.input.link, "https://detail.1688.com/offer/123.html");
	const provenance = f.calls.find((c) => c.tool === "listing.collect-source")?.input.provenance as { evidence: string };
	assert.match(provenance.evidence, /拟议多件组合尚未落实固定套装/);
});

test("真实类目和优惠口径：未知不补零，请求签名不受运行事实变化影响", () => {
	assert.deepEqual(categoryPaths({ rows: [{ id: "1", name: "父", children: [{ id: "2", name: "子", children: [] }] }] }), [
		{ path: [1], name: "父" },
		{ path: [1, 2], name: "父 > 子" },
	]);
	assert.equal(discountsAreInactive({ rows: [], next: null }, { discount_list: [], total_count: 0 }, { rows: [], next: null }), true);
	assert.equal(discountsAreInactive({}, { discount_list: [], total_count: 0 }, { rows: [], next: null }), false);
	assert.equal(requestFingerprint(config()), requestFingerprint({ ...config(), existingOfferIds: ["changed"] } as SelectionRunConfig));
});

test("缺重量、运费及图片审阅可保存研究备选；核心适配证据缺失仍拒绝", async () => {
	const pending = fixture(),
		original = pending.services.callTool;
	pending.choice.warnings = ["图片与所选规格的对应关系待审核", "实际内尺寸待供应商补充，未承诺适配特定长度"];
	pending.services.callTool = async (id, input) =>
		id === "1688.offer"
			? { ...pending.offer, skus: pending.offer.skus.map((sku) => ({ ...sku, weightKg: null })), freight: { costRmb: null } }
			: original(id, input);
	const run = await createSelectionRunner(memoryStore(), pending.services).start(config(), "pending-research");
	assert.equal(run.found, 1);
	assert.equal(run.candidates[0]?.pricing, undefined);
	assert.ok(run.candidates[0]?.problems.some((problem) => problem.includes("待补计费重量")));
	assert.ok(run.candidates[0]?.problems.some((problem) => problem.includes("待补国内运费")));
	assert.equal(
		pending.calls.some((call) => call.tool === "listing.calculator-preview"),
		false,
	);
	const incompatible = fixture();
	incompatible.choice.hardProblems = ["货源内长12厘米，研究要求收纳20厘米工具，无法兑现适配理由"];
	const rejected = await createSelectionRunner(memoryStore(), incompatible.services).start(config(), "incompatible");
	assert.equal(rejected.found, 0);
	assert.equal(rejected.candidates[0]?.status, "rejected");
	assert.equal(
		incompatible.calls.some((call) => call.tool === "listing.collect-source"),
		false,
	);
});

test("前序排除不占新增名额，同轮后续合格来源仍能入选并达到名额即停止", async () => {
	const f = fixture(),
		original = f.services.callTool;
	f.services.ask = async (input) =>
		input.schema.properties && typeof input.schema.properties === "object" && "focus" in input.schema.properties
			? { focus: "手机带", queries: [{ keyword: "手機掛繩", sourceKeyword: "手机带", categoryPath: [100, 101] }] }
			: { summary: "第一项无库存，第二项可入备选", candidates: [{ ...f.choice, offerId: "124" }, f.choice, { ...f.choice, offerId: "125" }] };
	f.services.callTool = async (id, input) => {
		if (id === "1688.search") return { rows: ["124", "123", "125"].map((offerId) => ({ offerId })) };
		if (id === "1688.offer") {
			const offerId = String(input.id);
			return {
				...f.offer,
				offerId,
				url: `https://detail.1688.com/offer/${offerId}.html`,
				skus: f.offer.skus.map((sku) => ({ ...sku, stock: offerId === "124" ? 0 : 30 })),
			};
		}
		return original(id, input);
	};
	const run = await createSelectionRunner(memoryStore(), f.services).start(config(), "rejected-before-good");
	assert.equal(run.status, "completed");
	assert.equal(run.found, 1);
	assert.deepEqual(
		run.candidates.map((candidate) => [candidate.offerId, candidate.status]),
		[
			["124", "rejected"],
			["123", "added"],
		],
	);
	assert.equal(f.calls.filter((call) => call.tool === "listing.collect-source").length, 1);
});

test("补充轮次使用前轮拒绝原因与自定义步骤，换查询找到新来源后闭环保存", async () => {
	const f = fixture(),
		original = f.services.callTool,
		prompts: string[] = [];
	let plans = 0;
	f.services.ask = async (input) => {
		prompts.push(input.prompt);
		if (input.schema.properties && typeof input.schema.properties === "object" && "focus" in input.schema.properties) {
			plans++;
			return { focus: "手机带", queries: [{ keyword: "手機掛繩", sourceKeyword: plans === 1 ? "手机带" : "防脱手机挂绳", categoryPath: [100, 101] }] };
		}
		return { summary: "按真实供货筛选", candidates: [{ ...f.choice, offerId: plans === 1 ? "124" : "123" }] };
	};
	f.services.callTool = async (id, input) => {
		if (id === "1688.search") return { rows: [{ offerId: input.keyword === "手机带" ? "124" : "123" }] };
		if (id === "1688.offer") {
			f.calls.push({ tool: id, input });
			const offerId = String(input.id);
			return { ...f.offer, offerId, url: `https://detail.1688.com/offer/${offerId}.html`, tags: { ...f.offer.tags, ship48h: offerId !== "124" } };
		}
		return original(id, input);
	};
	const input = config();
	input.strategy.steps = ["检查断裂后替换需求", "核对挂孔适配与随附件", "登记真实来源和待补项"];
	input.agent = { model: "configured-model", reasoningEffort: "high" };
	const run = await createSelectionRunner(memoryStore(), f.services).start(input, "two-round-loop");
	assert.equal(run.status, "completed");
	assert.equal(run.found, 1);
	assert.equal(plans, 2);
	assert.ok(prompts.every((prompt) => prompt.includes("检查断裂后替换需求")));
	assert.ok(prompts.some((prompt) => prompt.includes("前轮反馈") && prompt.includes("缺48小时发货证据")));
	assert.deepEqual(
		f.calls.filter((call) => call.tool === "1688.offer").map((call) => call.input.id),
		["124", "123"],
	);
	assert.ok(run.events.some((event) => event.step === "执行配置" && event.message.includes("configured-model")));
	assert.match(run.events.at(-1)?.message ?? "", /新增目标已达成/);
});

test("有边界地补充三轮，重复来源不刷新增数，无合格来源如实保留不足", async () => {
	const f = fixture(),
		original = f.services.callTool;
	let plans = 0;
	f.services.ask = async (input) =>
		input.schema.properties && typeof input.schema.properties === "object" && "focus" in input.schema.properties
			? { focus: "手机带", queries: [{ keyword: "手機掛繩", sourceKeyword: `手机带${++plans}`, categoryPath: [100, 101] }] }
			: { summary: "不符合供货", candidates: [f.choice] };
	f.offer.tags.onePsale = false;
	f.services.callTool = original;
	const run = await createSelectionRunner(memoryStore(), f.services).start(config(), "bounded-no-match");
	assert.equal(run.status, "completed");
	assert.equal(plans, 3);
	assert.equal(run.found, 0);
	assert.equal(run.candidates.length, 1);
	assert.equal(f.calls.filter((call) => call.tool === "1688.offer").length, 1);
	assert.equal(
		f.calls.some((call) => call.tool === "listing.collect-source"),
		false,
	);
	assert.match(run.events.at(-1)?.message ?? "", /新增名额未达成/);
});

test("多来源分批保留尾部来源与全部SKU，市场大回包每批每组只传一次并明示字段摘要", async () => {
	const f = fixture(),
		original = f.services.callTool;
	const selectionPrompts: string[] = [];
	f.services.ask = async (input) => {
		if (input.schema.properties && typeof input.schema.properties === "object" && "focus" in input.schema.properties)
			return { focus: "手机带", queries: ["手机带", "防脱挂绳"].map((sourceKeyword) => ({ keyword: "手機掛繩", sourceKeyword, categoryPath: [100, 101] })) };
		selectionPrompts.push(input.prompt);
		return { summary: "尾部来源规格可用", candidates: input.prompt.includes('"offerId":"1008"') ? [{ ...f.choice, offerId: "1008", skuId: "100824" }] : [] };
	};
	f.services.callTool = async (id, input) => {
		if (id === "zhixia.competition") return { itemCount: 40, detail: `UNIQUE_COMPETITION_PAYLOAD${"x".repeat(35_000)}` };
		if (id === "1688.search") {
			const start = input.keyword === "手机带" ? 1000 : 1006;
			return { rows: Array.from({ length: 6 }, (_, i) => ({ offerId: String(start + i) })) };
		}
		if (id === "1688.offer") {
			const offerId = String(input.id);
			return {
				...f.offer,
				offerId,
				url: `https://detail.1688.com/offer/${offerId}.html`,
				props: [{ name: "材质", values: [{ name: "尼龙" }] }],
				skus: Array.from({ length: 25 }, (_, i) => ({ ...f.offer.skus[0], skuId: `${offerId}${i}`, name: `规格${i}`, attrs: ["长度20厘米"] })),
			};
		}
		const result = await original(id, input);
		return id === "listing.collect-source" ? { ...(result as object), offerId: "1008" } : result;
	};
	const run = await createSelectionRunner(memoryStore(), f.services).start({ ...config(), limit: 3 }, "all-source-context");
	assert.equal(run.found, 1);
	const batches = selectionPrompts.map((prompt) => {
		const sourceLine = prompt.split("\n").find((line) => line.startsWith("真实来源（"))!;
		return JSON.parse(sourceLine.slice(sourceLine.indexOf("：") + 1)) as {
			offer: { offerId: string; skus: { skuId: string; attrs: string[] }[]; props: unknown; tags: unknown };
			query: Record<string, unknown>;
		}[];
	});
	assert.ok(batches.every((batch) => batch.length <= 3));
	const sources = batches.flat();
	assert.equal(sources.length, 9);
	assert.deepEqual(
		sources.map((source) => source.offer.offerId),
		Array.from({ length: 9 }, (_, i) => String(1000 + i)),
	);
	assert.ok(sources.every((source) => source.offer.skus.length === 25 && source.offer.tags && source.offer.props));
	assert.equal(sources.at(-1)?.offer.skus.at(-1)?.skuId, "100824");
	assert.deepEqual(sources.at(-1)?.offer.skus.at(-1)?.attrs, ["长度20厘米"]);
	assert.ok(sources.every((source) => !Object.hasOwn(source.query, "competition") && !Object.hasOwn(source.query, "items")));
	assert.ok(
		selectionPrompts.every((prompt) => prompt.match(/UNIQUE_COMPETITION_PAYLOAD/g)?.length === 1),
		"每批只传对应市场资料一次，不按三个来源重复",
	);
	assert.ok(selectionPrompts.every((prompt) => prompt.includes("字段摘要：省略")));
});

test("规划先识别规则冲突或自然停止，不再强制搜索或补足名额", async () => {
	for (const decision of ["needs-human", "stop"] as const) {
		const f = fixture();
		let asks = 0;
		f.services.ask = async () => {
			asks++;
			return { focus: "带电家用电器方向", decision, explanation: "需要认证的带电电器与现行选品规则冲突，不能自动放宽认证限制", queries: [] };
		};
		const run = await createSelectionRunner(memoryStore(), f.services).start({ ...config(), brief: "带电家用电器" }, `stop-${decision}`);
		assert.equal(run.status, decision === "needs-human" ? "needs-human" : "completed");
		assert.equal(run.found, 0);
		assert.equal(asks, 1);
		assert.ok(!f.calls.some((call) => call.tool === "1688.search" || call.tool === "zhixia.hot-words"));
		if (decision === "needs-human") assert.match(run.error ?? "", /不能自动放宽认证限制/);
		else assert.ok(run.events.some((event) => event.step === "停止研究" && event.message.includes("规则")));
	}
});

test("规划类目只传完整一级与相关细分，真实1666规模不再整树塞入提示", () => {
	const roots = [
		{ path: [1], name: "女裝" },
		{ path: [2], name: "運動戶外" },
	];
	const paths = [
		...roots,
		...Array.from({ length: 1656 }, (_, i) => ({ path: [2, 100 + i], name: `運動戶外 > 無關類目${i}` })),
		...Array.from({ length: 8 }, (_, i) => ({ path: [1, 2000 + i], name: `女裝 > 睡衣${i}` })),
	];
	const selected = planningCategoryPaths(paths, "找一些睡衣方向的");
	assert.equal(paths.length, 1666);
	assert.ok(JSON.stringify(selected).length <= 16_000);
	assert.ok(roots.every((root) => selected.some((path) => JSON.stringify(path.path) === JSON.stringify(root.path))));
	assert.equal(selected.filter((path) => path.name.includes("睡衣")).length, 8);
	assert.equal(selected.length, 10);
	assert.ok(
		selected.every((path) => paths.includes(path)),
		"只传真实读取的类目路径",
	);
});

test("只读模型步骤超时各重试一次，原站点事实和备选保存不会重做", async () => {
	const f = fixture(),
		original = f.services.ask,
		requests: { stage: string; timeout: number }[] = [];
	const counts = { plan: 0, choice: 0 };
	f.services.ask = async (input) => {
		const stage = input.schema.properties && typeof input.schema.properties === "object" && "focus" in input.schema.properties ? "plan" : "choice";
		requests.push({ stage, timeout: input.timeoutMs });
		if (++counts[stage] === 1) throw Object.assign(new Error("模型请求等待超时"), { code: "CODEX_TIMEOUT" });
		return original(input);
	};
	const run = await createSelectionRunner(memoryStore(), f.services).start(config(), "timeout-retry");
	assert.equal(run.status, "completed");
	assert.equal(run.found, 1);
	assert.deepEqual(counts, { plan: 2, choice: 2 });
	assert.deepEqual(
		requests.map((request) => request.timeout),
		[120_000, 180_000, 180_000, 180_000],
	);
	for (const tool of ["zhixia.categories", "zhixia.hot-words", "1688.search", "1688.offer", "listing.collect-source"])
		assert.equal(f.calls.filter((call) => call.tool === tool).length, 1, tool);
	assert.equal(run.events.filter((event) => event.step === "模型超时恢复").length, 2);
});

test("后续筛选批次连续超时保留前批真实备选，错误写清轮次与批次", async () => {
	const f = fixture(),
		originalAsk = f.services.ask,
		originalCall = f.services.callTool;
	let choiceRequests = 0;
	f.services.ask = async (input) => {
		if (input.schema.properties && typeof input.schema.properties === "object" && "focus" in input.schema.properties) return originalAsk(input);
		if (++choiceRequests === 1) return { summary: "第一批保留一个来源", candidates: [f.choice] };
		throw Object.assign(new Error("模型请求等待超时"), { code: "CODEX_TIMEOUT" });
	};
	f.services.callTool = async (tool, input) => {
		if (tool === "1688.search") {
			f.calls.push({ tool, input });
			return { rows: Array.from({ length: 6 }, (_, i) => ({ offerId: String(123 + i) })) };
		}
		if (tool === "1688.offer") {
			f.calls.push({ tool, input });
			const offerId = String(input.id);
			return { ...f.offer, offerId, url: `https://detail.1688.com/offer/${offerId}.html` };
		}
		return originalCall(tool, input);
	};
	const run = await createSelectionRunner(memoryStore(), f.services).start({ ...config(), limit: 3 }, "partial-on-timeout");
	assert.equal(run.status, "failed");
	assert.equal(run.found, 1);
	assert.equal(choiceRequests, 3, "第一批成功，第二批仅重试一次");
	assert.equal(run.candidates.find((candidate) => candidate.offerId === "123")?.sourceId, "7");
	assert.match(run.error ?? "", /第1轮第2批筛选分析超时，已自动重试1次/);
	assert.equal(f.calls.filter((call) => call.tool === "1688.offer").length, 6);
	assert.equal(f.calls.filter((call) => call.tool === "listing.collect-source").length, 1);
});

test("普通模型错误不重试；取消与超时同时发生时优先取消且不重试", async () => {
	const failed = fixture();
	let failedAsks = 0;
	failed.services.ask = async () => {
		failedAsks++;
		throw new Error("结构化请求参数无效");
	};
	const error = await createSelectionRunner(memoryStore(), failed.services).start(config(), "non-timeout");
	assert.equal(error.status, "failed");
	assert.equal(failedAsks, 1);
	const cancelled = fixture(),
		store = memoryStore();
	let enter: () => void = () => {},
		release: () => void = () => {},
		cancelledAsks = 0;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	cancelled.services.ask = async () => {
		cancelledAsks++;
		enter();
		await gate;
		throw Object.assign(new Error("等待超时"), { code: "CODEX_TIMEOUT" });
	};
	const runner = createSelectionRunner(store, cancelled.services),
		run = await runner.start(config(), "cancel-timeout", true);
	await entered;
	await runner.cancel(run.id);
	release();
	assert.equal((await runner.wait(run.id))?.status, "cancelled");
	assert.equal(cancelledAsks, 1);
	assert.ok(!cancelled.calls.some((call) => call.tool === "1688.search"));
});

const reviewedConfig = (): SelectionRunConfig => ({
	...config(),
	strategy: { ...config().strategy, researchVersion: 1, steps: ["读取需求与可比组", "核对差异、失败条件与待补"] },
});
const reviewedResearch = () => ({
	purchaseTask: "通勤时将手机挂在手腕，减少临时放置",
	demandLevel: "purchase" as "unknown" | "search" | "purchase",
	queryFactIndexes: [0],
	comparableGroup: "同用途手机挂绳；竞品销量为整链接口径，规格与购买条件仍待核对",
	deliverableDifference: "所选黑色规格可采购；舒适度优势仍为假设",
	differenceStatus: "hypothesis" as "supported" | "hypothesis" | "unknown",
	failureConditions: ["若挂孔不兼容或无法解释完整成本优势则停止"],
	missing: ["待核实挂孔适配、竞品购买条件及图片"],
});
const reviewedAudit = () => ({
	steps: [1, 2].map((stepIndex) => ({
		stepIndex,
		status: "partial" as "supported" | "partial" | "not-applicable",
		conclusion: stepIndex === 1 ? "读到整链接购买线索，尚非所选规格需求证明" : "保留差异假设及可证伪条件，缺项未称完成",
		queryFactIndexes: [0],
		offerIds: ["123"],
		missing: ["适配及可比购买条件待补"],
	})),
	stopReason: null as string | null,
});

function reviewedFixture() {
	const f = fixture(),
		originalAsk = f.services.ask;
	const research = reviewedResearch(),
		audit = reviewedAudit();
	let requests = 0;
	f.services.ask = async (input) => {
		requests++;
		return input.schema.properties && typeof input.schema.properties === "object" && "focus" in input.schema.properties
			? originalAsk(input)
			: { summary: "研究结论，后续缺项明确保留", audit, candidates: [{ ...f.choice, research }] };
	};
	return { ...f, research, audit, requestCount: () => requests };
}

test("小红书只凭自己原帖及匹配的台湾近期购买准入，并保留图片出处和核价状态", async () => {
	for (const issue of ["none", "reused", "long-keyword", "old-note", "wrong-quote", "old-sales", "wrong-site", "other-product", "wrong-comparable"] as const) {
		const qualifies = issue === "none" || issue === "reused" || issue === "long-keyword";
		const f = reviewedFixture();
		const originalCall = f.services.callTool;
		const input = reviewedConfig();
		input.strategy.id = "xiaohongshu-discovery";
		input.marketSiteId = 1;
		input.limit = 1;
		input.policyText = "规划流程独有的长说明";
		input.assessmentPolicy = "筛选判断标准";
		const { today } = dateWindow(new Date(), 30);
		const id = "6ae4536200000000190006ad";
		const note = {
			id,
			url: `https://www.xiaohongshu.com/explore/${id}`,
			title: "台湾虾皮商品复盘",
			publishedAt: issue === "old-note" ? "2020-01-01" : today,
			body: "雨天通勤时腾出双手",
			photos: [{ index: 2, url: "https://sns-webpic-qc.xhscdn.com/pic.jpg" }],
		};
		f.services.ask = async (request) => {
			if (request.images?.length) return { images: [{ index: 1, text: "雨天通勤時騰出雙手" }] };
			if (request.prompt.includes("已读原帖和图片文字"))
				return {
					focus: "雨天通勤",
					queries: [
						{
							keyword: issue === "long-keyword" ? "手機防水掛繩" : "手機掛繩",
							sourceKeyword: "手机带",
							categoryPath: [100, 101],
							role: "product",
							note: {
								noteId: id,
								part: 2,
								relation: "scene-extension",
								quote: issue === "wrong-quote" ? "未知内容补写" : "雨天通勤時騰出雙手",
								marketQuote: note.title,
								matchTerms: issue === "long-keyword" ? ["掛繩", "防水"] : ["手機掛繩"],
							},
						},
					],
				};
			assert.ok(request.prompt.includes(input.assessmentPolicy!));
			assert.ok(!request.prompt.includes(input.policyText));
			return {
				summary: "匹配商品",
				audit: f.audit,
				candidates: [{ ...f.choice, research: f.research, comparedItemId: issue === "wrong-comparable" ? "999" : "789" }],
			};
		};
		f.services.callTool = async (tool, parameters) => {
			if (tool === "zhixia.context") return { siteId: 1 };
			if (tool === "xiaohongshu.search-notes") return [note];
			if (tool === "xiaohongshu.read-photo") return { data: "eA==" };
			if (tool === "zhixia.hot-word-items")
				return {
					rows: [
						{
							itemId: "789",
							shopId: "19",
							siteId: issue === "wrong-site" ? 2 : 1,
							itemName: issue === "other-product" ? "手機保護貼" : "戶外防水可調式手機掛繩",
							itemDataList: [{ sales30Day: 20, timest: issue === "old-sales" ? "20200101" : today.replaceAll("-", "") }],
						},
					],
				};
			if (tool === "listing.collect-source" && issue === "reused") {
				const saved = (await originalCall(tool, parameters)) as Record<string, unknown>;
				return { ...saved, status: "existing" };
			}
			return originalCall(tool, parameters);
		};
		const run = await createSelectionRunner(memoryStore(), f.services).start(input, `social-${issue}`);
		assert.equal(run.status, "completed", run.error ?? issue);
		assert.equal(run.found, qualifies && issue !== "reused" ? 1 : 0, issue);
		assert.equal(
			f.calls.some((call) => call.tool === "listing.collect-source"),
			qualifies,
			issue,
		);
		if (!qualifies && issue !== "wrong-comparable") assert.ok(!f.calls.some((call) => call.tool === "1688.search"), issue);
		if (issue === "reused") {
			assert.equal(run.candidates[0]?.status, "existing");
			assert.match(run.events.at(-1)?.message ?? "", /目标已达成/);
			assert.equal(run.events.filter((event) => event.data?.kind === "plan").length, 1);
		}
		if (issue === "none") {
			assert.equal(run.candidates[0]?.qualification, "priced");
			assert.equal(run.candidates[0]?.social?.note.reference.part, 2);
			assert.equal(run.candidates[0]?.social?.purchases[0]?.itemId, "789");
		}
	}
});

test("新版研究持久化真实事实、本批步骤核对及候选研究；保存回执独立于模型分析", async () => {
	const f = reviewedFixture();
	const run = await createSelectionRunner(memoryStore(), f.services).start(reviewedConfig(), "reviewed-research");
	assert.equal(run.status, "completed");
	assert.equal(f.requestCount(), 2, "沿用原规划及筛选，不新增逐步骤模型请求");
	assert.deepEqual(run.candidates[0]?.research, f.research);
	assert.equal(run.candidates[0]?.receipt?.sourceId, "7");
	assert.ok(!run.candidates[0]?.evidence.includes("X2保存回执"), "分析证据和真实保存回执分字段");
	const facts = run.events.find((event) => event.data?.kind === "query")?.data;
	assert.equal(facts?.kind, "query");
	if (facts?.kind !== "query") throw new Error("缺真实查询事实");
	assert.equal(facts.fact.purchaseSignal, true);
	assert.equal(facts.fact.searchSignal, true);
	assert.equal(facts.fact.updateTime, "2026-11-16");
	assert.equal(facts.fact.demandScope, "keyword-category-or-whole-listing");
	const analysis = run.events.find((event) => event.data?.kind === "analysis")?.data;
	if (analysis?.kind !== "analysis") throw new Error("缺本批核对产物");
	assert.deepEqual(analysis.audit, f.audit);
	assert.deepEqual(analysis.research[0], { offerId: "123", skuId: "456", ...f.research });
	assert.ok(run.events.some((event) => event.data?.kind === "tool" && event.data.tool === "1688.offer" && event.data.result));
	assert.ok(run.events.some((event) => event.data?.kind === "plan"));
	assert.ok(run.events.some((event) => event.data?.kind === "stop"));
});

test("搜索信号不能冒充购买验证，未知购买证据及待补仍可进入研究备选", async () => {
	const f = reviewedFixture(),
		original = f.services.callTool;
	f.research.demandLevel = "search";
	f.services.callTool = async (tool, input) => {
		if (tool === "zhixia.hot-words") return { rows: [{ hotWordId: 5, word: "手機掛繩", searchVal: 100, sales30day: null }], updateTime: "2026-11-16" };
		if (tool === "zhixia.hot-word-items") return { rows: [{ itemId: "789", itemDataList: [{ sales30Day: null }] }] };
		return original(tool, input);
	};
	const run = await createSelectionRunner(memoryStore(), f.services).start(reviewedConfig(), "search-is-not-purchase");
	assert.equal(run.status, "completed");
	assert.equal(run.found, 1);
	const data = run.events.find((event) => event.data?.kind === "query")?.data;
	if (data?.kind !== "query") throw new Error("缺真实查询事实");
	assert.equal(data.fact.searchSignal, true);
	assert.equal(data.fact.purchaseSignal, null);
	assert.match(run.candidates[0]?.warnings?.join("；") ?? "", /购买.*未.*验证/);
	assert.equal(run.candidates[0]?.research?.demandLevel, "search");
});

test("空白市场指标保留未知，只有明确的零才表示没有搜索或购买信号", async () => {
	for (const [raw, signal] of [
		[" \t ", null],
		["0", false],
		[" 5 ", true],
	] as const) {
		const f = fixture(),
			original = f.services.callTool;
		f.services.callTool = async (tool, input) => {
			if (tool === "zhixia.hot-words") return { rows: [{ hotWordId: 5, word: "手機掛繩", searchVal: raw, sales30day: raw }], updateTime: null };
			if (tool === "zhixia.hot-word-items") return { rows: [{ itemId: "789", itemDataList: [{ sales30Day: raw }] }] };
			return original(tool, input);
		};
		const run = await createSelectionRunner(memoryStore(), f.services).start(config(), `market-number-${String(signal)}`);
		assert.equal(run.status, "completed");
		const data = run.events.find((event) => event.data?.kind === "query")?.data;
		if (data?.kind !== "query") throw new Error("缺真实查询事实");
		assert.equal(data.fact.searchSignal, signal);
		assert.equal(data.fact.purchaseSignal, signal);
	}
});

test("新版缺研究核对、伪造事实引用及缺项却称有证据均先拒绝，不保存前面的合法候选", async () => {
	for (const fault of [
		"missing-audit",
		"missing-research",
		"invented-query",
		"invented-offer",
		"purchase-without-purchase",
		"missing-but-supported",
		"all-supported-with-missing",
		"incomplete-steps",
		"false-save-claim",
	] as const) {
		const f = reviewedFixture(),
			originalAsk = f.services.ask,
			originalCall = f.services.callTool;
		f.services.ask = async (input) => {
			const answer = (await originalAsk(input)) as Record<string, unknown>;
			if (!("candidates" in answer)) return answer;
			if (fault === "missing-audit") delete answer.audit;
			if (fault === "missing-research") answer.candidates = [f.choice];
			if (fault === "invented-query") f.research.queryFactIndexes = [99];
			if (fault === "invented-offer") f.audit.steps[0]!.offerIds = ["999"];
			if (fault === "missing-but-supported") f.audit.steps[0]!.status = "supported";
			if (fault === "all-supported-with-missing")
				for (const step of f.audit.steps) {
					step.status = "supported";
					step.missing = [];
				}
			if (fault === "incomplete-steps") f.audit.steps.pop();
			if (fault === "false-save-claim") answer.summary = "已保存到备选编号88";
			return answer;
		};
		if (fault === "purchase-without-purchase")
			f.services.callTool = async (tool, input) => {
				if (tool === "zhixia.hot-words") return { rows: [{ hotWordId: 5, word: "手機掛繩", searchVal: 100, sales30day: null }], updateTime: null };
				if (tool === "zhixia.hot-word-items") return { rows: [] };
				return originalCall(tool, input);
			};
		const run = await createSelectionRunner(memoryStore(), f.services).start(reviewedConfig(), `invalid-audit-${fault}`);
		assert.equal(run.status, "failed", fault);
		assert.ok(!f.calls.some((call) => call.tool === "listing.collect-source"), fault);
		assert.match(run.error ?? "", /研究核对|研究结论|证据|步骤|引用/, fault);
	}
});

test("爆款周边分别读取主品与周边；主品购买信号不能代替周边，主品不被当成本次货源", async () => {
	const f = reviewedFixture(),
		originalCall = f.services.callTool;
	f.research.purchaseTask = "手机携带时使用挂绳收纳配件";
	f.research.demandLevel = "unknown";
	f.research.queryFactIndexes = [0, 1];
	for (const step of f.audit.steps) step.queryFactIndexes = [0, 1];
	f.services.ask = async (input) => {
		if (input.schema.properties && typeof input.schema.properties === "object" && "focus" in input.schema.properties)
			return {
				focus: "主品与周边独立研究",
				queries: [
					{ keyword: "手機", sourceKeyword: "手机", categoryPath: [100, 101], role: "main" },
					{ keyword: "手機掛繩", sourceKeyword: "手机带", categoryPath: [100, 101], role: "accessory" },
				],
			};
		return { summary: "主品有购买线索，周边保留待验证", audit: f.audit, candidates: [{ ...f.choice, research: f.research }] };
	};
	f.services.callTool = async (tool, input) => {
		if (tool === "zhixia.hot-words")
			return {
				rows: [
					{ hotWordId: 6, word: "手機", searchVal: 100, sales30day: 20 },
					{ hotWordId: 5, word: "手機掛繩", searchVal: null, sales30day: null },
				],
				updateTime: "2026-11-16",
			};
		if (tool === "zhixia.hot-word-items") return { rows: input.word === 6 ? [{ itemId: "789", itemDataList: [{ sales30Day: 20 }] }] : [] };
		return originalCall(tool, input);
	};
	const input = reviewedConfig();
	input.strategy.id = "bestseller-accessories";
	const run = await createSelectionRunner(memoryStore(), f.services).start(input, "independent-accessory");
	assert.equal(run.status, "completed");
	assert.equal(run.found, 1);
	const queries = run.events.flatMap((event) => (event.data?.kind === "query" ? [event.data] : []));
	assert.deepEqual(
		queries.map((data) => data.fact.query.role),
		["main", "accessory"],
	);
	assert.equal(queries[0]?.fact.purchaseSignal, true);
	assert.equal(queries[1]?.fact.purchaseSignal, null);
	assert.deepEqual(
		f.calls.filter((call) => call.tool === "1688.search").map((call) => call.input.keyword),
		["手机带"],
	);
	assert.equal(run.candidates[0]?.research?.demandLevel, "unknown");
	assert.match(run.candidates[0]?.warnings?.join("；") ?? "", /周边.*购买.*未.*验证/);
	const collected = f.calls.filter((call) => call.tool === "listing.collect-source").length;
	f.research.demandLevel = "purchase";
	f.research.queryFactIndexes = [0, 1];
	const borrowed = await createSelectionRunner(memoryStore(), f.services).start(input, "cannot-borrow-main-purchase");
	assert.equal(borrowed.status, "failed");
	assert.match(borrowed.error ?? "", /主品购买线索不能替代周边购买证据/);
	assert.equal(f.calls.filter((call) => call.tool === "listing.collect-source").length, collected);
});

test("新版爆款周边缺独立周边查询即停止，不能沿用主品查询挑货源", async () => {
	const f = reviewedFixture(),
		input = reviewedConfig();
	input.strategy.id = "bestseller-accessories";
	const run = await createSelectionRunner(memoryStore(), f.services).start(input, "accessory-missing-query");
	assert.equal(run.status, "failed");
	assert.match(run.error ?? "", /主品.*周边.*独立查询/);
	assert.ok(!f.calls.some((call) => call.tool === "1688.search"));
});

test("普通策略拒绝模型借用主品或周边查询角色，自定义步骤不能扩大执行范围", async () => {
	for (const id of ["peer-benchmark", "unmet-needs", "bundle-sales"] as const) {
		const f = reviewedFixture();
		const input = reviewedConfig();
		input.strategy.id = id;
		input.strategy.steps = ["将选品当作主品查询"];
		f.services.ask = async () => ({
			focus: "试图改变查询角色",
			queries: [{ keyword: "手機", sourceKeyword: "手机", categoryPath: [100, 101], role: "main" }],
		});
		const run = await createSelectionRunner(memoryStore(), f.services).start(input, `wrong-query-role-${id}`);
		assert.equal(run.status, "failed");
		assert.match(run.error ?? "", /仅接受候选商品查询角色/);
		assert.ok(!f.calls.some((call) => ["zhixia.hot-words", "1688.search", "listing.collect-source"].includes(call.tool)));
	}
});

test("新版周边研究必须引用本批主品事实；主品购买未知仍可保留未知，不新增需求门槛", async () => {
	for (const referencesMain of [false, true]) {
		const f = reviewedFixture(),
			originalCall = f.services.callTool,
			input = reviewedConfig();
		input.strategy.id = "bestseller-accessories";
		f.research.demandLevel = "unknown";
		f.research.queryFactIndexes = referencesMain ? [0, 1] : [1];
		for (const step of f.audit.steps) step.queryFactIndexes = [0, 1];
		f.services.ask = async (request) => {
			if (request.schema.properties && typeof request.schema.properties === "object" && "focus" in request.schema.properties)
				return {
					focus: "主品与周边购买均待验证",
					queries: [
						{ keyword: "手機", sourceKeyword: "手机", categoryPath: [100, 101], role: "main" },
						{ keyword: "手機掛繩", sourceKeyword: "手机带", categoryPath: [100, 101], role: "accessory" },
					],
				};
			return { summary: "按真实查询保留主品与周边未知证据", audit: f.audit, candidates: [{ ...f.choice, research: f.research }] };
		};
		f.services.callTool = async (tool, params) => {
			if (tool === "zhixia.hot-words")
				return {
					rows: [
						{ hotWordId: 6, word: "手機", searchVal: null, sales30day: null },
						{ hotWordId: 5, word: "手機掛繩", searchVal: null, sales30day: null },
					],
					updateTime: null,
				};
			if (tool === "zhixia.hot-word-items") return { rows: [] };
			return originalCall(tool, params);
		};
		const run = await createSelectionRunner(memoryStore(), f.services).start(input, `main-evidence-reference-${referencesMain}`);
		assert.equal(run.status, referencesMain ? "completed" : "failed");
		if (referencesMain) {
			assert.equal(run.found, 1);
			assert.equal(run.candidates[0]?.research?.demandLevel, "unknown");
			const main = run.events.find((event) => event.data?.kind === "query" && event.data.fact.query.role === "main")?.data;
			if (main?.kind !== "query") throw new Error("缺主品查询事实");
			assert.equal(main.fact.purchaseSignal, null);
		} else {
			assert.match(run.error ?? "", /周边.*主品.*引用|周边.*引用.*主品/);
			assert.ok(!f.calls.some((call) => call.tool === "listing.collect-source"));
		}
	}
});

test("本批后一候选研究引用无效时整份先拒绝，不把前面合法候选保存", async () => {
	const f = reviewedFixture(),
		originalAsk = f.services.ask,
		originalCall = f.services.callTool;
	f.services.ask = async (input) => {
		const answer = (await originalAsk(input)) as Record<string, unknown>;
		if ("candidates" in answer)
			answer.candidates = [
				{ ...f.choice, research: f.research },
				{ ...f.choice, offerId: "124", research: { ...f.research, queryFactIndexes: [99] } },
			];
		return answer;
	};
	f.services.callTool = async (tool, input) => {
		const result = await originalCall(tool, input);
		if (tool === "1688.search") return { rows: [{ offerId: "123" }, { offerId: "124" }] };
		if (tool === "1688.offer") return { ...f.offer, offerId: String(input.id), url: `https://detail.1688.com/offer/${String(input.id)}.html` };
		return result;
	};
	const run = await createSelectionRunner(memoryStore(), f.services).start(reviewedConfig(), "all-research-before-save");
	assert.equal(run.status, "failed");
	assert.match(run.error ?? "", /研究证据引用/);
	assert.ok(!f.calls.some((call) => call.tool === "listing.collect-source"));
});

test("店铺优惠事实只持久必要摘要，不把券码、账户或敏感字段带入研究记录", async () => {
	const f = reviewedFixture(),
		originalCall = f.services.callTool,
		input = reviewedConfig();
	input.sellerDiscountTwd = null;
	f.services.callTool = async (tool, params) =>
		tool === "shopee.vouchers"
			? { rows: [{ voucher_code: "PRIVATE-COUPON-9", account: "PRIVATE-ACCOUNT-9", start_time: 1, end_time: 9999999999 }], next: null }
			: originalCall(tool, params);
	const run = await createSelectionRunner(memoryStore(), f.services).start(input, "private-promotion-summary");
	assert.equal(run.status, "completed");
	const data = run.events.find((event) => event.data?.kind === "tool" && event.data.tool === "shopee.vouchers")?.data;
	if (data?.kind !== "tool") throw new Error("缺优惠读取摘要");
	assert.deepEqual(data.result, { rowCount: 1, totalCount: null, paginationComplete: true, errorCount: null });
	assert.ok(!JSON.stringify(run).includes("PRIVATE-"));
	assert.match(run.candidates[0]?.warnings?.join("；") ?? "", /卖家优惠仍未知/);
});

test("本批明确停止原因会保留真实产物与不足名额，不再次强行规划", async () => {
	const f = reviewedFixture();
	f.audit.stopReason = "剩余方向的关键适配资料不足，没有合理补查方向";
	const run = await createSelectionRunner(memoryStore(), f.services).start({ ...reviewedConfig(), limit: 3 }, "analysis-stop-reason");
	assert.equal(run.status, "completed");
	assert.equal(run.found, 1);
	assert.equal(f.requestCount(), 2);
	const data = run.events.at(-1)?.data;
	assert.deepEqual(data, { kind: "stop", reason: f.audit.stopReason, added: 1, existing: 0 });
});

test("绑定市场站点先读真实context，并将expectedSiteId传给每个知虾调用，不传给其他工具", async () => {
	for (const strategyId of ["peer-benchmark", "unmet-needs", "bestseller-accessories"] as const) {
		const f = fixture(),
			original = f.services.callTool,
			input = config();
		input.marketSiteId = 1;
		input.strategy.id = strategyId;
		f.services.callTool = async (tool, params) => {
			if (tool === "zhixia.context" || tool === "zhixia.similar-1688") {
				f.calls.push({ tool, input: params });
				return tool === "zhixia.context" ? { siteId: 1, siteName: "台湾" } : { rows: [] };
			}
			const result = await original(tool, params);
			return tool === "zhixia.hot-word-items"
				? { rows: [{ itemId: "789", imgUrl: "https://example.test/real-item.jpg", itemDataList: [{ sales30Day: 20 }] }], next: null }
				: result;
		};
		const run = await createSelectionRunner(memoryStore(), f.services).start(input, `bound-market-${strategyId}`);
		assert.equal(run.status, "completed");
		const marketCalls = f.calls.filter((call) => call.tool.startsWith("zhixia."));
		assert.equal(marketCalls[0]?.tool, "zhixia.context");
		assert.ok(marketCalls.length >= 6);
		assert.ok(marketCalls.every((call) => call.input.expectedSiteId === 1));
		assert.ok(f.calls.filter((call) => !call.tool.startsWith("zhixia.")).every((call) => !Object.hasOwn(call.input, "expectedSiteId")));
		if (strategyId === "unmet-needs") assert.ok(marketCalls.some((call) => call.tool === "zhixia.complaints"));
		if (strategyId === "bestseller-accessories") assert.ok(marketCalls.some((call) => call.tool === "zhixia.long-tail"));
		const context = run.events.find((event) => event.data?.kind === "tool" && event.data.tool === "zhixia.context")?.data;
		if (context?.kind !== "tool") throw new Error("缺真实站点上下文记录");
		assert.deepEqual(context.input, { expectedSiteId: 1 });
		assert.deepEqual(context.result, { siteId: 1, siteName: "台湾" });
	}
});

test("初始站点不符或读取期间切换站点立即需人工处理，不继续读取货源或保存", async () => {
	for (const mismatchAt of ["zhixia.context", "zhixia.competition"]) {
		const f = fixture(),
			original = f.services.callTool,
			input = config();
		input.marketSiteId = 1;
		f.services.callTool = async (tool, params) => {
			if (tool === "zhixia.context") {
				f.calls.push({ tool, input: params });
				return { siteId: mismatchAt === tool ? 2 : 1 };
			}
			if (tool === mismatchAt) {
				f.calls.push({ tool, input: params });
				assert.equal(params.expectedSiteId, 1);
				throw new NeedsHuman("知虾站点不符：预期1，当前2；请先切换站点");
			}
			return original(tool, params);
		};
		const run = await createSelectionRunner(memoryStore(), f.services).start(input, `market-mismatch-${mismatchAt}`);
		assert.equal(run.status, "needs-human");
		assert.match(run.error ?? "", /站点.*预期1.*当前2/);
		assert.equal(run.found, 0);
		assert.ok(!f.calls.some((call) => call.tool.startsWith("1688.") || call.tool === "listing.collect-source"));
		assert.equal(f.calls.at(-1)?.tool, mismatchAt);
	}
});

function trendFixture(values = [...Array<number>(9).fill(50), ...Array<number>(7).fill(100), ...Array<number>(7).fill(110), ...Array<number>(7).fill(130)]) {
	const f = reviewedFixture(),
		original = f.services.callTool,
		input = reviewedConfig();
	input.strategy = { ...input.strategy, id: "rising-demand", name: "近期趋势攀升", trend: trendParameters };
	input.marketSiteId = 1;
	const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
	const charts = values
		.map((sales, index) => ({
			timest: new Date(Date.parse(`${today}T00:00:00Z`) - (values.length - 1 - index) * 86_400_000).toISOString().slice(0, 10).replaceAll("-", ""),
			sales: String(sales),
		}))
		.reverse();
	f.services.callTool = async (tool, params) => {
		if (tool === "zhixia.context" || tool === "zhixia.demand-change" || tool === "selection.time-series-summary") {
			f.calls.push({ tool, input: params });
			if (tool === "zhixia.context") return { siteId: 1, siteName: "中国台湾" };
			if (tool === "zhixia.demand-change") return { charts };
			return summarizeTimeSeries(timeSeriesInputSchema.parse(params));
		}
		return original(tool, params);
	};
	return { ...f, input, charts };
}

test("趋势流程按策略快照读取一轮超过三个的热词，仍逐个筛查", async () => {
	const f = trendFixture(Array<number>(30).fill(100));
	f.input.limit = 10;
	f.input.strategy.trend = { ...trendParameters, maxQueriesPerRound: 8 };
	const queries = Array.from({ length: 8 }, (_, i) => ({ keyword: `熱詞${i}`, sourceKeyword: `采购词${i}`, categoryPath: [100, 101] }));
	let planned = false;
	f.services.ask = async () => {
		if (planned) return { focus: "没有新的方向", decision: "stop", queries: [] };
		planned = true;
		return { focus: "覆盖八个独立方向", queries };
	};
	const original = f.services.callTool;
	f.services.callTool = async (tool, input) =>
		tool === "zhixia.hot-words"
			? { updateTime: null, rows: queries.map(({ keyword }, i) => ({ word: keyword, hotWordId: i + 1, searchVal: 100, sales30day: 50 })) }
			: original(tool, input);
	const run = await createSelectionRunner(memoryStore(), f.services).start(f.input, "trend-expanded-queries");
	assert.equal(run.status, "completed");
	assert.equal(run.found, 0);
	assert.equal(run.events.filter((event) => event.data?.kind === "query").length, 8);
	assert.equal(f.calls.filter(({ tool }) => tool === "zhixia.demand-change").length, 8);
	assert.ok(!f.calls.some(({ tool }) => tool.startsWith("1688.")));
});

test("两个合格趋势方向分别筛选并只引用各自市场事实", async () => {
	const f = trendFixture();
	f.input.limit = 2;
	const queries = [
		{ keyword: "手機掛繩", sourceKeyword: "手机带", categoryPath: [100, 101] },
		{ keyword: "編織掛繩", sourceKeyword: "编织挂绳", categoryPath: [100, 101] },
	];
	let batch = 0;
	f.services.ask = async (input) => {
		if (input.schema.properties && typeof input.schema.properties === "object" && "focus" in input.schema.properties) return { focus: "两个真实热词", queries };
		const index = batch++;
		const offerId = String(123 + index);
		assert.match(input.prompt, new RegExp(`marketFactIndex=${index}`));
		assert.doesNotMatch(input.prompt, new RegExp(`"offerId":"${124 - index}"`));
		return {
			summary: "保留来源自身的趋势与规格",
			audit: { ...f.audit, steps: f.audit.steps.map((step) => ({ ...step, queryFactIndexes: [index], offerIds: [offerId] })) },
			candidates: [{ ...f.choice, offerId, research: { ...f.research, queryFactIndexes: [index] } }],
		};
	};
	const original = f.services.callTool;
	f.services.callTool = async (tool, input) => {
		if (tool === "zhixia.hot-words")
			return { updateTime: null, rows: queries.map(({ keyword }, i) => ({ word: keyword, hotWordId: i + 5, searchVal: 100, sales30day: 50 })) };
		if (tool === "1688.search" && input.keyword === "编织挂绳") return { rows: [{ offerId: "124", title: "编织挂绳" }] };
		if (tool === "1688.offer" && input.id === "124") return { ...f.offer, offerId: "124", url: "https://detail.1688.com/offer/124.html" };
		if (tool === "listing.collect-source" && input.link === "https://detail.1688.com/offer/124.html")
			return { sourceId: "8", offerId: "124", title: "编织挂绳", status: "added", problems: [] };
		return original(tool, input);
	};
	const run = await createSelectionRunner(memoryStore(), f.services).start(f.input, "trend-facts-per-keyword");
	assert.equal(run.status, "completed", run.error ?? undefined);
	assert.equal(run.found, 2);
	assert.deepEqual(
		run.candidates.map((candidate) => candidate.research?.queryFactIndexes),
		[[0], [1]],
	);
});

test("新趋势流程使用真实原生词绑定完整30点；样本观察值可作初筛并保存，口径局限随证据保留", async () => {
	const f = trendFixture(),
		original = f.services.callTool;
	f.services.callTool = async (tool, params) =>
		tool === "zhixia.hot-words"
			? {
					rows: [
						{ hotWordId: 999, word: "手機", searchVal: 99999, sales30day: 99999 },
						{ hotWordId: 5, word: "手機掛繩", searchVal: 100, sales30day: 50 },
					],
					updateTime: null,
				}
			: original(tool, params);
	const run = await createSelectionRunner(memoryStore(), f.services).start(f.input, "trend-observed-basis");
	assert.equal(run.status, "completed");
	assert.equal(run.found, 1);
	assert.equal(run.error, null);
	assert.ok(f.calls.some((call) => call.tool === "listing.collect-source"));
	assert.deepEqual(f.calls.find((call) => call.tool === "zhixia.demand-change")?.input, { word: 5, expectedSiteId: 1 });
	const calculation = f.calls.find((call) => call.tool === "selection.time-series-summary");
	assert.ok(calculation);
	assert.equal((calculation.input.points as unknown[]).length, 30, "全量传统计工具，不能被模型8项摘要截断");
	assert.equal(Object.hasOwn(calculation.input, "expectedSiteId"), false);
	assert.equal(Object.hasOwn(calculation.input, "source"), false, "来源说明随查询留底，不作为纯统计参数");
	const data = run.events.find((event) => event.data?.kind === "query")?.data;
	if (data?.kind !== "query") throw new Error("缺查询事实");
	assert.equal(data.fact.trend?.wordId, 5);
	assert.equal(data.fact.trend?.word, "手機掛繩");
	assert.equal(data.fact.trend?.basis, "observed");
	assert.equal(data.fact.trend?.qualified, true);
	const summary = data.fact.trend?.summary as { observationComparable: boolean; dailyComparable: boolean; recent: { total: number | null } };
	assert.equal(summary.observationComparable, true);
	assert.equal(summary.dailyComparable, false);
	assert.equal(summary.recent.total, null);
	assert.match(JSON.stringify(data.fact.trend?.source), /前10页/);
	assert.ok(run.events.some((event) => event.step === "趋势统计通过" && event.message.includes("观察值")));
	assert.match(run.candidates[0]?.evidence ?? "", /聚合窗口未知/);
	assert.match(run.candidates[0]?.warnings?.join("；") ?? "", /样本成员或排名可能变化/);
});

test("样本观察值的下降、低基数、单点尖峰或缺日均不通过，不读取货源凑数", async () => {
	for (const values of [
		[...Array<number>(7).fill(130), ...Array<number>(7).fill(110), ...Array<number>(7).fill(100)],
		[...Array<number>(7).fill(1), ...Array<number>(7).fill(2), ...Array<number>(7).fill(3)],
		[...Array<number>(20).fill(100), 1000],
		null,
	]) {
		const f = values ? trendFixture(values) : trendFixture();
		if (!values) f.charts.splice(3, 1, { ...f.charts[4]! });
		const run = await createSelectionRunner(memoryStore(), f.services).start(f.input, `trend-observed-rejected-${JSON.stringify(values)}`);
		assert.equal(run.status, "completed");
		assert.equal(run.found, 0);
		assert.ok(!f.calls.some((call) => call.tool.startsWith("1688.") || call.tool === "listing.collect-source"));
		const data = run.events.find((event) => event.data?.kind === "query")?.data;
		if (data?.kind !== "query") throw new Error("缺查询事实");
		assert.equal(data.fact.trend?.qualified, false);
		assert.ok(data.fact.trend?.reasons.length);
	}
});

test("趋势查询必须精确匹配原生词；宽泛主词的高销量不得触发趋势或货源搜索", async () => {
	const f = trendFixture(),
		original = f.services.callTool;
	f.services.callTool = async (tool, params) =>
		tool === "zhixia.hot-words" ? { rows: [{ hotWordId: 999, word: "手機", searchVal: 99999, sales30day: 99999 }], updateTime: null } : original(tool, params);
	const run = await createSelectionRunner(memoryStore(), f.services).start(f.input, "trend-parent-word-blocked");
	assert.equal(run.status, "completed");
	assert.equal(run.found, 0);
	assert.ok(!f.calls.some((call) => call.tool === "zhixia.demand-change" || call.tool === "selection.time-series-summary" || call.tool.startsWith("1688.")));
	assert.ok(run.events.some((event) => event.message.includes("精确原生热词")));
});

test("趋势读取遇到登录或站点阻断立即停止，统计结果不能替换外部序列口径", async () => {
	for (const fault of ["needs-human", "wrong-basis"] as const) {
		const f = trendFixture(),
			original = f.services.callTool;
		f.services.callTool = async (tool, params) => {
			if (tool === "zhixia.demand-change" && fault === "needs-human") throw new NeedsHuman("请确认知虾站点与登录");
			if (tool === "selection.time-series-summary" && fault === "wrong-basis")
				return summarizeTimeSeries({ ...timeSeriesInputSchema.parse(params), basis: "daily" });
			return original(tool, params);
		};
		const run = await createSelectionRunner(memoryStore(), f.services).start(f.input, `trend-${fault}`);
		assert.equal(run.status, fault === "needs-human" ? "needs-human" : "completed");
		assert.equal(run.found, 0);
		assert.ok(!f.calls.some((call) => call.tool.startsWith("1688.") || call.tool === "listing.collect-source"));
		assert.ok(run.events.some((event) => event.message.includes(fault === "needs-human" ? "登录" : "口径与真实序列不一致")));
	}
});

test("已读到类目时规划合同要求至少一个真实类目编号，未读到类目时仍兼容空路径", async () => {
	for (const categoriesAvailable of [true, false]) {
		const f = fixture(),
			originalAsk = f.services.ask,
			originalCall = f.services.callTool;
		let minimum: number | undefined;
		f.services.callTool = async (tool, input) => {
			if (tool === "zhixia.categories" && !categoriesAvailable) throw new Error("类目暂不可读");
			return originalCall(tool, input);
		};
		f.services.ask = async (input) => {
			if (input.schema.properties && typeof input.schema.properties === "object" && "focus" in input.schema.properties) {
				const properties = input.schema.properties as { focus: unknown; queries: { items: { properties: { categoryPath: { minItems?: number } } } } };
				minimum = properties.queries.items.properties.categoryPath.minItems;
				if (!categoriesAvailable) return { focus: "保留类目未知", queries: [{ keyword: "手機掛繩", sourceKeyword: "手机带", categoryPath: [] }] };
				assert.match(input.prompt, /已读到真实类目.*不得.*空|已读.*类目.*不能.*空/);
			}
			return originalAsk(input);
		};
		const run = await createSelectionRunner(memoryStore(), f.services).start(config(), `category-schema-${categoriesAvailable}`);
		assert.equal(run.status, "completed");
		assert.equal(run.found, 1);
		assert.equal(minimum, categoriesAvailable ? 1 : undefined);
	}
});

test("已读到类目却返回空路径的旧模型输出明确失败，不假装没有可读类目继续找货源", async () => {
	const f = fixture();
	f.services.ask = async () => ({ focus: "跳过市场", queries: [{ keyword: "手機掛繩", sourceKeyword: "手机带", categoryPath: [] }] });
	const run = await createSelectionRunner(memoryStore(), f.services).start(config(), "empty-path-rejected");
	assert.equal(run.status, "failed");
	assert.equal(run.found, 0);
	assert.match(run.error ?? "", /已读到真实类目.*空/);
	assert.ok(!f.calls.some((call) => call.tool === "zhixia.hot-words" || call.tool.startsWith("1688.") || call.tool === "listing.collect-source"));
});
