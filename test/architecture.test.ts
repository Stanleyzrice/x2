// 代码放哪（AGENTS.md「改代码」）：平台（platform）、连接器（connectors：sites 经浏览器、services 用 API key）、业务工具（tools：一类业务一个），skills 只有 md。
// platform 不 import 连接器和业务工具；连接器只 import platform 和自己；业务工具互相只经 index.ts；网页的界面只引自己；环境变量都写在 .env.example；
// 每个文件开头一段注释说它做什么；文档只放在几个固定的地方，提到的仓库里的文件都在。破例不加白名单：放错了就搬，规则不对就改这里和 AGENTS.md
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
const target = (file: string, spec: string) =>
	spec.startsWith("@/") ? join(ROOT, "platform/ui", spec.slice(2)) : spec.startsWith(".") ? resolve(join(file, ".."), spec) : null;

const SHADCN = "platform/ui/components/ui/";
const CODE = [join(ROOT, "x2.ts"), ...["platform", "connectors", "tools", "test"].flatMap((d) => files(join(ROOT, d)))].filter(
	(f) => !rel(f).startsWith(SHADCN),
);
const UI = CODE.filter((f) => rel(f).startsWith("platform/ui/"));

const layerOf = (f: string) => rel(f).split("/")[0]!;
const unitOf = (f: string) => {
	const p = rel(f).split("/");
	return p[0] === "connectors" ? p.slice(0, 3).join("/") : p[0] === "tools" ? p.slice(0, 2).join("/") : p[0]!;
};
const LAYERED = CODE.filter((f) => ["platform", "connectors", "tools"].includes(layerOf(f)) && !f.endsWith(".test.ts") && !rel(f).startsWith("platform/ui/"));
const edges = (fs: string[]) =>
	fs.flatMap((f) =>
		imports(f).flatMap(({ spec }) => {
			const to = target(f, spec);
			return to ? [{ from: f, to }] : [];
		}),
	);

test("根上的 x2.ts 是装配：只 import platform、连接器和业务工具的入口（index.ts）", () => {
	const bad = edges([join(ROOT, "x2.ts")]).filter(
		(e) => !(layerOf(e.to) === "platform" || (["connectors", "tools"].includes(layerOf(e.to)) && rel(e.to) === `${unitOf(e.to)}/index.ts`)),
	);
	assert.deepEqual(
		bad.map((e) => `${rel(e.from)} → ${rel(e.to)}`),
		[],
	);
});

test("platform 不 import connectors、tools（装配在 x2.ts 里做）", () => {
	const bad = edges(LAYERED.filter((f) => layerOf(f) === "platform")).filter((e) => ["connectors", "tools"].includes(layerOf(e.to)));
	assert.deepEqual(
		bad.map((e) => `${rel(e.from)} → ${rel(e.to)}`),
		[],
	);
});

test("一个连接器只 import platform 和它自己（不 import 业务工具、别的连接器）", () => {
	const bad = edges(LAYERED.filter((f) => layerOf(f) === "connectors")).filter((e) => layerOf(e.to) !== "platform" && unitOf(e.to) !== unitOf(e.from));
	assert.deepEqual(
		bad.map((e) => `${rel(e.from)} → ${rel(e.to)}`),
		[],
	);
});

test("业务工具互相不 import；真要用别的业务工具的，只经它的 index.ts（公开的接口）", () => {
	const bad = edges(LAYERED.filter((f) => layerOf(f) === "tools")).filter(
		(e) => layerOf(e.to) === "tools" && unitOf(e.to) !== unitOf(e.from) && !rel(e.to).endsWith("/index.ts"),
	);
	assert.deepEqual(
		bad.map((e) => `${rel(e.from)} → ${rel(e.to)}`),
		[],
	);
});

test("代码里读的每个环境变量都写在 .env.example（只有名字和一句说明）；process.env[…] 只在读 .env 的 platform/env.ts", () => {
	const listed = new Set([...readFileSync(join(ROOT, ".env.example"), "utf8").matchAll(/^([A-Z0-9_]+)=$/gm)].map((m) => m[1]!));
	const bad: string[] = [];
	for (const f of CODE.filter((x) => x !== import.meta.filename)) {
		const text = readFileSync(f, "utf8");
		for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) if (!listed.has(m[1]!)) bad.push(`${rel(f)}：${m[1]}`);
		if (/process\.env\[/.test(text) && rel(f) !== "platform/env.ts") bad.push(`${rel(f)}：process.env[…]`);
	}
	assert.deepEqual(bad, []);
	assert.ok(!/^[A-Z0-9_]+=.+$/m.test(readFileSync(join(ROOT, ".env.example"), "utf8")), ".env.example 只写名字，不写值");
});

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

const tracked = () =>
	execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
		.split("\n")
		.filter((f) => f && existsSync(join(ROOT, f)));

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
		for (const m of text.matchAll(/(?<![\w./-])((?:platform|connectors|tools|skills|test|bin|src|web|docs|\.claude)\/[\w./-]+\.(?:md|ts|tsx|sql|json))/g))
			if (!existsSync(join(ROOT, m[1]!))) bad.push(`${f} → ${m[1]}`);
		if (f.endsWith(".md"))
			for (const m of text.matchAll(/\]\(([^)#:\s]+)(?:#[^)]*)?\)/g)) if (!existsSync(resolve(ROOT, dirname(f), m[1]!))) bad.push(`${f} → ${m[1]}`);
	}
	assert.deepEqual(bad, []);
});
