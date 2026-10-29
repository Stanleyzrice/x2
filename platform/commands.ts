// 平台自己的命令（x2 status、verify、resolve、handled、schema、web、migrate）和会话（x2 session <工具>）：换哪门生意都一样
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { outcomeText, schema } from "./cli.ts";
import { db } from "./db/index.ts";
import { Usage } from "./errors.ts";
import { status } from "./status.ts";
import { type Checked, findTool, get, parseJson, str, strs, type Todo, type Toolkit } from "./tool.ts";
import { serve } from "./web/server.ts";
import { catalog, createSession, deleteSession, listSessions, parseItem, push, showSession } from "./web/sessions.ts";
import { run } from "./writes.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

// 中文字占两格：按显示宽度对齐
const width = (t: string) => [...t].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
const pad = (label: string, lines: string[]) => lines.map((l, i) => `${i === 0 ? label : ""}${" ".repeat(8 - width(i === 0 ? label : ""))}${l}`).join("\n");
const todoLine = (t: Todo) => {
	if (!t.tool) return `${t.kind}：${t.why}`;
	const params = t.params && Object.keys(t.params).length ? "，参数在 x2 status --json 的 todo 里" : "";
	const write = findTool(t.tool)?.kind === "write" ? "：给人看过、人同意了再调" : "";
	return `${t.kind}：${t.why}（${t.tool}${params}${write}）`;
};

function statusText(c: Checked): string {
	const read = c.read.map(
		(r) => `${r.what}${r.who ? ` ${r.who}` : ""}${r.ok ? (r.rows !== undefined ? ` ${r.rows} 行` : "") : `：读不了（${String(r.error).split("\n")[0]}）`}`,
	);
	return [
		pad("读到", read.length ? read : ["没有要读的"]),
		pad("人", c.human.length ? c.human.map((r) => r.title) : ["现在没有要人做的"]),
		pad("agent", c.todo.length ? c.todo.map(todoLine) : ["没有"]),
	].join("\n");
}

const writesResult = {
	text: outcomeText,
	exit: (o: { unknown: boolean; blocked: string | null }) => (o.unknown ? "unknown" : o.blocked ? "human" : undefined),
} as const;

export const platform: Toolkit = {
	name: "",
	title: "平台",
	kind: "platform",
	tools: {
		status: {
			...get("现读站点 → 检查 → 说读到了什么、要人做的、agent 能做的（todo 里写着要调的工具和参数）", undefined, async () => status(await db())),
			text: statusText,
			exit: (c: Checked) => (c.read.some((r) => r.blocked) ? "human" : undefined),
		},
		verify: { ...get("读回来核清已提交、结果未知的写入", undefined, async () => run(await db())), ...writesResult },
		resolve: {
			...get(
				"人到站点上看过结果未知、不一致的写入：做成了是已核对，没做成是被拒（人说了才用）",
				z.object({ id: z.string().regex(/^\d+$/).describe("写入的编号"), status: z.enum(["已核对", "被拒"]).describe("人看到的结果") }),
				async (p) => {
					const rows =
						await (await db())`update writes set status = ${p.status}, finished_at = now() where id = ${p.id} and status in ('结果未知', '不一致', '已提交') returning id::text, op, display`;
					if (!rows.length) throw new Usage(`写入 #${p.id} 不是结果未知、不一致`);
					return { id: p.id, status: p.status, op: rows[0]!.op, display: rows[0]!.display };
				},
			),
			text: (r) => `#${r.id} ${r.op} ${r.display ?? ""}：${r.status}`,
		},
		handled: {
			...get(
				"x2 看不到结果的事，人说做完了：不再提醒",
				z.object({ keys: strs("提醒的 key（x2 status --json 的 human 里）"), note: z.string().trim().min(1).optional().describe("说明") }),
				async (p) => {
					const sql = await db();
					for (const key of p.keys)
						await sql`insert into handled (key, note) values (${key}, ${p.note ?? null}) on conflict (key) do update set note = excluded.note, at = now()`;
					return { keys: p.keys };
				},
			),
			text: (r) => `不再提醒：${r.keys.join("、")}`,
		},
		schema: get("全部工具的说明和参数（JSON Schema）", undefined, async () => schema()),
		web: {
			...get(
				"开网页（Ctrl-C 关掉）：侧栏是会话，中间是 generative 组件，右边是 interactive 组件",
				z.object({
					host: z.string().min(1).default("127.0.0.1").describe("0.0.0.0：同一个网络里别的电脑也能开"),
					port: z.coerce.number().int().min(1).max(65535).default(5170).describe("端口"),
				}),
				async (p) => {
					const { build } = await import("vite");
					await build({ configFile: `${root}platform/ui/vite.config.ts`, logLevel: "warn" });
					const { stop } = await serve(await db(), { ...p, dist: `${root}platform/ui/dist` });
					const url = `http://${p.host === "0.0.0.0" ? "localhost" : p.host}:${p.port}`;
					console.error(`网页：${url}（Ctrl-C 关掉）`);
					await new Promise<void>((ok) => process.once("SIGINT", ok).once("SIGTERM", ok));
					await stop();
					return { url };
				},
			),
			text: (r) => `关掉了 ${r.url}`,
		},
		migrate: {
			...get("建表、加列（每个命令第一次用库时也会跑）", undefined, async () => {
				await db();
				return { ok: true };
			}),
			text: () => "表都建好了",
		},
	},
};

