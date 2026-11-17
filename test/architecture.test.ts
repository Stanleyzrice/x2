// 层间依赖按 TypeScript 语法树与规范路径检查；文档只维护规则和必要说明。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { test } from "node:test";
import {
	isCallExpression,
	isExportDeclaration,
	isFunctionDeclaration,
	isImportDeclaration,
	isImportTypeNode,
	isStringLiteralLikeNode,
	type Node,
	SyntaxKind,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

const ROOT = resolve(import.meta.dirname, "..");
const isSource = (name: string) => /\.(?:[cm]?ts|tsx)$/.test(name);

const files = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? (["node_modules", "dist"].includes(e.name) ? [] : files(join(dir, e.name))) : isSource(e.name) ? [join(dir, e.name)] : [],
	);
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

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
	"tsconfig.base.json",
	"tsconfig.json",
	"x2.ts",
];

const SHADCN = "platform/ui/components/ui/";
const CODE = [join(ROOT, "x2.ts"), ...["platform", "connectors", "tools", "test"].flatMap((d) => files(join(ROOT, d)))].filter(
	(f) => !rel(f).startsWith(SHADCN),
);
const schemaLoaderPrefix = `async function collect(kind: Kind): Promise<Component[]> {
	const dir = new URL(\`\${kind}/\`, UI);
	const names = readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
	return Promise.all(
		names.map(async (name) => {
			const m = await `;

function registeredSchemaImport(file: string, node: Node): boolean {
	if (rel(file) !== "platform/web/pages.ts" || node.getText() !== `import(new URL(\`\${name}/schema.ts\`, dir).href)`) return false;
	const source = node.getSourceFile();
	const collect = source.statements.find((statement) => isFunctionDeclaration(statement) && statement.name?.text === "collect");
	return Boolean(
		collect &&
			source.text.slice(collect.getStart(), node.getStart()) === schemaLoaderPrefix &&
			[
				'const UI = new URL("../ui/", import.meta.url);',
				'export const KINDS = ["generative", "interactable"] as const;',
				"export type Kind = (typeof KINDS)[number];",
			].every((declaration) => source.statements.some((statement) => statement.getText() === declaration)),
	);
}

function readImportProblems(paths = CODE, virtual = new Map<string, string>()): string[] {
	const api = new API({ fs: { readFile: (file) => virtual.get(file), fileExists: (file) => (virtual.has(file) ? true : undefined) } });
	try {
		using snapshot = api.updateSnapshot({
			openProjects: [join(ROOT, "tsconfig.json"), join(ROOT, "platform/ui/tsconfig.json")],
			openFiles: [...virtual.keys()],
		});
		return paths.flatMap((file) => {
			const config = rel(file).startsWith("platform/ui/") ? "platform/ui/tsconfig.json" : "tsconfig.json";
			const source = (snapshot.getDefaultProjectForFile(file) ?? snapshot.getProject(join(ROOT, config)))?.program.getSourceFile(file);
			assert.ok(source, `${rel(file)} 没有纳入类型检查`);
			const problems = source.imports.flatMap((node) => {
				assert.ok(isStringLiteralLikeNode(node));
				const parent = node.parent;
				const typeOnly =
					(isImportDeclaration(parent) && parent.importClause?.phaseModifier === SyntaxKind.TypeKeyword) ||
					(isExportDeclaration(parent) && parent.isTypeOnly) ||
					(parent.parent !== undefined && isImportTypeNode(parent.parent));
				if (isAbsolute(node.text) || win32.isAbsolute(node.text) || /^file:/i.test(node.text)) return [`${rel(file)}：禁止绝对路径导入 ${node.text}`];
				const to = target(file, node.text);
				return to && !allowedImport(rel(file), rel(to), typeOnly) ? [`${rel(file)} → ${rel(to)}`] : [];
			});
			function visit(node: Node): void {
				const argument = isCallExpression(node) ? node.arguments[0] : undefined;
				if (
					isCallExpression(node) &&
					node.expression.kind === SyntaxKind.ImportKeyword &&
					(!argument || !isStringLiteralLikeNode(argument)) &&
					!registeredSchemaImport(file, node)
				)
					problems.push(`${rel(file)}：禁止非字面量动态导入 ${node.getText()}`);
				node.forEachChild(visit);
			}
			visit(source);
			return problems;
		});
	} finally {
		api.close();
	}
}

