// Web 写入只调用组件明确声明的工具；确认绑定服务端引用、规范参数和精确预览，领取后不再提交第二次。
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Json, Sql } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { findTool, invoke } from "../tool.ts";
import { type Outcome, perform } from "../writes.ts";
import { actParams, COMPONENTS, PageItemId } from "./pages.ts";

export const referenceHash = (component: string, props: unknown) =>
	createHash("sha256")
		.update(
			JSON.stringify({ component, props }, (_, v) =>
				v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
			),
		)
		.digest("hex");

const preview = z.object({ params: z.record(z.string(), z.unknown()), display: z.string().min(1), trialRequired: z.boolean().optional() });
type Saved = {
	token: string;
	item_id: string;
	action: string;
	tool: string;
	reference_hash: string;
	params: Record<string, unknown>;
	display: string;
	state: string;
	expires_at: Date;
	outcome: Outcome | null;
};

export function checkConfirmation(saved: Pick<Saved, "reference_hash" | "expires_at">, component: string, props: unknown, now = new Date()): void {
	if (saved.expires_at <= now) throw new Usage("确认已过期，请重新查看操作对象和内容");
	if (saved.reference_hash !== referenceHash(component, props)) throw new Usage("页面引用已变化，请重新确认");
}

export async function prepareConfirmation(sql: Sql, item: string, action: string, input: unknown) {
	const [i] = await sql<{ component: string; props: unknown }[]>`select component, props from page_items where id = ${PageItemId.parse(item)}`;
	if (!i) throw new Usage("组件不存在");
	const c = COMPONENTS.get(i.component);
	const tool = c?.writeActions?.[action],
		read = c?.writePreviews?.[action];
	if (!tool || !read) throw new Usage("这个操作没有声明确认与写入工具");
	const t = findTool(tool);
	if (t?.kind !== "write" || !("plan" in t)) throw new Usage("确认只能调用注册的业务写工具");
	const given = actParams(i.props, input, c.inputs ?? []);
	const shown = preview.parse(await invoke(read, given));
	const params = t.params.parse(shown.params);
	// 预览不得改变固定引用；工具只允许补充由服务端读取的业务事实。
	for (const [key, value] of Object.entries((i.props ?? {}) as Record<string, unknown>)) {
		if (key !== "title" && key in params && JSON.stringify(params[key]) !== JSON.stringify(value)) throw new Usage("预览与固定引用不一致");
	}
	const token = randomUUID(),
		expiresAt = new Date(Date.now() + 10 * 60_000);
	await sql`insert into web_confirmations (token, item_id, action, tool, reference_hash, params, display, expires_at)
		values (${token}, ${item}, ${action}, ${tool}, ${referenceHash(i.component, i.props)}, ${sql.json(params as Json)}, ${shown.display}, ${expiresAt})`;
	return { token, display: shown.display, expiresAt: expiresAt.toISOString(), trialRequired: shown.trialRequired ?? false };
}

export async function confirmWrite(sql: Sql, input: unknown): Promise<{ state: string; outcome?: Outcome }> {
	const p = z.object({ token: z.string().uuid(), confirmed: z.literal(true), trial: z.boolean().default(false) }).parse(input);
	const [s] = await sql<Saved[]>`select * from web_confirmations where token = ${p.token}`;
	if (!s) throw new Usage("找不到确认记录");
	if (s.state !== "prepared") return { state: s.state, ...(s.outcome ? { outcome: s.outcome } : {}) };
	const [i] = await sql<{ component: string; props: unknown }[]>`select component, props from page_items where id = ${s.item_id}`;
	if (!i) throw new Usage("组件已移除");
	checkConfirmation(s, i.component, i.props);
	if (COMPONENTS.get(i.component)?.writeActions?.[s.action] !== s.tool) throw new Usage("确认的操作已变化");
	const t = findTool(s.tool);
	if (t?.kind !== "write" || !("plan" in t)) throw new Usage("不是允许的业务写工具");
	const params = t.params.parse(s.params);
	const claimed = await sql`update web_confirmations set state = 'executing' where token = ${p.token} and state = 'prepared' and expires_at > now()
		and exists (select 1 from page_items where id = ${s.item_id} and component = ${i.component} and props = ${sql.json(i.props as Json)}) returning token`;
	if (!claimed.length) {
		const [current] = await sql<Saved[]>`select * from web_confirmations where token = ${p.token}`;
		if (current && current.state !== "prepared") return { state: current.state, ...(current.outcome ? { outcome: current.outcome } : {}) };
		throw new Usage("确认已过期或页面引用已变化，请重新查看操作对象和内容");
	}
	try {
		const batches = await t.plan(sql, params as never);
		const outcome = !batches.length && t.replay ? await t.replay(sql, params as never) : await perform(sql, batches, { try: p.trial });
		await sql`update web_confirmations set state = 'completed', outcome = ${sql.json(outcome as unknown as Json)} where token = ${p.token}`;
		return { state: "completed", outcome };
	} catch (e) {
		const outcome: Outcome = { ran: [], unknown: true, blocked: (e as Error).message };
		await sql`update web_confirmations set state = 'unknown', outcome = ${sql.json(outcome as unknown as Json)} where token = ${p.token}`;
		throw e;
	}
}
