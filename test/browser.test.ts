// 浏览器：选哪个浏览器、排队、在页面里发请求、认出登录页和 1688 的滑块验证
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { z } from "zod";
import { alibabaCookie, choose } from "../platform/browser/accounts.ts";
import { challengeOf, guarded, loginPage, siteOf } from "../platform/browser/browser.ts";
import { runOp, type Site } from "../platform/cli.ts";
import { Challenge, NeedsHuman, Usage } from "../platform/errors.ts";
import { get, str } from "../platform/tool.ts";

test("网址是哪个站点：1688 的各个子域都是 1688，不认识的是 null", () => {
	assert.equal(siteOf("https://seller.shopee.tw/portal/product/new"), "shopee");
	for (const u of [
		"https://www.1688.com",
		"https://s.1688.com/selloffer/offer_search.htm",
		"https://detail.1688.com/offer/1.html",
		"https://air.1688.com/app/x.html",
		"https://cart.1688.com/cart.htm",
	])
		assert.equal(siteOf(u), "1688");
	assert.equal(siteOf("https://c.chanboss.com/order/orderList"), "chanboss");
	assert.equal(siteOf("https://shopee.mobduos.com/workbench/home"), "zhixia");
	assert.equal(siteOf("https://login.taobao.com/"), null);
	assert.equal(siteOf("https://example.com/"), null);
});

const page = (p: Partial<{ url: string; frames: string[]; slider: boolean; text: string }>) => ({
	url: "https://s.1688.com/selloffer/offer_search.htm?keywords=x",
	frames: [],
	slider: false,
	text: "",
	...p,
});

test("1688 的滑块验证：整页跳到验证页、页面上弹出验证框（iframe）、看得见的滑块都算", () => {
	// 2026-10-10 三个 agent 同时搜 1688 时落到的两种（x5secdata 换成了 xxx）
	assert.equal(challengeOf(page({ url: "https://s.1688.com//selloffer/offer_search.htm/_____tmd_____/punish?x5secdata=xxx" })), true);
	assert.equal(
		challengeOf(
			page({
				frames: [
					"https://g.alicdn.com/x.html",
					"https://h5api.m.1688.com//h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/_____tmd_____/punish?x5secdata=xxx",
				],
			}),
		),
		true,
	);
	assert.equal(challengeOf(page({ slider: true })), true);
	assert.equal(challengeOf(page({ text: "亲，请拖动下方滑块完成验证 通过验证以确保正常访问" })), true);
});

test("不算滑块验证：没登录时跳转经过的 login_jump、普通页面、字多的页面偶然提到滑块、登录页上的滑块", () => {
	assert.equal(challengeOf(page({ url: "https://www.1688.com:443/_____tmd_____/page/login_jump?rand=xxx" })), false);
	assert.equal(challengeOf(page({})), false);
	assert.equal(challengeOf(page({ text: `${"商品介绍。".repeat(500)}拖动滑块开门的智能门锁` })), false);
	assert.equal(challengeOf(page({ text: "请按住滑块，拖动到最右边。登录" })), false);
});

test("登录页：主机名是 login.、passport.、accounts. 开头的，或路径里有 login、signin", () => {
	assert.equal(loginPage("https://login.taobao.com/?redirect_url=https%3A%2F%2Flogin.1688.com%2F&style=tao_custom&from=1688web"), true);
	assert.equal(loginPage("https://login.1688.com/member/jump.htm?target=x"), true);
	assert.equal(loginPage("https://accounts.shopee.tw/seller/login?next=x"), true);
	assert.equal(loginPage("https://seller.shopee.tw/account/signin?next=x"), true);
	assert.equal(loginPage("https://www.1688.com/"), false);
	assert.equal(loginPage("https://detail.1688.com/offer/1054637079650.html"), false);
	assert.equal(loginPage("https://s.1688.com//selloffer/offer_search.htm/_____tmd_____/punish?x5secdata=xxx"), false);
});

const shop = (id: string, name: string, login: boolean, error: Error | null = null) => ({ id, name, login, error });

test("按登录选浏览器：只有一个登录着的用它；Shopee 几家都登录着要 --shop；别的站点用第一个登录着的", () => {
	assert.equal(choose("shopee", [shop("a", "cheeroutdoor", true), shop("b", "b", false)]), "a");
	assert.throws(
		() => choose("shopee", [shop("a", "cheeroutdoor", true), shop("b", "ni1206", true)]),
		(e: Error) => e instanceof Usage && /--shop/.test(e.message) && /cheeroutdoor、ni1206/.test(e.message),
	);
	assert.equal(choose("1688", [shop("a", "", false), shop("b", "", true)]), "b");
	assert.equal(choose("chanboss", [shop("a", "", true), shop("b", "", true)]), "a");
	assert.equal(choose("zhixia", [shop("a", "", true)]), "a");
});

