// x2 session：会话（platform/web/sessions.ts）。agent 开会话、往里放组件给人看（generative）、让人在上面做事（interactive），人在网页上（x2 web）看
// x2 session list | create <标题> | delete <会话> | show <会话> | push <会话> < 组件.json | components

import { db } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { catalog, createSession, deleteSession, listSessions, parseItem, push, showSession } from "../web/sessions.ts";

const USAGE = [
	"x2 session list                       会话列表",
	"x2 session create <标题>               开一个会话，回编号和网页地址",
	"x2 session delete <会话>               删会话",
	"x2 session show <会话>                 会话里的组件",
	'x2 session push <会话> < 组件.json      放组件：{ "component": 名字, "props": {…} }，或几个组成的数组',
	"x2 session components                  组件的说明和参数（JSON Schema）",
].join("\n");

const readStdin = async () => {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
};

/** 网页上一个会话的地址（x2 web 默认的地址） */
const link = (id: string) => `http://127.0.0.1:5170/#${id}`;

export async function sessionCommand(args: string[], json: boolean): Promise<void> {
	const [sub, ...rest] = args;
	const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value) : text);
	if (sub === "components") {
		const c = catalog();
		return out(c, c.map((x) => `${x.name}（${x.kind}）：${x.description}\n  ${JSON.stringify(x.props)}`).join("\n"));
	}
	const sql = await db();
	if (!sub || sub === "list") {
		const list = await listSessions(sql);
		return out(list, list.length ? list.map((s) => `#${s.id} ${s.title}`).join("\n") : "还没有会话：x2 session create <标题>");
	}
	if (sub === "create") {
		const s = await createSession(sql, rest.join(" "));
		return out({ ...s, url: link(s.id) }, `#${s.id} ${s.title}\n${link(s.id)}（x2 web 开着时）`);
	}
	if (sub === "delete") {
		if (!rest[0]) throw new Usage(USAGE);
		await deleteSession(sql, rest[0]);
		return out({ id: rest[0] }, `删了会话 #${rest[0]}`);
	}
	if (sub === "show") {
		if (!rest[0]) throw new Usage(USAGE);
		const s = await showSession(sql, rest[0]);
		return out(s, [`#${s.id} ${s.title}`, ...s.items.map((i) => `  ${i.id} ${i.component} ${JSON.stringify(i.props).slice(0, 120)}`)].join("\n"));
	}
	if (sub === "push") {
		if (!rest[0]) throw new Usage(USAGE);
		let input: unknown;
		try {
			input = JSON.parse(await readStdin());
		} catch {
			throw new Usage(`x2 session push 从 stdin 读 JSON\n${USAGE}`);
		}
		// 几个一起放：先都校验过，一个不对就都不放
		const items = Array.isArray(input) ? input : [input];
		items.forEach((x, i) => {
			try {
				parseItem(x);
			} catch (e) {
				throw new Usage(`${items.length > 1 ? `第 ${i + 1} 个：` : ""}${(e as Error).message}`);
			}
		});
		const done = [];
		for (const x of items) done.push(await push(sql, rest[0], x));
		return out(done, done.map((d) => `${d.replaced ? "换了" : "放了"} ${d.component}（${d.id}）`).join("\n"));
	}
	throw new Usage(USAGE);
}
