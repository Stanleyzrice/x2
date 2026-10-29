// 站点的读操作声明：x2 <站点> <操作> 的通用入口用它（先例 steampipe 的表：参数是 key columns，list 的翻页藏在操作里）。
// 每个操作：说明、参数（zod，命令行的 --名字 值 经它校验、转换）、怎么读。两种：
// - get：读一个东西，回一个值
// - list：读一列行，一次一页；回这一页的行和下一页的 cursor（null 是到底了）。入口按 --pages 翻，输出 { rows, next }
// 只收读：写（加购、预报……）声明在 writes.ts，只经 x2 do（人在终端里同意了），不进通用入口
import { z } from "zod";

export type Page = { rows: unknown[]; next: string | null };

export type Op =
	| { kind: "get"; describe: string; params: z.ZodObject; run: (p: any) => Promise<unknown> }
	| { kind: "list"; describe: string; params: z.ZodObject; run: (p: any, cursor: string | null) => Promise<Page> };

export type Ops = Record<string, Op>;

const none = z.object({});

export function get<P extends z.ZodObject = typeof none>(describe: string, params: P | undefined, run: (p: z.output<P>) => Promise<unknown>): Op {
	return { kind: "get", describe, params: params ?? none, run };
}

export function list<P extends z.ZodObject = typeof none>(
	describe: string,
	params: P | undefined,
	run: (p: z.output<P>, cursor: string | null) => Promise<Page>,
): Op {
	return { kind: "list", describe, params: params ?? none, run };
}

/** 按页码翻的 list：fetch 读第 n 页，回这一页的行和还有没有下一页 */
export function byPage<P extends z.ZodObject = typeof none>(
	describe: string,
	params: P | undefined,
	fetch: (p: z.output<P>, n: number) => Promise<{ rows: unknown[]; more: boolean }>,
	first = 1,
): Op {
	return list(describe, params, async (p, cursor) => {
		const n = cursor === null ? first : Number(cursor);
		const { rows, more } = await fetch(p, n);
		return { rows, next: more && rows.length > 0 ? String(n + 1) : null };
	});
}

/** 只有一页的 list：读来的就是全部 */
export function all<P extends z.ZodObject = typeof none>(describe: string, params: P | undefined, fetch: (p: z.output<P>) => Promise<unknown[]>): Op {
	return list(describe, params, async (p) => ({ rows: await fetch(p), next: null }));
}

// ── 参数的类型：命令行上都是字符串，在这里转换 ──

/** 字符串（id 一律是字符串：Shopee、1688 的订单号超过 JS 数字的精度） */
export const str = (describe: string) => z.string().min(1).describe(describe);
/** 数字 */
export const num = (describe: string) => z.coerce.number().describe(describe);
/** 开关：--名字 是 true，--名字 false 是 false */
export const flag = (describe: string) => z.preprocess((v) => (v === "false" ? false : v === "true" ? true : v), z.boolean()).describe(describe);
/** 逗号分隔的一列字符串，例 --ids 1,2,3 */
export const strs = (describe: string) =>
	z
		.preprocess(
			(v) =>
				typeof v === "string"
					? v
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean)
					: v,
			z.array(z.string()).min(1),
		)
		.meta({ description: describe, placeholder: "a,b,…" });
/** 逗号分隔的一列整数，例 --path 100629,100630 */
export const ints = (describe: string) =>
	z
		.preprocess(
			(v) =>
				typeof v === "string"
					? v
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean)
							.map(Number)
					: v,
			z.array(z.number().int()),
		)
		.meta({ description: describe, placeholder: "1,2,…" });

/** 给 z.preprocess 用：命令行上的 JSON 字符串 → 值；不是合法 JSON 原样留着，让后面的校验报成用法不对（不是一般错误） */
export const parseJson = (v: unknown) => {
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return v;
	}
};

const DAY = 86400,
	TW = 8 * 3600;
/** 台湾时间的一天：YYYY-MM-DD → 那天零点的秒数（end 时是那天 23:59:59）；给的是秒数原样用 */
export const day = (describe: string, end = false) =>
	z
		.preprocess((v) => {
			if (typeof v !== "string") return v;
			if (/^\d+$/.test(v)) return Number(v);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
			const start = Date.parse(`${v}T00:00:00Z`) / 1000 - TW;
			return end ? start + DAY - 1 : start;
		}, z.number().int())
		.meta({ description: `${describe}（台湾时间；也可以给秒）`, placeholder: "YYYY-MM-DD" });