function allowedImport(from: string, to: string, typeOnly: boolean): boolean {
	if (from === "x2.ts")
		return to.startsWith("platform/") || /^connectors\/(sites|services)\/[^/]+\/index\.ts$/.test(to) || /^tools\/[^/]+\/index\.ts$/.test(to);
	if (from.startsWith("platform/ui/")) {
		if (from.startsWith("platform/ui/generative/") && /^platform\/ui\/api(?:\.ts)?$/.test(to)) return false;
		return to.startsWith("platform/ui/") || (to.startsWith("platform/web/") && typeOnly);
	}
	if (from.startsWith("platform/")) return to.startsWith("platform/");
	if (from.startsWith("connectors/"))
		return to.startsWith(`${from.split("/").slice(0, 3).join("/")}/`) || (to.startsWith("platform/") && !to.startsWith("platform/db/"));
	if (from.startsWith("tools/"))
		return to.startsWith(`${from.split("/").slice(0, 2).join("/")}/`) || to.startsWith("platform/") || to.startsWith("connectors/");
	return from.startsWith("test/");
}

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

test("四层依赖按实际路径检查：嵌套目录、别名、转导出与动态导入不能绕过边界；界面只引服务端类型", () => {
	assert.deepEqual(readImportProblems(), []);
});

test("原生解析覆盖绝对导入、非字面量动态导入及 .mts/.cts；类型查询不会当成运行时导入", () => {
	const absolute = join(ROOT, "tools/listing/index.ts");
	const virtual = new Map([
		[
			join(ROOT, "platform/env.ts"),
			`import ${JSON.stringify(absolute)}; import ${JSON.stringify(`file://${absolute}`)}; const path = "../tools/listing/index.ts"; await import(path);`,
		],
		[join(ROOT, "platform/architecture-probe.mts"), 'export * from "../tools/listing/index.ts";'],
		[join(ROOT, "platform/architecture-probe.cts"), 'type Row = import("../tools/listing/row.ts").ListingRow;'],
		[
			join(ROOT, "platform/ui/preload.ts"),
			`import type { Meta } from "../web/tables.ts";
export type { Meta } from "../web/tables.ts";
type Module = typeof import("../web/tables.ts");
import { type Meta as Inline } from "../web/tables.ts";
export { type Meta as InlineExport } from "../web/tables.ts";
await import("../web/tables.ts");`,
		],
	]);
	for (const file of virtual.keys()) assert.ok(isSource(file));
	assert.deepEqual(readImportProblems([...virtual.keys()], virtual), [
		`platform/env.ts：禁止绝对路径导入 ${absolute}`,
		`platform/env.ts：禁止绝对路径导入 file://${absolute}`,
		"platform/env.ts：禁止非字面量动态导入 import(path)",
		"platform/architecture-probe.mts → tools/listing/index.ts",
		"platform/architecture-probe.cts → tools/listing/row.ts",
		...Array<string>(3).fill("platform/ui/preload.ts → platform/web/tables.ts"),
	]);
});

test("schema 注册器只放行原有固定目录调用；改根目录、改数据来源或增加其它计算导入都会报错", () => {
	const file = join(ROOT, "platform/web/pages.ts");
	const original = readFileSync(file, "utf8");
	for (const text of [
		original.replace('new URL("../ui/", import.meta.url)', 'new URL("../../tools/", import.meta.url)'),
		original.replace("readdirSync(dir, { withFileTypes: true })", "readdirSync(ROOT, { withFileTypes: true })"),
		`${original}\nconst other = "../tools/listing/index.ts"; await import(other);`,
	]) {
		const problems = readImportProblems([file], new Map([[file, text]]));
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, /禁止非字面量动态导入/);
	}
});

test("依赖约束拒绝跨业务、跨连接器、连接器读库、界面加载服务端实现和装配深入模块", () => {
	const cases: [string, string, boolean, boolean][] = [
		["tools/orders/index.ts", "tools/listing/row.ts", true, false],
		["connectors/sites/1688/index.ts", "connectors/sites/shopee/index.ts", true, false],
		["connectors/sites/shopee/index.ts", "platform/db/index.ts", true, false],
		["platform/ui/interactable/catalog/view.tsx", "platform/web/tables.ts", false, false],
		["platform/ui/interactable/catalog/view.tsx", "platform/web/tables.ts", true, true],
		["platform/ui/generative/table/view.tsx", "platform/ui/api.ts", false, false],
		["platform/browser/collection.ts", "tools/listing/index.ts", false, false],
		["x2.ts", "tools/listing/row.ts", true, false],
		["x2.ts", "connectors/sites/shopee/index.ts", false, true],
	];
	for (const [from, to, typeOnly, allowed] of cases) assert.equal(allowedImport(from, to, typeOnly), allowed, `${from} → ${to}`);
	assert.equal(rel(target(join(ROOT, "platform/ui/interactable/catalog/view.tsx"), "../../../../tools/listing/index.ts")!), "tools/listing/index.ts");
	assert.equal(rel(target(join(ROOT, "platform/ui/interactable/catalog/view.tsx"), "@/../web/tables.ts")!), "platform/web/tables.ts");
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
			/(?<![\w./-])((?:platform|connectors|tools|skills|test|bin|src|web|docs|\.claude|\.agents)\/[\w./-]+\.(?:md|tsx?|sql|json|tla|cfg|mjs|mmd))(?![\w./-])/g,
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
