// 采集会话边界：固定本机发起页、平台商品地址与当前列表页，不把另一页或非商品链接纳入批量。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Challenge } from "../errors.ts";
import { CollectionQueue, type CollectionSession, collectionPageUrl, collectionResultUrl, collectionUrl, sameCollectionPage } from "./collection.ts";

const marker = "cfd004bd-de72-4b38-921c-3957f8e08aba";
const config = { hosts: ["1688.com"], linkPattern: "detail\\.1688\\.com/offer/\\d+\\.html" };
const progress = (): CollectionSession => ({
	id: "test-session",
	site: "test-site",
	browserId: "test-browser",
	browserLabel: "Ego",
	tabId: 1,
	url: "https://example.com/list?page=1",
	status: "browsing",
	mode: null,
	currentUrl: null,
	pendingUrls: [],
	queued: 0,
	cancelled: 0,
	stopping: false,
	acknowledgedSeq: 0,
	epoch: 0,
	scanned: 0,
	processed: 0,
	added: 0,
	existing: 0,
	failed: 0,
	total: null,
	complete: false,
	error: null,
	results: [],
});

test("首件读取阻塞时仍接纳后续快速点击，按FIFO串行读取并去重当前与等待商品", async () => {
	const first = Promise.withResolvers<{ status: "added" }>();
	const started = Promise.withResolvers<void>();
	const called: string[] = [];
	const state = progress();
	const queue = new CollectionQueue(
		state,
		async (url) => {
			called.push(url);
			if (url === "a") {
				started.resolve();
				return first.promise;
			}
			return { status: "added" };
		},
		async () => {},
	);
	queue.submit("a", "a?from=one");
	await started.promise;
	assert.equal(queue.submit("b", "b?from=one"), true);
	assert.equal(queue.submit("c"), true);
	assert.equal(queue.submit("a", "a?from=two"), false);
	assert.equal(queue.submit("b", "b?from=two"), false);
	assert.deepEqual(called, ["a"]);
	assert.equal(state.currentUrl, "a?from=one");
	assert.deepEqual(state.pendingUrls, ["b?from=one", "c"]);
	assert.equal(state.queued, 2);
	assert.equal(state.total, 3);
	first.resolve({ status: "added" });
	await queue.wait();
	assert.deepEqual(called, ["a", "b", "c"]);
	assert.deepEqual(
		state.results.map((item) => [item.url, item.submittedUrl, item.status]),
		[
			["a", "a?from=one", "added"],
			["b", "b?from=one", "added"],
			["c", "c", "added"],
		],
	);
	assert.equal(state.processed, 3);
	assert.equal(state.added, 3);
	assert.equal(state.complete, true);
	assert.equal(state.currentUrl, null);
	assert.equal(state.queued, 0);
	assert.equal(state.mode, null);
});

test("单件失败保留失败结果，后续商品继续；已处理的同件可再次检查而不永久锁定", async () => {
	const state = progress();
	const called: string[] = [];
	const queue = new CollectionQueue(
		state,
		async (url) => {
			called.push(url);
			if (url === "a") throw new Error("这件商品读取失败");
			return { status: called.length > 2 ? "exists" : "added" };
		},
		async () => {},
	);
	queue.submit("a");
	queue.submit("b");
	await queue.wait();
	assert.deepEqual(called, ["a", "b"]);
	assert.equal(state.failed, 1);
	assert.equal(state.added, 1);
	assert.equal(state.processed, 2);
	assert.equal(state.complete, false);
	assert.equal(state.results[0]?.status, "failed");
	queue.submit("b");
	await queue.wait();
	assert.deepEqual(called, ["a", "b", "b"]);
	assert.equal(state.existing, 1);
	assert.equal(state.complete, true);
});

