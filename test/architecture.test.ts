// 代码放哪、谁能 import 谁（AGENTS.md「代码放哪」）：src 下每个文件在一层里，运行时的 import 只往里指；domain 只算，不碰库、站点、外部服务；
// 每个文件开头一段注释说它做什么。破例不加白名单：放错了就搬，规则不对就改这里和 AGENTS.md
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

/** 层 → 运行时能 import 的层（import type 不算：类型不带代码进来） */
const MAY: Record<string, string[]> = {
	core: ["core"],
	domain: ["domain"],
	sites: ["core", "domain", "sites"],
	services: ["core", "services"],
	flows: ["core", "domain", "sites", "services", "flows"],
	commands: ["core", "domain", "sites", "services", "flows", "commands", "web"],
	web: ["core", "domain", "sites", "flows", "web"],
};
/** domain 能用的包：只算，不碰库、网络、文件 */
const DOMAIN_PACKAGES = new Set(["zod", "opencc-js", "node:crypto"]);

const files = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");
const layerOf = (f: string) => rel(f).split("/")[1]!;

/** 一个文件的 import：from 什么、是不是只 import type（连 export … from、动态 import） */
function imports(file: string): { spec: string; typeOnly: boolean }[] {
	const s = readFileSync(file, "utf8");
	const out: { spec: string; typeOnly: boolean }[] = [];
	for (const m of s.matchAll(/^(import|export)\s+(type\s+)?([^;]*?)\s*from\s+"([^"]+)";/gms)) {
		const names = m[3]!;
		const typeOnly =
			Boolean(m[2]) ||
			(/^\{[^}]*\}$/s.test(names.trim()) &&
				names
					.replace(/[{}\s]/g, "")
					.split(",")
					.filter(Boolean)
					.every((n) => n.startsWith("type")));
		out.push({ spec: m[4]!, typeOnly });
	}
	for (const m of s.matchAll(/^import\s+"([^"]+)";/gm)) out.push({ spec: m[1]!, typeOnly: false });
	for (const m of s.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) out.push({ spec: m[1]!, typeOnly: false });
	return out;
}

const SRC = files(join(ROOT, "src"));

test("src 下每个文件都在一层里（core、domain、sites、services、flows、commands、web），不放在 src 根上", () => {
	const loose = SRC.filter((f) => !(layerOf(f) in MAY) || rel(f).split("/").length < 3);
	assert.deepEqual(loose.map(rel), []);
});

test("运行时的 import 只往里指；domain 只用 zod、opencc-js、node:crypto", () => {
	const bad: string[] = [];
	for (const f of SRC) {
		const from = layerOf(f);
		for (const { spec, typeOnly } of imports(f)) {
			if (spec.startsWith(".")) {
				const to = resolve(join(f, ".."), spec);
				if (!to.startsWith(join(ROOT, "src") + sep)) bad.push(`${rel(f)} → ${spec}（出了 src）`);
				else if (!typeOnly && !MAY[from]!.includes(layerOf(to))) bad.push(`${rel(f)}（${from}）→ ${rel(to)}（${layerOf(to)}）`);
			} else if (from === "domain" && !typeOnly && !DOMAIN_PACKAGES.has(spec)) bad.push(`${rel(f)}（domain）→ ${spec}`);
		}
	}
	assert.deepEqual(bad, []);
});

test("bin 只接线：只 import commands、core；网页（web/）只 import web/ 里的，src 的只 import type", () => {
	const bad: string[] = [];
	for (const f of files(join(ROOT, "bin")))
		for (const { spec } of imports(f)) {
			const to = rel(resolve(join(f, ".."), spec));
			if (spec.startsWith(".") && !/^src\/(commands|core)\//.test(to)) bad.push(`${rel(f)} → ${to}`);
		}
	for (const f of files(join(ROOT, "web")).filter((f) => !f.includes(`${sep}dist${sep}`)))
		for (const { spec, typeOnly } of imports(f)) {
			if (!spec.startsWith(".")) continue;
			const to = rel(resolve(join(f, ".."), spec));
			if (!to.startsWith("web/") && !typeOnly) bad.push(`${rel(f)} → ${to}`);
		}
	assert.deepEqual(bad, []);
});

test("每个文件开头一段注释说它做什么（#! 那行之后）", () => {
	const all = [
		...SRC,
		...files(join(ROOT, "bin")),
		...files(join(ROOT, "test")),
		...files(join(ROOT, "web")).filter((f) => !f.includes(`${sep}dist${sep}`) && !f.includes(`${sep}components${sep}ui${sep}`)),
	];
	const bare = all.filter((f) => !/^(#![^\n]*\n)?\/\/ \S/.test(readFileSync(f, "utf8")));
	assert.deepEqual(bare.map(rel), []);
});
