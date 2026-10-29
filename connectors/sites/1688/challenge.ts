// 1688（阿里系风控）的滑块验证：怎么认（注册进浏览器：browser.ts 在页面里跑的时候一直看着，认出来就停，不等到超时）
import type { Challenger } from "../../../platform/browser/browser.ts";

export type Look = { url: string; frames: string[]; slider: boolean; text: string };

/** 阿里系风控的滑块验证（纯函数，也整个放进页面里跑：不引用外面的东西）。认这几样：
 * 页面、或页面上看得见的 iframe 落在验证页（/_____tmd_____/punish，2026-10-10 三个 agent 同时搜 1688 时落到的：整页跳到
 * s.1688.com//selloffer/offer_search.htm/_____tmd_____/punish?x5secdata=…，或页面上弹一层，iframe 是 h5api.m.1688.com/…/_____tmd_____/punish?…）；
 * 页面上有看得见的滑块（#nc_1_wrapper、.nc_wrapper、.baxia-dialog）；整页字很少、写着拖动滑块、通过验证以确保正常访问（登录页上的滑块不算）。
 * 没登录时跳转经过的 /_____tmd_____/page/login_jump 不算 */
export function challengeOf(p: Look): boolean {
	const punish = (u: string) => /\/_____tmd_____\/punish/.test(u);
	if (punish(p.url) || p.frames.some(punish) || p.slider) return true;
	return p.text.length > 0 && p.text.length <= 2000 && /拖动.{0,8}滑块|滑块验证|通过验证以确保正常访问/.test(p.text) && !/登录|登陆|密码/.test(p.text);
}

export function look(): Look {
	const shown = (el: Element) => {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	};
	const body = document.body;
	return {
		url: location.href,
		frames: Array.from(document.querySelectorAll("iframe"))
			.filter(shown)
			.map((f) => f.src),
		slider: Array.from(document.querySelectorAll("#nc_1_wrapper, .nc_wrapper, .baxia-dialog")).some(shown),
		text: body && (body.textContent ?? "").length < 20000 ? body.innerText.slice(0, 5000) : "",
	};
}

export const SLIDER: Challenger = { look, seen: challengeOf, url: (url) => challengeOf({ url, frames: [], slider: false, text: "" }) };