test("按登录选浏览器：一个都没登录着要人处理；有跳了滑块验证的，说滑块验证（不说没登录）", () => {
	assert.throws(
		() => choose("chanboss", [shop("a", "", false), shop("b", "", false, new NeedsHuman("chanboss 没有登录"))]),
		(e: Error) => e instanceof NeedsHuman && !(e instanceof Challenge) && /没有登录着 chanboss 的浏览器/.test(e.message),
	);
	const slider = new Challenge("1688 要过滑块验证：在 cheeroutdoor 的浏览器里拉一下再重试");
	assert.throws(
		() => choose("1688", [shop("a", "", false, new NeedsHuman("1688 没有登录")), shop("b", "", false, slider)]),
		(e: Error) => e === slider,
	);
	assert.throws(() => choose("shopee", []), NeedsHuman);
});

/** 假的页面：地址、iframe（宽 0 是看不见的），够 look() 用 */
function fakePage(url: string, frames: { src: string; width: number }[] = []) {
	return vm.createContext({
		location: { href: url },
		document: {
			body: { textContent: "", innerText: "" },
			querySelectorAll: (sel: string) =>
				sel === "iframe" ? frames.map((f) => ({ src: f.src, getBoundingClientRect: () => ({ width: f.width, height: f.width }) })) : [],
		},
		setInterval,
		clearInterval,
	});
}
const PUNISH = "https://h5api.m.1688.com//h5/mtop.x/2.0/_____tmd_____/punish?x5secdata=xxx";

test("1688 页面里跑的表达式：没有验证照常跑；有验证（整页、看得见的验证框）不跑；跑的时候验证框弹出来就不等了", async () => {
	// 和 cdp-relay 一样按 JSON 拿回来（vm 里的对象原型不一样，直接比不相等）
	const run = async (code: string, ctx: vm.Context) => JSON.parse(JSON.stringify(await vm.runInContext(code, ctx)));
	assert.deepEqual(
		await run(
			guarded((a: number, b: string) => `${a + 1}${b}`, [41, "!"]),
			fakePage("https://s.1688.com/x"),
		),
		{ x2: "ok", value: "42!" },
	);
	assert.deepEqual(
		await run(
			guarded(async () => "x", []),
			fakePage("https://s.1688.com/x", [{ src: PUNISH, width: 0 }]),
		),
		{ x2: "ok", value: "x" },
	);
	let ran = false;
	const never = () => {
		ran = true;
		return "跑了";
	};
	assert.deepEqual(await run(guarded(never, []), fakePage("https://s.1688.com//selloffer/offer_search.htm/_____tmd_____/punish?x5secdata=xxx")), {
		x2: "challenge",
	});
	assert.deepEqual(await run(guarded(never, []), fakePage("https://s.1688.com/x", [{ src: PUNISH, width: 300 }])), { x2: "challenge" });
	assert.equal(ran, false);
	// 请求挂着（lib.mtop 等人过验证）：0.2 秒后弹出验证框，1 秒内就回
	const frames: { src: string; width: number }[] = [];
	const t0 = Date.now();
	setTimeout(() => frames.push({ src: PUNISH, width: 300 }), 200);
	assert.deepEqual(
		await run(
			guarded(() => new Promise(() => {}), []),
			fakePage("https://air.1688.com/x", frames),
		),
		{ x2: "challenge" },
	);
	assert.ok(Date.now() - t0 < 1000);
});

test("--shop 只有 Shopee 收；要写哪家店；帮助里写着", async () => {
	const ops = { thing: get("一样东西", z.object({ id: str("id") }), async (p) => p) };
	const plain: Site = { describe: "没有店", ops };
	const shopee: Site = { describe: "按店", ops, shop: true };
	await assert.rejects(
		runOp("plain", plain, ["thing", "--id", "1", "--shop", "ni1206"]),
		(e: Error) => e instanceof Usage && /没有参数 --shop/.test(e.message),
	);
	await assert.rejects(runOp("shopee", shopee, ["thing", "--id", "1", "--shop"]), (e: Error) => e instanceof Usage && /--shop 后面写哪家店/.test(e.message));
	assert.deepEqual(await runOp("shopee", shopee, ["thing", "--id", "1"]), { value: { id: "1" } });
	const help = await runOp("shopee", shopee, ["thing", "--help"]);
	assert.ok("help" in help && /--shop <店>/.test(help.help));
});

test("1688 的 cookie：__cn_logon__ 说登录着没有；没有这个 cookie 是看不出（要开页面认）", () => {
	assert.equal(
		alibabaCookie(
			new Map([
				["__cn_logon__", "true"],
				["unb", "1"],
			]),
		),
		true,
	);
	assert.equal(alibabaCookie(new Map([["__cn_logon__", "false"]])), false);
	assert.equal(alibabaCookie(new Map([["cna", "x"]])), null);
	assert.equal(alibabaCookie(null), null);
});
