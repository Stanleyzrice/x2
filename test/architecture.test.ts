// 代码放哪（AGENTS.md「改代码」）：平台（platform）、连接器（connectors：sites 经浏览器、services 用 API key）、业务工具（tools：一类业务一个），skills 只有 md。
// 谁能 import 谁由 lint 管（biome.json 的 overrides：noRestrictedImports）；这里只放 lint 管不了的：顶层有哪些、网页的界面引网页服务只 import type、
// 环境变量都写在 .env.example、每个文件开头一段注释、文档放哪、提到的文件都在、skills 只有 md。破例不加白名单：放错了就搬，规则不对就改这里和 AGENTS.md
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

const TOP = [
	".agents",
	".claude",
	".env.example",
	".githooks",
	".github",
	".gitignore",
	"AGENTS.md",
	"CLAUDE.md",
	"README.md",
	"ops",
	"biome.json",
	"components.json",
	"connectors",
	"package.json",
	"patches",
	"platform",
	"pnpm-lock.yaml",
	"skills",
	"test",
	"tools",
	"tsconfig.json",
	"x2.ts",
];

const SHADCN = "platform/ui/components/ui/";
const CODE = [join(ROOT, "x2.ts"), ...["platform", "connectors", "tools", "test"].flatMap((d) => files(join(ROOT, d)))].filter(
	(f) => !rel(f).startsWith(SHADCN),
);
const UI = CODE.filter((f) => rel(f).startsWith("platform/ui/"));

test("顶层只有这几样：代码分 platform、connectors、tools，skills 只有 md，test 是跨层的测试，ops 是连服务器的配置（不放秘密）；别的是工具链的配置", () => {
	assert.deepEqual(
		[...new Set(tracked().map((f) => f.split("/")[0]!))].filter((x) => !TOP.includes(x)),
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

test("网页的界面（platform/ui）引网页服务（platform/web）只 import type：界面打包进浏览器，lint 管得了引哪里、管不了是不是 type", () => {
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
	/^skills\/[^/]+\/references\/[^/]+\.md$/,
	/^\.agents\/skills\/[^/]+\/SKILL\.md$/,
	/^\.agents\/skills\/[^/]+\/references\/[^/]+\.md$/,
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
	for (const f of tracked().filter((x) => /\.(ts|tsx|md|sql|tla|cfg|mjs)$/.test(x))) {
		const text = readFileSync(join(ROOT, f), "utf8");
		for (const m of text.matchAll(
			/(?<![\w./-])((?:platform|connectors|tools|skills|test|bin|src|web|docs|\.claude|\.agents)\/[\w./-]+\.(?:md|ts|tsx|sql|json|tla|cfg|mjs|mmd))/g,
		))
			if (!existsSync(join(ROOT, m[1]!))) bad.push(`${f} → ${m[1]}`);
		if (f.endsWith(".md"))
			for (const m of text.matchAll(/\]\(([^)#:\s]+)(?:#[^)]*)?\)/g)) if (!existsSync(resolve(ROOT, dirname(f), m[1]!))) bad.push(`${f} → ${m[1]}`);
	}
	assert.deepEqual(bad, []);
});

const SKILL_LINES = 40;
const SKILL_CHARS = 2000;
const skillDirs = () =>
	["skills", ".agents/skills"]
		.filter((root) => existsSync(join(ROOT, root)))
		.flatMap((root) =>
			readdirSync(join(ROOT, root), { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => ({ name: e.name, root })),
		);

test("skills 只有 md：每个 skill 一份 SKILL.md，细节放 references/*.md（代码、表、测试在 tools）", () => {
	assert.deepEqual(
		tracked().filter((f) => /^(?:\.agents\/)?skills\//.test(f) && !/^(?:\.agents\/)?skills\/[^/]+\/(SKILL\.md|references\/[^/]+\.md)$/.test(f)),
		[],
	);
});

test(`SKILL.md 有 frontmatter（name 和目录名一样、description）；正文最多 ${SKILL_LINES} 行、${SKILL_CHARS} 字，细节走到那一步再读 references`, () => {
	const bad: string[] = [];
	for (const d of skillDirs()) {
		const text = readFileSync(join(ROOT, d.root, d.name, "SKILL.md"), "utf8");
		const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!m) {
			bad.push(`${d.name}：没有 frontmatter`);
			continue;
		}
		if (!new RegExp(`^name: ${d.name}$`, "m").test(m[1]!)) bad.push(`${d.name}：name 要是 ${d.name}`);
		if (!/^description: \S/m.test(m[1]!)) bad.push(`${d.name}：没有 description`);
		const body = m[2]!.trim();
		if (body.split("\n").length > SKILL_LINES) bad.push(`${d.name}：正文 ${body.split("\n").length} 行`);
		if (body.length > SKILL_CHARS) bad.push(`${d.name}：正文 ${body.length} 字`);
	}
	assert.deepEqual(bad, []);
});

test("skill 提到的 references 都在，references 里的每份都有人提到（SKILL.md 或别的 reference）", () => {
	const bad: string[] = [];
	for (const d of skillDirs()) {
		const dir = join(ROOT, d.root, d.name);
		const refs = existsSync(join(dir, "references")) ? readdirSync(join(dir, "references")).map((f) => `references/${f}`) : [];
		const texts = ["SKILL.md", ...refs].map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
		for (const m of texts.matchAll(/(?<![\w/])references\/[\w.-]+\.md/g)) if (!existsSync(join(dir, m[0]))) bad.push(`skills/${d.name} → ${m[0]}`);
		for (const r of refs) if (!texts.includes(r)) bad.push(`skills/${d.name}/${r} 没人提到`);
	}
	assert.deepEqual(bad, []);
});

const BUSINESS_WORDS = ["货源", "商品稿", "核价", "选品", "采购账号", "毛利"];

test(`connector 不用业务词（${BUSINESS_WORDS.join("、")}）：照网站自己的说法，回原样数据，不替业务做判断`, () => {
	const bad: string[] = [];
	for (const f of CODE.filter((x) => rel(x).startsWith("connectors/")))
		for (const [i, line] of readFileSync(f, "utf8").split("\n").entries())
			for (const w of BUSINESS_WORDS) if (line.includes(w)) bad.push(`${rel(f)}:${i + 1}：${w}`);
	assert.deepEqual(bad, []);
});
