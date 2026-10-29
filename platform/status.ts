// x2 status：问每个业务工具的检查（toolkit 的 check：现读站点、跑检查），合起来说三件事：读到了什么、要人做的、agent 能做的。
// 加上写入的：结果未知、不一致的提醒人去站点上看，已提交、结果未知的 agent 先核清（x2 verify）。人说做完了的（x2 handled）不再提醒
import type { Sql } from "./db/index.ts";
import { type Checked, type Reminder, type Todo, toolkits, writeOps } from "./tool.ts";

export async function status(sql: Sql): Promise<Checked> {
	const checked: Checked[] = [];
	for (const k of toolkits()) if (k.check) checked.push(await k.check(sql));
	const ops = writeOps();
	const unsure = await sql`select id::text, op, display, status, error from writes where status in ('已提交', '结果未知', '不一致') order by id`;
	const look = unsure
		.filter((w) => w.status !== "已提交")
		.map(
			(w): Reminder => ({
				key: `unknown:${w.id}`,
				kind: "结果未知",
				shop: null,
				due: null,
				link: ops[w.op]?.link ?? null,
				title: `${w.status}：#${w.id} ${w.op} ${w.display ?? ""}`,
				detail: `${w.error ?? ""}\n到站点上看一眼做没做成，告诉 agent（x2 resolve --id ${w.id} --status 已核对|被拒）。不要重做`,
			}),
		);
	const handled = new Set((await sql`select key from handled`).map((x) => x.key as string));
	const due = (r: Reminder) => r.due?.getTime() ?? Number.POSITIVE_INFINITY;
	const human = [...checked.flatMap((c) => c.human), ...look]
		.filter((x) => !handled.has(x.key))
		.sort((a, b) => due(a) - due(b) || a.kind.localeCompare(b.kind));
	const verify = unsure.filter((w) => w.status !== "不一致");
	const todo: Todo[] = [
		...(verify.length ? [{ kind: "核清", why: `${verify.length} 个写入结果未知：先读回来`, tool: "verify", params: {} }] : []),
		...checked.flatMap((c) => c.todo),
	];
	return { read: checked.flatMap((c) => c.read), human, todo };
}