test("API停止取消等待项，进行中请求的真实结果保留；旧epoch迟到点击不会重启", async () => {
	const first = Promise.withResolvers<{ status: "added" }>();
	const started = Promise.withResolvers<void>();
	const state = progress();
	const called: string[] = [];
	const queue = new CollectionQueue(
		state,
		async (url) => {
			called.push(url);
			started.resolve();
			return first.promise;
		},
		async () => {},
	);
	queue.acknowledge(1, 0);
	queue.submit("a");
	await started.promise;
	queue.submit("b");
	queue.submit("c");
	queue.cancel("已停止，等待项已取消");
	assert.equal(state.acknowledgedSeq, 1);
	assert.equal(state.epoch, 1);
	assert.equal(state.stopping, true);
	assert.equal(state.currentUrl, "a");
	assert.equal(state.queued, 0);
	assert.equal(state.cancelled, 2);
	assert.equal(queue.acknowledge(2, 0), "stale");
	assert.equal(queue.submit("d", "d", 0), false);
	first.resolve({ status: "added" });
	await queue.wait();
	assert.deepEqual(called, ["a"]);
	assert.equal(state.added, 1);
	assert.equal(state.processed, 1);
	assert.equal(state.cancelled, 3);
	assert.equal(state.total, 4);
	assert.equal(state.status, "stopped");
	assert.equal(state.stopping, false);
	assert.equal(state.complete, false);
	assert.deepEqual(
		state.results.map((item) => [item.url, item.status]),
		[
			["b", "cancelled"],
			["c", "cancelled"],
			["d", "cancelled"],
			["a", "added"],
		],
	);
	assert.ok(state.results.filter((item) => item.status === "cancelled").every((item) => item.error));
});

test("同一轮快速加入后立即停止，worker尚未开始也不覆盖stopped状态或读取商品", async () => {
	const state = progress();
	const called: string[] = [];
	const queue = new CollectionQueue(
		state,
		async (url) => {
			called.push(url);
			return { status: "added" };
		},
		async () => {},
	);
	queue.submit("a");
	queue.cancel("立即停止");
	await queue.wait();
	assert.deepEqual(called, []);
	assert.equal(state.status, "stopped");
	assert.equal(state.cancelled, 1);
	assert.equal(state.processed, 0);
	assert.equal(state.stopping, false);
	assert.equal(state.complete, false);
});

test("验证码读取异常终止后续等待项，不将整列商品逐个打成读取失败", async () => {
	const state = progress();
	const called: string[] = [];
	const queue = new CollectionQueue(
		state,
		async (url) => {
			called.push(url);
			throw new Challenge("平台要求手动验证");
		},
		async () => {},
	);
	queue.submit("a");
	queue.submit("b");
	await queue.wait();
	assert.deepEqual(called, ["a"]);
	assert.equal(state.status, "error");
	assert.equal(state.processed, 1);
	assert.equal(state.failed, 1);
	assert.equal(state.cancelled, 1);
	assert.match(state.results.find((item) => item.url === "b")?.error ?? "", /手动验证/);
});

test("进行中读取完成后发现断线或离站，保留已完成结果并明确取消未开始项", async () => {
	const first = Promise.withResolvers<{ status: "added" }>();
	const started = Promise.withResolvers<void>();
	const state = progress();
	const called: string[] = [];
	let connected = true;
	const queue = new CollectionQueue(
		state,
		async (url) => {
			called.push(url);
			started.resolve();
			return first.promise;
		},
		async () => {
			if (!connected) throw new Error("采集标签已离开平台");
		},
	);
	queue.submit("a");
	await started.promise;
	queue.submit("b");
	connected = false;
	first.resolve({ status: "added" });
	await queue.wait();
	assert.deepEqual(called, ["a"]);
	assert.equal(state.added, 1);
	assert.equal(state.cancelled, 1);
	assert.equal(state.failed, 0);
	assert.equal(state.status, "error");
	assert.match(state.results.find((item) => item.url === "b")?.error ?? "", /离开平台/);
});

