// datagrid：页上引用的一张表（agent 拼的 table、columns、filter、sort、group、layout），不存数据：行现读（每 15 秒、回到页面时再读），人改一格马上存（照 tables.ts 收），存不进说原话。
// layout 是 cards 的一行一张卡片（例 商品稿的审稿），table 的是表格，点一行在右边滑出整行（能改的格在这改）；给了 group 的按组排；表有表单的能添一行
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, fail, keyOf, type Meta, type Row, meta as readMeta, usePoll } from "../../api.ts";
import { Edit, type Save, Show } from "./cells.tsx";
import type { Props } from "./schema.ts";

function groups(rows: Row[], g: Props["group"]): [string | null, Row[]][] {
	if (!g) return [[null, rows]];
	const by = new Map<string, Row[]>();
	for (const r of rows) {
		const k = String(r[g.col] ?? "（空）");
		by.set(k, [...(by.get(k) ?? []), r]);
	}
	const rank = (k: string) => {
		const i = g.values?.indexOf(k) ?? -1;
		return i < 0 ? Number.POSITIVE_INFINITY : i;
	};
	return [...by].sort(([a], [b]) => rank(a) - rank(b));
}

export function View({ props }: { props: Props }) {
	const [m, setMeta] = useState<Meta | null>(null);
	useEffect(() => {
		readMeta(props.table).then(setMeta, fail);
	}, [props.table]);
	const [rows, error, reload] = usePoll(() => api.rows(props), 15_000, [props]);
	const [local, setLocal] = useState<Row[] | null>(null);
	useEffect(() => setLocal(rows), [rows]);
	const [opened, setOpened] = useState<string | null>(null);

	if (error) return <p className="p-4 text-sm text-destructive">{error}</p>;
	if (!m || !local) return <Skeleton className="m-4 h-40" />;
	const shown: Meta = props.columns ? { ...m, columns: props.columns.flatMap((n) => m.columns.filter((c) => c.name === n)) } : m;
	const saver =
		(row: Row) =>
		(col: string): Save =>
		(value) =>
			api.set(m.name, row._key, col, value).then((r) => setLocal((all) => all?.map((x) => (keyOf(x) === keyOf(row) ? (r ?? x) : x)) ?? null), fail);
	const row = local.find((r) => keyOf(r) === opened);

	return (
		<div className="flex flex-col gap-3 p-4">
			<header className="flex flex-wrap items-center gap-2">
				<span className="text-sm text-muted-foreground">
					{m.title} · {local.length} 行
				</span>
				<div className="grow" />
				{m.form && <AddForm meta={m} onAdded={reload} />}
				<Button size="icon-sm" variant="ghost" aria-label="重读" onClick={reload}>
					<RefreshCwIcon />
				</Button>
			</header>
			{!local.length ? (
				<p className="py-8 text-center text-sm text-muted-foreground">没有</p>
			) : (
				groups(local, props.group).map(([g, list]) => (
					<section key={g ?? ""} className="flex flex-col gap-2">
						{g !== null && (
							<h4 className="flex items-center gap-2 text-sm font-medium">
								<Badge variant="secondary">{g}</Badge>
								<span className="text-muted-foreground">{list.length}</span>
							</h4>
						)}
						{props.layout === "cards" ? (
							list.map((r) => <RowCard key={keyOf(r)} meta={shown} row={r} save={saver(r)} />)
						) : (
							<Rows meta={shown} rows={list} group={props.group?.col} open={(r) => setOpened(keyOf(r))} />
						)}
					</section>
				))
			)}
			<Sheet open={Boolean(row)} onOpenChange={(o) => !o && setOpened(null)}>
				<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
					<SheetHeader>
						<SheetTitle>{row ? String(row[shown.columns[0]!.name] ?? "—") : ""}</SheetTitle>
					</SheetHeader>
					{row && <Fields meta={shown} row={row} save={saver(row)} />}
				</SheetContent>
			</Sheet>
		</div>
	);
}

function Rows({ meta, rows, group, open }: { meta: Meta; rows: Row[]; group: string | undefined; open: (r: Row) => void }) {
	const cols = meta.columns.filter((c) => c.name !== group);
	return (
		<div className="overflow-x-auto rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						{cols.map((c) => (
							<TableHead key={c.name} className="whitespace-nowrap">
								{c.label}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((r) => (
						<TableRow key={keyOf(r)} className="cursor-pointer" onClick={() => open(r)}>
							{cols.map((c) => (
								<TableCell key={c.name} className="min-w-20 max-w-72 align-top">
									<Show col={c} value={r[c.name]} compact />
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function Fields({ meta, row, save }: { meta: Meta; row: Row; save: (col: string) => Save }) {
	return (
		<dl className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-[8rem_1fr]">
			{meta.columns.map((c) => (
				<div key={c.name} className="contents">
					<dt className="text-sm text-muted-foreground">{c.label}</dt>
					<dd className="min-w-0 text-sm">
						{c.edit && !(row._readonly as string[]).includes(c.name) ? (
							<Edit col={c} value={row[c.name]} save={save(c.name)} />
						) : (
							<Show col={c} value={row[c.name]} />
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}

function RowCard({ meta, row, save }: { meta: Meta; row: Row; save: (col: string) => Save }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{String(row[meta.columns[0]!.name] ?? "—")}</CardTitle>
			</CardHeader>
			<CardContent className="p-0">
				<Fields meta={{ ...meta, columns: meta.columns.slice(1) }} row={row} save={save} />
			</CardContent>
		</Card>
	);
}

function AddForm({ meta, onAdded }: { meta: Meta; onAdded: () => void }) {
	const form = meta.form!;
	const [open, setOpen] = useState(false);
	const [values, setValues] = useState<Record<string, string>>({});
	const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));
	const submit = () =>
		api.add(meta.name, values).then(() => {
			setOpen(false);
			setValues({});
			onAdded();
		}, fail);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<Button size="sm" variant="outline">
						<PlusIcon />
						{form.title}
					</Button>
				}
			/>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{form.title}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					{form.fields.map((f) => (
						<div key={f.name} className="flex flex-col gap-1.5">
							<Label htmlFor={`f-${f.name}`}>
								{f.label}
								{f.required && <span className="text-destructive">*</span>}
							</Label>
							{f.options ? (
								<Select value={values[f.name] ?? null} onValueChange={(v) => set(f.name, String(v ?? ""))}>
									<SelectTrigger id={`f-${f.name}`} className="w-full">
										<SelectValue placeholder={f.hint || "—"} />
									</SelectTrigger>
									<SelectContent>
										{f.options.map((o) => (
											<SelectItem key={o} value={o}>
												{o}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<Input id={`f-${f.name}`} placeholder={f.hint} value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} />
							)}
						</div>
					))}
				</div>
				<DialogFooter>
					<Button onClick={submit}>添加</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export const tab = (p: Props) => p.title ?? p.table;
