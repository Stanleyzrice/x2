// 外部系统的回包进来就解析：connector 拿到网站、服务的回包，先照 zod 的形状解析成它要交出去的样子，之后的代码信类型，不再层层 String(x ?? "")。
// 形状只写用到的格：z.looseObject 留着没写的格（命令行照旧回原样数据），网站多加一格不坏；用到的格少了、类型变了才报错。
// 对不上是「回包变了」：说哪个站、哪个接口、哪一格不对（退出码 1）。网站改版是人要知道的事，不猜着往下做
import { z } from "zod";

export function reply<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
	const r = schema.safeParse(value);
	if (r.success) return r.data;
	throw new Error(
		`${where} 的回包变了：${r.error.issues
			.slice(0, 3)
			.map((i) => issue(i, value))
			.join("；")}`,
	);
}

const pathOf = (path: readonly PropertyKey[]) =>
	path.map((k, i) => (typeof k === "number" ? `[${k}]` : i === 0 ? String(k) : `.${String(k)}`)).join("") || "（整个回包）";

function at(value: unknown, path: readonly PropertyKey[]): unknown {
	let v = value;
	for (const k of path) v = v !== null && typeof v === "object" ? (v as Record<PropertyKey, unknown>)[k] : undefined;
	return v;
}

const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function issue(i: z.core.$ZodIssue, value: unknown): string {
	const where = pathOf(i.path);
	const expected =
		i.code === "invalid_type"
			? i.expected
			: i.code === "invalid_union"
				? [...new Set(i.errors.flat().flatMap((e) => (e.code === "invalid_type" ? [e.expected] : [])))].join(" 或 ")
				: "";
	if (!expected) return `${where}：${i.message}`;
	const got = at(value, i.path);
	return got === undefined ? `${where} 没有了（应该是 ${expected}）` : `${where} 应该是 ${expected}，回的是 ${kind(got)} ${JSON.stringify(got)?.slice(0, 60)}`;
}

/** 网站的 id 有时是数字、有时是字符串：一律收成字符串（订单号超过 JS 数字的精度，接口给字符串的就用字符串那一格） */
export const idText = z.union([z.string(), z.number()]).transform(String);
/** 数字有时写成字符串（例 "12.50"）：收成数字，照 Number 的规矩（认不出是 NaN，和原来 Number(x) 一样） */
export const numeric = z.union([z.number(), z.string()]).transform(Number);
