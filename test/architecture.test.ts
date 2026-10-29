// 代码放哪（AGENTS.md「改代码」）：平台（platform）、连接器（connectors：sites 经浏览器、services 用 API key）、skill（skills：一个 skill 管一类事）；
// 网页的界面只引自己；每个文件开头一段注释说它做什么；文档只放在几个固定的地方，提到的仓库里的文件都在。破例不加白名单：放错了就搬，规则不对就改这里和 AGENTS.md
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

const files = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? (["node_modules", "dist"].includes(e.name) ? [] : files(join(dir, e.name))) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
	);
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

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
/** 相对 import 指到的文件；@/ 是 platform/ui */
const target = (file: string, spec: string) =>
	spec.startsWith("@/") ? join(ROOT, "platform/ui", spec.slice(2)) : spec.startsWith(".") ? resolve(join(file, ".."), spec) : null;

const SHADCN = "platform/ui/components/ui/";
const CODE = ["bin", "platform", "connectors", "skills", "test"].flatMap((d) => files(join(ROOT, d))).filter((f) => !rel(f).startsWith(SHADCN));
const UI = CODE.filter((f) => rel(f).startsWith("platform/ui/"));

test("网页的界面（platform/ui）只引自己，别的只 import type", () => {
	const bad = UI.flatMap((f) =>
		imports(f).flatMap(({ spec, typeOnly }) => {
			const to = target(f, spec);
			return to && !typeOnly && !rel(to).startsWith("platform/ui/") ? [`${rel(f)} → ${rel(to)}`] : [];
		}),
	);
	assert.deepEqual(bad, []);
});

test("每个文件开头一段注释说它做什么（#! 那行之后；shadcn 拷来的 components/ui 不算）", () => {
	const bare = CODE.filter((f) => !/^(#![^\n]*\n)?\/\/ \S/.test(readFileSync(f, "utf8")));
	assert.deepEqual(bare.map(rel), []);
});

/** git 管着的文件（连还没提交的新文件，不连忽略的） */
const tracked = () =>
	execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
		.split("\n")
		.filter((f) => f && existsSync(join(ROOT, f)));

/** 文档只放这几处：给人看的 README、给 agent 的 AGENTS.md（CLAUDE.md 引它）、skill、子 agent、连接器接口的坑（挨着它的代码） */
const DOCS = [
	/^README\.md$/,
	/^AGENTS\.md$/,
	/^CLAUDE\.md$/,
	/^skills\/[^/]+\/SKILL\.md$/,
	/^\.claude\/agents\/[^/]+\.md$/,
	/^connectors\/(sites|services)\/[^/]+\/NOTES\.md$/,
];

test("文档只放在 README、AGENTS.md、skill、子 agent、连接器的 NOTES.md 里：别的说不清的先想能不能写进目录、lint、测试、代码", () => {
	assert.deepEqual(
		tracked().filter((f) => f.endsWith(".md") && !DOCS.some((d) => d.test(f))),
		[],
	);
});

test("代码、文档里提到的仓库里的文件都在（改名、删了文件，提到它的地方跟着改）", () => {
	const bad: string[] = [];
	for (const f of tracked().filter((x) => /\.(ts|tsx|md|sql)$/.test(x))) {
		const text = readFileSync(join(ROOT, f), "utf8");
		// 从仓库根写的路径，例 platform/writes.ts、skills/orders/SKILL.md
		for (const m of text.matchAll(/(?<![\w./-])((?:platform|connectors|skills|test|bin|src|web|docs|\.claude)\/[\w./-]+\.(?:md|ts|tsx|sql|json))/g))
			if (!existsSync(join(ROOT, m[1]!))) bad.push(`${f} → ${m[1]}`);
		// markdown 的相对链接，例 [订单](skills/orders/SKILL.md)
		if (f.endsWith(".md"))
			for (const m of text.matchAll(/\]\(([^)#:\s]+)(?:#[^)]*)?\)/g)) if (!existsSync(resolve(ROOT, dirname(f), m[1]!))) bad.push(`${f} → ${m[1]}`);
	}
	assert.deepEqual(bad, []);
});