test("整页与单件互斥，整页进行中收到单件会明确取消，不能替换整页worker", async () => {
	const first = Promise.withResolvers<{ status: "added" }>();
	const started = Promise.withResolvers<void>();
	const state = progress();
	const called: string[] = [];
	const queue = new CollectionQueue(
		state,
		async (url) => {
			called.push(url);
			started.resolve();
			return first.promise;
		},
		async () => {},
	);
	queue.prepare("all");
	const work = queue.all(["a", "b"], true);
	await started.promise;
	assert.equal(queue.submit("c"), false);
	assert.equal(state.mode, "all");
	assert.equal(state.cancelled, 1);
	queue.cancel("停止整页");
	first.resolve({ status: "added" });
	await work;
	assert.deepEqual(called, ["a"]);
	assert.equal(state.added, 1);
	assert.equal(state.cancelled, 2);
	assert.equal(state.status, "stopped");
});

test("确认序号去重，停止屏障区分旧命令与新命令", () => {
	const state = progress();
	const queue = new CollectionQueue(
		state,
		async () => ({ status: "added" }),
		async () => {},
	);
	assert.equal(queue.acknowledge(8, 0), "current");
	assert.equal(queue.acknowledge(7, 0), "duplicate");
	queue.cancel("已停止");
	assert.equal(queue.acknowledge(9, 0), "stale");
	assert.equal(queue.acknowledge(state.acknowledgedSeq + 1, state.epoch), "current");
	assert.equal(state.acknowledgedSeq, 10);
});

test("采集只用当前本机X2页的单次标记，不接受远程页、重复标记或带凭据的地址", () => {
	const value = `http://127.0.0.1:5199/?x2BrowserConnect=${marker}#listing-collection`;
	assert.equal(collectionPageUrl(value, marker), value);
	for (const bad of [
		value.replace("127.0.0.1", "example.com"),
		value.replace("http:", "https:"),
		value.replace("/?", "/child?"),
		`${value.split("#")[0]}&x2BrowserConnect=${marker}`,
		value.replace("127.0.0.1", "user:pass@127.0.0.1"),
	])
		assert.throws(() => collectionPageUrl(bad, marker));
	assert.throws(() => collectionPageUrl(value, "------------------------------------"));
});

test("结果页路由由调用方指定，保留原本机服务和其它查询参数，移除临时连接标记", () => {
	assert.equal(
		collectionResultUrl(`http://127.0.0.1:5199/?view=all&x2BrowserConnect=${marker}#browser`, "saved-items"),
		"http://127.0.0.1:5199/?view=all#saved-items",
	);
	assert.equal(collectionResultUrl(`http://localhost:5199/?x2BrowserConnect=${marker}`, "#review"), "http://localhost:5199/#review");
});

test("只接受当前平台的商品详情链接，拒绝伪后缀、脚本、凭据与列表导航", () => {
	assert.equal(collectionUrl("http://detail.1688.com/offer/123.html#sku", config), "https://detail.1688.com/offer/123.html");
	for (const value of [
		"https://detail.1688.com.evil.com/offer/123.html",
		"javascript:alert(1)",
		"https://user:password@detail.1688.com/offer/123.html",
		"https://s.1688.com/offer_search.htm?page=2",
	])
		assert.equal(collectionUrl(value, config), null);
});

test("商品链接的canonical由调用方提供，平台层不认识站点ID，同商品tracking只产生一条地址", () => {
	const scoped = { ...config, canonicalize: (value: string) => `https://detail.1688.com${new URL(value).pathname}` };
	assert.equal(
		collectionUrl("https://detail.1688.com/offer/123.html?spm=first", scoped),
		collectionUrl("https://detail.1688.com/offer/123.html?spm=second", scoped),
	);
	assert.equal(collectionUrl("https://detail.1688.com/offer/123.html", { ...config, canonicalize: () => "https://evil.com/offer/123.html" }), null);
});

test("列表分页或筛选变化必须停止；同页hash定位不算翻页", () => {
	const initial = "https://s.1688.com/selloffer/offer_search.htm?keywords=slippers&page=1";
	assert.equal(sameCollectionPage(initial, `${initial}#top`), true);
	assert.equal(sameCollectionPage(initial, initial.replace("page=1", "page=2")), false);
	assert.equal(sameCollectionPage(initial, initial.replace("slippers", "pajamas")), false);
	assert.equal(sameCollectionPage(initial, "https://detail.1688.com/offer/123.html"), false);
});
