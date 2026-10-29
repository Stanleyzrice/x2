// 代码放哪（AGENTS.md「代码放哪」）：src 下只有这几个文件夹；外面的网站不引业务，业务不引命令和网页，网页的界面只引自己；
// 每个文件开头一段注释说它做什么。破例不加白名单：放错了就搬，规则不对就改这里和 AGENTS.md
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

/** src 下的文件夹 → 运行时不能 import 的（import type 不算：类型不带代码进来） */
const NOT: Record<string, string[]> = {
	sites: ["orders", "listing", "loop", "cli", "web"],
	db: ["sites", "orders", "listing", "loop", "cli", "web"],
	orders: ["cli", "web"],
	listing: ["cli", "web"],
	loop: ["cli", "web"],
	cli: [],
};
/** src 根上只放这两个：错误分类、读 .env */
const ROOT_FILES = ["src/env.ts", "src/errors.ts"];

const files = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? (["node_modules", "dist"].includes(e.name) ? [] : files(join(dir, e.name))) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
	);
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");
/** 一个文件在哪：src 下的文件夹名；src 根上的是 src；web/ui 的是 ui；web 的是 web */
const placeOf = (f: string) => {
	const p = rel(f).split("/");
	if (p[0] === "src") return p.length === 2 ? "src" : p[1]!;
	if (p[0] === "web") return p[1] === "ui" ? "ui" : "web";
	return p[0]!;
};

/** 一个文件的 import：from 什么、是不是只 import type（连 export … from、动态 import） */
function imports(file: string): { spec: string; typeOnly: boolean }[] {
	const s = readFileSync(file, "utf8");
	const out: { spec: string; typeOnly: boolean }[] = [];
	for (const m of s.matchAll(/^(import|export)\s+(type\s+)?([^;]*?)\s*from\s+"([^"]+)";?/gms)) {
		const names = m[3]!.trim();
		const typeOnly =
			Boolean(m[2]) ||
			(/^\{[^}]*\}$/s.test(names) &&
				names
					.replace(/[{}\s]/g, "")
					.split(",")
					.filter(Boolean)
					.every((n) => n.startsWith("type")));
		out.push({ spec: m[4]!, typeOnly });
	}
	for (const m of s.matchAll(/^import\s+"([^"]+)";?/gm)) out.push({ spec: m[1]!, typeOnly: false });
	for (const m of s.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) out.push({ spec: m[1]!, typeOnly: false });
	return out;
}
/** 相对 import 指到的文件；@/ 是 web/ui */
const target = (file: string, spec: string) =>
	spec.startsWith("@/") ? join(ROOT, "web/ui", spec.slice(2)) : spec.startsWith(".") ? resolve(join(file, ".."), spec) : null;

const SRC = files(join(ROOT, "src"));
const UI = files(join(ROOT, "web/ui")).filter((f) => !rel(f).startsWith("web/ui/components/ui/"));

test("src 下只有 sites、db、orders、listing、loop、cli，根上只有 env.ts、errors.ts", () => {
	const loose = SRC.filter((f) => (placeOf(f) === "src" ? !ROOT_FILES.includes(rel(f)) : !(placeOf(f) in NOT)));
	assert.deepEqual(loose.map(rel), []);
});

test("外面的网站不引业务；业务不引命令和网页；没人引命令（除了 bin）", () => {
	const bad: string[] = [];
	for (const f of [...SRC, ...files(join(ROOT, "web")).filter((f) => placeOf(f) === "web")]) {
		for (const { spec, typeOnly } of imports(f)) {
			const to = target(f, spec);
			if (!to || typeOnly) continue;
			const from = placeOf(f),
				where = placeOf(to);
			if (NOT[from]?.includes(where) || (where === "cli" && from !== "cli")) bad.push(`${rel(f)} → ${rel(to)}`);
		}
	}
	assert.deepEqual(bad, []);
});

test("网页的界面（web/ui）只引自己，src 和网页的服务只 import type", () => {
	const bad = UI.flatMap((f) =>
		imports(f).flatMap(({ spec, typeOnly }) => {
			const to = target(f, spec);
			return to && !typeOnly && placeOf(to) !== "ui" ? [`${rel(f)} → ${rel(to)}`] : [];
		}),
	);
	assert.deepEqual(bad, []);
});

test("每个文件开头一段注释说它做什么（#! 那行之后；shadcn 拷来的 components/ui 不算）", () => {
	const all = [
		...SRC,
		...files(join(ROOT, "bin")),
		...files(join(ROOT, "test")),
		...files(join(ROOT, "web")).filter((f) => !rel(f).startsWith("web/ui/components/ui/")),
	];
	const bare = all.filter((f) => !/^(#![^\n]*\n)?\/\/ \S/.test(readFileSync(f, "utf8")));
	assert.deepEqual(bare.map(rel), []);
});
