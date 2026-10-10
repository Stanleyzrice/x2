// x2 strategy：选品的策略（docs/listing.md「策略」）。agent 定策略、做实验；每份商品稿记下从哪个策略来，按策略看效果。
// x2 strategy add <名字> --bet "假设" --how "选品方法"   记一个策略（试验中）
// x2 strategy set <名字> --status 使用中|已停用|试验中 [--note …]
// x2 strategy list                                     每个策略出了几份商品稿、上架了几个
import { db } from "../db/index.ts";
import { Usage } from "../errors.ts";

const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const STATUS = ["试验中", "使用中", "已停用"];

export async function strategyCommand(args: string[], json: boolean): Promise<void> {
	const [sub, ...rest] = args;
	const sql = await db();
	const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value) : text);
	const name = rest.find((a, j) => !a.startsWith("--") && !["--bet", "--how", "--status", "--note"].includes(rest[j - 1] ?? ""));

	if (sub === "add") {
		const bet = flag(rest, "--bet"), how = flag(rest, "--how");
		if (!name || !bet || !how) throw new Usage(`x2 strategy add <名字> --bet "假设" --how "选品方法"`);
		const [r] = await sql`insert into strategies (name, bet, how, note) values (${name}, ${bet}, ${how}, ${flag(rest, "--note") ?? null})
			on conflict (name) do nothing returning name`;
		if (!r) throw new Usage(`已经有策略「${name}」了：改状态用 x2 strategy set`);
		return out({ name, bet, how, status: "试验中" }, `记下策略「${name}」（试验中）。上它选出来的货源：x2 listing add <店> <链接…> --strategy ${name}`);
	}

	if (sub === "set") {
		const status = flag(rest, "--status"), note = flag(rest, "--note");
		if (!name || (status && !STATUS.includes(status)) || (!status && note === undefined)) throw new Usage(`x2 strategy set <名字> --status ${STATUS.join("|")} [--note …]`);
		const r = await sql`update strategies set status = coalesce(${status ?? null}, status), note = coalesce(${note ?? null}, note), updated_at = now() where name = ${name} returning name`;
		if (!r.length) throw new Usage(`没有策略「${name}」`);
		return out({ name, status, note }, `策略「${name}」：${status ?? "（状态不变）"}${note ? `，备注：${note}` : ""}`);
	}

	if (sub === "list") {
		const rows = await sql`
			select s.name, s.status, s.bet, s.how,
				count(l.id)::int as listings,
				count(l.id) filter (where l.listed_at is not null)::int as live,
				count(l.id) filter (where l.cancelled)::int as cancelled
			from strategies s left join listings l on l.strategy = s.name
			group by s.name order by s.created_at`;
		return out(rows, rows.map((r) => `${r.name}（${r.status}）：商品稿 ${r.listings} 份，上架 ${r.live} 个${r.cancelled ? `，已放弃 ${r.cancelled}` : ""}\n  假设：${r.bet ?? ""}\n  选品方法：${r.how ?? ""}`).join("\n"));
	}

	throw new Usage("x2 strategy add | set | list（见 docs/listing.md「策略」）");
}
