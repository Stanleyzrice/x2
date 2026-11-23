import { z } from "zod";
import type { Json, Sql } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { hermesModel } from "../ui/hermes-schema.ts";
import type { HermesRun, RunRow } from "./hermes.ts";

const id = z.uuid();
const storedMessage = z.object({
	id: z.string().min(1).max(100),
	role: z.enum(["user", "assistant"]),
	content: z.string().max(200_000),
	context: z.string().max(40_000).optional(),
	model: hermesModel.optional(),
	trace: z
		.array(z.object({ id, name: z.string().max(100), state: z.enum(["running", "completed", "failed"]) }))
		.max(100)
		.optional(),
});
export const importConversation = z.object({
	id,
	turns: z.array(storedMessage).max(24),
	runIds: z.array(id).max(2).default([]),
});
export type HistoryImport = z.input<typeof importConversation>;
export type HistoryMessage = z.output<typeof storedMessage>;
export type ConversationEntry = HistoryMessage | { id: string; role: "task"; run: HermesRun };
export type ConversationSummary = { id: string; title: string; updatedAt: string };
export type Conversation = ConversationSummary & { entries: ConversationEntry[]; pending: HermesRun | null };
type ConversationRow = { id: string; title: string; updated_at: Date; imported: HistoryMessage[] };
export const conversationTitle = (text: string, fallback = "历史会话") => Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 40).join("") || fallback;

function summary(row: Pick<ConversationRow, "id" | "title" | "updated_at">): ConversationSummary {
	return { id: row.id, title: row.title, updatedAt: row.updated_at.toISOString() };
}

export async function listConversations(sql: Sql) {
	const rows = await sql<
		Pick<ConversationRow, "id" | "title" | "updated_at">[]
	>`select id, title, updated_at from hermes_conversations where deleted_at is null order by updated_at desc, id`;
	return rows.map(summary);
}

export function conversationEntries(imported: HistoryMessage[], rows: RunRow[], publicRun: (row: RunRow) => HermesRun): ConversationEntry[] {
	const entries: ConversationEntry[] = [...imported];
	for (const row of rows) {
		if (row.message !== null)
			entries.push({
				id: `user-${row.id}`,
				role: "user",
				content: row.message,
				context: row.context ?? undefined,
			});
		const run = publicRun(row);
		if (run.state === "running") continue;
		if (run.kind === "chat" && run.result && "text" in run.result) {
			entries.push({ id: `assistant-${row.id}`, role: "assistant", content: run.result.text, model: row.model ?? undefined, trace: run.trace });
		} else {
			entries.push({ id: `task-${row.id}`, role: "task", run });
		}
	}
	return entries;
}

export async function readConversation(sql: Sql, id: string, publicRun: (row: RunRow) => HermesRun): Promise<Conversation | null> {
	const [row] = await sql<ConversationRow[]>`select * from hermes_conversations where id=${id} and deleted_at is null`;
	if (!row) return null;
	const runs = await sql<RunRow[]>`select * from hermes_web_runs where conversation_id=${id} order by created_at, id`;
	return {
		...summary(row),
		entries: conversationEntries(row.imported, runs, publicRun),
		pending: runs.map(publicRun).find((run) => run.state === "running") ?? null,
	};
}

export async function deleteConversation(sql: Sql, id: string, owner: string) {
	return sql.begin(async (tx) => {
		const [row] = await tx<{ deleted_at: Date | null }[]>`select deleted_at from hermes_conversations where id=${id} for update`;
		if (!row || row.deleted_at) return { id };
		const [active] = await tx`select id from hermes_web_runs where conversation_id=${id} and owner=${owner} and state='running' limit 1`;
		if (active) throw new Usage("这条会话还有任务正在执行，请等它结束后再删除");
		await tx`update hermes_conversations set deleted_at=now(), title='', imported='[]'::jsonb where id=${id}`;
		await tx`update hermes_web_runs set message=null, context=null, trace='[]'::jsonb,
			result=case when kind='chat' then null else result end, error=case when kind='chat' then null else error end,
			state=case when kind='chat' and state='running' then 'failed' else state end where conversation_id=${id}`;
		return { id };
	});
}

export async function saveImportedConversation(sql: Sql, { id, turns, runIds }: z.output<typeof importConversation>) {
	return sql.begin(async (tx) => {
		const title = conversationTitle(turns.find((turn) => turn.role === "user")?.content || turns[0]?.content || "");
		const [created] =
			await tx`insert into hermes_conversations (id, title, imported) values (${id}, ${title}, ${tx.json(turns as Json)}) on conflict (id) do nothing returning id`;
		if (created && runIds.length) await tx`update hermes_web_runs set conversation_id=${id} where id in ${tx(runIds)} and conversation_id is null`;
		return { id };
	});
}
