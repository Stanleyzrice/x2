// 筛字：每张原图问一次 Gemini，图上有什么字，决定下一步。提示照 lilto 第 4 版（legacy/lib/image_workflow.py，快照 1c8a7926）：
// d 删（供应商痕迹：工厂直供、批发、联系方式、二维码、人民币低价……；写给 1688 买家的说明：售后、退换货、定制、色差尺寸的免责、「亲」的口吻，
// 译得再好也不该出现在我们的商品里）；r 拿不准（品牌、IP、看不清）；m 营销字（后加的文案，送象寄译成繁体）；
// p 产品本体上的字（拍到的，象寄会涂坏，不送）；n 没字。长提示偶尔回空，换短提示兜底；两次都答不出就报错，不当成「不用译」。
// 和 lilto 不一样的一处：r 在 lilto 里直接放行（真数据里占 18%），带简体营销字的图就这样漏过去了。这里 r 再问一次有没有后加的简体字：有就当 m 送去译

import type { Verdict } from "../../domain/listing/pics.ts";
import type { Image } from "../../services/gemini.ts";
import { gemini } from "./queue.ts";

export const SCREEN_VERSION = 5;
export const VERDICT_NAME: Record<Verdict, string> = { d: "删", r: "拿不准", m: "营销字", p: "产品字", n: "没字" };

export const SCREEN_PROMPT = `这是电商商品图。先判断是否含有不适合零售上架的货源痕迹,再把其余图片按文字类型分类。只输出一个小写字母:
d = 出现以下任一内容,整张图必须删除:工厂直供、厂家直销、源头厂家、批发、一件代发、OEM、ODM、MADE IN CHINA、中国制造/中國製造、公司名称、店铺名称、联系方式、网址、二维码、无关水印或其他供应商身份信息；或出现面向中国采购端的人民币低价承诺/价格促销，例如¥/￥、几元/塊、只要3元、低至、亏本/虧本、冲量/沖量、厂价/工廠價、批发价/批發價。商品数量如“5卷”本身不算,只有与明确人民币价格或低价促销组合时才答 d；或出现写给1688买家的说明:售后、退换货、退货运费、定制(来图定制、随心定制)、色差和尺寸的免责(望亲谅解)、「亲」的口吻
r = 出现品牌名称、商标、IP 角色、原创品牌宣传,或看不清、被遮挡,或不确定某个名称/标志属于商品品牌还是供应商公司/店铺/水印。当前策略只记录并直接放行,不删、不改、不拦截
m = 有营销/说明文字:后期叠加在图上的文案、标题、卖点、参数表格、标签框、促销角标等(简体中文,需要翻译成繁体给台湾买家看)
p = 只有产品本体上的文字:印在实物表面的字(仪器刻度、表盘、按键、铭牌、包装印刷),没有任何后期叠加的文案
n = 完全没有文字
判断顺序:只要命中 d 的内容,即使同时有商品卖点也必须答 d;拿不准答 r。否则营销文字是"画上去的",产品文字是"拍到的"。两者都有时答 m。只输出 d、r、m、p 或 n。`;

export const SCREEN_FALLBACK_PROMPT =
	"这是电商商品图。只输出一个小写字母：d=含工厂/OEM/ODM/MADE IN CHINA/中国制造/公司店铺名/联系方式/二维码/供应商水印，或含¥/￥/几元/只要X元/低至/亏本冲量/厂价批发价等人民币低价承诺（单独商品数量不算），或是写给1688买家的售后、退换货、退货运费、定制、色差尺寸免责（望亲谅解）、「亲」的口吻，删除；r=品牌商标、IP 角色或不确定，记录后直接放行；m=后期营销说明文字；p=只有产品本体文字；n=完全无字。";

export const R_PROMPT =
	"这是电商商品图。图上有没有后期叠加的简体中文文字（文案、标题、卖点、参数表、标签、角标等画上去的字，不算实物本身印的字和品牌商标）？有答 y，没有答 n。只输出 y 或 n。";

/** 模型的回答 → 一个字母。去掉空白、反引号、标点，转小写，整个是同一个字母（可以重复）才算；「marketing」「m or p」都不算 */
export function parseVerdict(text: string): Verdict | null {
	const t = text.replace(/[\s`'"“”‘’.,，。:：;；!！?？()（）[\]【】-]/g, "").toLowerCase();
	const m = /^([dmprn])\1*$/.exec(t);
	return m ? (m[1] as Verdict) : null;
}

/** 筛一张图：先长提示，答不出换短提示；r 再问一次有没有后加的简体字。都答不出抛错 */
export async function screen(img: Image): Promise<{ verdict: Verdict; raw: string; simplified?: boolean }> {
	let raw = await gemini(SCREEN_PROMPT, [img]);
	let verdict = parseVerdict(raw);
	if (!verdict) {
		raw = await gemini(SCREEN_FALLBACK_PROMPT, [img]);
		verdict = parseVerdict(raw);
	}
	if (!verdict) throw new Error(`Gemini 没答出图上是什么字（回「${raw.slice(0, 40)}」）：这张图先不往下做`);
	if (verdict !== "r") return { verdict, raw };
	const yn = (await gemini(R_PROMPT, [img])).trim().toLowerCase().replace(/[^yn]/g, "");
	if (yn !== "y" && yn !== "n") throw new Error("Gemini 没答出拿不准的图上有没有简体字：这张图先不往下做");
	return { verdict, raw, simplified: yn === "y" };
}
