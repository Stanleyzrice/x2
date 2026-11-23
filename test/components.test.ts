import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findTool, register } from "../platform/tool.ts";
import { COMPONENTS, KINDS, parseProps } from "../platform/web/pages.ts";
import { TOOLKITS } from "../x2.ts";

register(...TOOLKITS);

const UI = join(import.meta.dirname, "../platform/ui");
const dirs = (kind: string) =>
	readdirSync(join(UI, kind), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

test("每类目录下只有组件的文件夹；每个有 schema.ts（只有 zod，不引 React）和 view.tsx（导出 View，照自己 schema.ts 的 Props 画）", () => {
	const bad: string[] = [];
	for (const kind of KINDS) {
		for (const f of readdirSync(join(UI, kind), { withFileTypes: true })) if (!f.isDirectory()) bad.push(`${kind}/${f.name}：不是组件的文件夹`);
		for (const name of dirs(kind)) {
			const dir = join(UI, kind, name);
			if (!existsSync(join(dir, "schema.ts"))) bad.push(`${kind}/${name}：没有 schema.ts`);
			else if (/from "react|\.tsx"/.test(readFileSync(join(dir, "schema.ts"), "utf8"))) bad.push(`${kind}/${name}/schema.ts：引了 React`);
			if (!existsSync(join(dir, "view.tsx"))) bad.push(`${kind}/${name}：没有 view.tsx`);
			else {
				const view = readFileSync(join(dir, "view.tsx"), "utf8");
				const sig =
					kind === "generative"
						? /^export function View\(\{ props \}: \{ props: Props \}\)/m
						: /^export function View\(\{ props(, item)? \}: \{ props: Props(; item: PageItem)? \}\)/m;
				if (!sig.test(view)) bad.push(`${kind}/${name}/view.tsx：没有导出 View（generative：{ props }；interactable 还可以有 item）`);
				if (!/import type \{[^}]*\bProps\b[^}]*\} from "\.\/schema\.ts"/.test(view)) bad.push(`${kind}/${name}/view.tsx：Props 不是从 ./schema.ts 来的`);
			}
		}
	}
	assert.deepEqual(bad, []);
});

test("组件的名字两类不撞；服务端收到的就是目录里的", () => {
	const all = KINDS.flatMap((k) => dirs(k).map((n) => `${k}/${n}`));
	assert.equal(new Set(all.map((x) => x.split("/")[1])).size, all.length);
	assert.deepEqual([...COMPONENTS.values()].map((c) => `${c.kind}/${c.name}`).sort(), all.sort());
});

test("每个组件有说明、至少一个例子，例子过得了自己的校验", () => {
	for (const c of COMPONENTS.values()) {
		assert.ok(c.description, `${c.name}：没有说明`);
		assert.ok(c.examples.length, `${c.name}：没有例子`);
		for (const e of c.examples) assert.doesNotThrow(() => parseProps(c.name, e), `${c.name} 的例子 ${JSON.stringify(e)}`);
	}
});

test("组件动作引用已登记工具，站点写入必须有独立的读取预览", () => {
	for (const c of COMPONENTS.values()) {
		assert.deepEqual(Object.keys(c.writeActions ?? {}).sort(), Object.keys(c.writePreviews ?? {}).sort(), c.name);
		for (const id of Object.values({ ...c.actions, ...c.writePreviews })) assert.equal(findTool(id)?.kind, "read", `${c.name} → ${id}`);
		for (const id of Object.values(c.writeActions ?? {})) {
			const tool = findTool(id);
			assert.ok(tool?.kind === "write" && "plan" in tool, `${c.name} → ${id}`);
		}
	}
});

test("固定入口唯一并引用已注册组件，所有保存的身份参数通过组件校验", () => {
	const workspaces = TOOLKITS.flatMap((k) => k.workspaces ?? []);
	assert.equal(new Set(workspaces.map((w) => w.key)).size, workspaces.length);
	assert.deepEqual(
		workspaces.filter((w) => w.component === "catalog" || w.component === "chat").map((w) => ({ key: w.key, shop: w.props.shop })),
		[
			{ key: "manual-collection", shop: "cheeroutdoor" },
			{ key: "listing-candidates", shop: "cheeroutdoor" },
			{ key: "catalog-cheeroutdoor", shop: "cheeroutdoor" },
			{ key: "chat-cheeroutdoor", shop: "cheeroutdoor" },
		],
	);
	for (const w of workspaces) {
		assert.equal(COMPONENTS.get(w.component)?.kind, "interactable");
		assert.doesNotThrow(() => parseProps(w.component, w.props), w.key);
	}
});

test("采购入口展示的刷新时间引用实际注册任务，不另维护一份时刻", () => {
	const kit = TOOLKITS.find((k) => k.name === "reimbursement")!;
	const job = kit.jobs![0]!;
	const page = kit.workspaces![0]!;
	assert.deepEqual(page.props.schedule, { hour: job.hour, timeZone: job.timeZone });
});