/** 网页上一个会话的地址（x2 web 默认的地址） */
const link = (id: string) => `http://127.0.0.1:5170/#${id}`;
const sessionId = z.object({ id: str("会话编号") });

export const session: Toolkit = {
	name: "session",
	title: "会话：agent 开会话、往里放组件给人看（generative）、让人在上面做事（interactive），人在网页上（x2 web）看",
	kind: "platform",
	tools: {
		list: {
			...get("会话列表", undefined, async () => listSessions(await db())),
			text: (l) => (l.length ? l.map((s: any) => `#${s.id} ${s.title}`).join("\n") : "还没有会话：x2 session create --title <标题>"),
		},
		create: {
			...get("开一个会话，回编号和网页地址", z.object({ title: z.string().default("").describe("标题") }), async (p) => {
				const s = await createSession(await db(), p.title);
				return { ...s, url: link(s.id) };
			}),
			text: (s) => `#${s.id} ${s.title}\n${s.url}（x2 web 开着时）`,
		},
		delete: {
			...get("删会话", sessionId, async (p) => {
				await deleteSession(await db(), p.id);
				return { id: p.id };
			}),
			text: (r) => `删了会话 #${r.id}`,
		},
		show: {
			...get("会话里的组件", sessionId, async (p) => showSession(await db(), p.id)),
			text: (s) => [`#${s.id} ${s.title}`, ...s.items.map((i: any) => `  ${i.id} ${i.component} ${JSON.stringify(i.props).slice(0, 120)}`)].join("\n"),
		},
		push: {
			...get(
				"放组件：{ component: 名字, props: {…} }，或几个组成的数组（x2 session components 看有哪些、参数）；同一个会话里同一个引用再放是换掉",
				z.object({
					id: str("会话编号"),
					items: z.preprocess(parseJson, z.unknown()).describe("组件的 JSON；写 - 从 stdin 读"),
				}),
				async (p) => {
					const sql = await db();
					// 几个一起放：先都校验过，一个不对就都不放
					const items = Array.isArray(p.items) ? p.items : [p.items];
					items.forEach((x, i) => {
						try {
							parseItem(x);
						} catch (e) {
							throw new Usage(`${items.length > 1 ? `第 ${i + 1} 个：` : ""}${(e as Error).message}`);
						}
					});
					const done = [];
					for (const x of items) done.push(await push(sql, p.id, x));
					return done;
				},
			),
			text: (d) => d.map((x: any) => `${x.replaced ? "换了" : "放了"} ${x.component}（${x.id}）`).join("\n"),
		},
		components: {
			...get("组件的说明和参数（JSON Schema）", undefined, async () => catalog()),
			text: (c) => c.map((x: any) => `${x.name}（${x.kind}）：${x.description}\n  ${JSON.stringify(x.props)}`).join("\n"),
		},
	},
};
