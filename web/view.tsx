// 一个视图：读行（每 15 秒、回到页面时再读），按列分组，表格或卡片；表格点一行开卡片。人改一格马上存，存不进说原话
import { Badge, Button, Dialog, Empty, Input, InputArea, LayerCard, Loader, Select, Table, Tabs } from "@cloudflare/kumo";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Column, fail, keyOf, type Meta, type Row, toast } from "./api.ts";
import { Outline, type Section } from "./outline.tsx";
import { Edit, type Save, Show } from "./value.tsx";

type View = Meta["views"][number];

/** 按分组列排好组：给了组的顺序照它，没给的照行的顺序 */
function groups(rows: Row[], g: View["group"]): [string | null, Row[]][] {
	if (!g) return [[null, rows]];
	const by = new Map<string, Row[]>();
	for (const r of rows) {
		const k = String(r[g.col] ?? "（空）");
		by.set(k, [...(by.get(k) ?? []), r]);
	}
	const rank = (k: string) => { const i = g.values?.indexOf(k) ?? -1; return i < 0 ? Infinity : i; };
	return [...by].sort(([a], [b]) => rank(a) - rank(b));
}

export function TableView({ meta, view, onView }: { meta: Meta; view: View; onView: (title: string) => void }) {
	const [rows, setRows] = useState<Row[] | null>(null);
	const [opened, setOpened] = useState<string | null>(null);
	const load = useCallback(() => api.rows(meta.name, view.title).then(setRows, fail), [meta.name, view.title]);
	useEffect(() => {
		setRows(null);
		load();
		const t = setInterval(load, 15_000);
		window.addEventListener("focus", load);
		return () => { clearInterval(t); window.removeEventListener("focus", load); };
	}, [load]);

	const saver = (row: Row) => (col: string): Save => (value) =>
		api.set(meta.name, row._key, col, value).then((r) => setRows((all) => all?.map((x) => (keyOf(x) === keyOf(row) ? (r ?? x) : x)) ?? null), fail);
	const row = rows?.find((r) => keyOf(r) === opened);
	const grouped = rows ? groups(rows, view.group) : [];
	// 目录：卡片一张一节（名字是第一列），表格一组一节
	const first = meta.columns[0]!.name;
	const labels = view.cards ? (rows ?? []).map((r) => String(r[first] ?? "—")) : grouped.flatMap(([g, list]) => (g === null ? [] : [`${g}（${list.length}）`]));
	// 名字没变就是同一份目录（每 15 秒重读一次行，别让目录重新量）
	const sections: Section[] = useMemo(() => labels.map((label, i) => ({ id: `s${i}`, label })), [labels.join("\n")]);

	return (
		<div className="flex flex-col gap-4 p-4 pt-16 md:p-6">
			<header className="flex flex-wrap items-center gap-3">
				<h1 className="text-xl font-semibold">{meta.title}</h1>
				{rows && <span className="text-sm text-kumo-subtle">{rows.length} 行</span>}
				{meta.views.length > 1 && <Tabs tabs={meta.views.map((v) => ({ value: v.title, label: v.title }))} value={view.title} onValueChange={onView} />}
				<div className="grow" />
				{meta.form && <AddForm meta={meta} onAdded={load} />}
			</header>
			{!rows ? <Loader /> : !rows.length ? <Empty title={view.empty ?? "没有"} /> : grouped.map(([g, list], i) => (
				<section key={g ?? ""} id={view.cards ? undefined : `s${i}`} className="flex scroll-mt-4 flex-col gap-3">
					{g !== null && <h2 className="flex items-center gap-2 text-sm font-medium"><Badge variant="neutral">{g}</Badge><span className="text-kumo-subtle">{list.length}</span></h2>}
					{view.cards
						? list.map((r) => <Card key={keyOf(r)} id={`s${rows.indexOf(r)}`} meta={meta} row={r} save={saver(r)} />)
						: <Rows meta={meta} rows={list} group={view.group?.col} save={saver} open={(r) => setOpened(keyOf(r))} />}
				</section>
			))}
			<Outline sections={sections} unit={view.cards ? "张" : "组"} />
			<Dialog.Root open={Boolean(row)} onOpenChange={(o) => !o && setOpened(null)}>
				<Dialog size="xl" className="max-h-[90vh] overflow-y-auto p-0">
					<Dialog.Title className="sr-only">{meta.title}</Dialog.Title>
					{row && <Card meta={meta} row={row} save={saver(row)} />}
				</Dialog>
			</Dialog.Root>
		</div>
	);
}

/** 这一行能改这一列 */
const editable = (c: Column, row: Row) => Boolean(c.edit) && !(row._readonly as string[]).includes(c.name);
/** 表格里能直接改的：勾和选；别的点开这一行的卡片改 */
const inline = (c: Column, row: Row) => editable(c, row) && (c.type === "bool" || Boolean(c.edit?.options));

/** 表格：分组的那一列在组的标题上，表里不再写 */
function Rows({ meta, rows, group, save, open }: { meta: Meta; rows: Row[]; group?: string; save: (row: Row) => (col: string) => Save; open: (row: Row) => void }) {
	const columns = meta.columns.filter((c) => c.name !== group);
	return (
		<LayerCard className="overflow-x-auto p-0">
			<Table>
				<Table.Header>
					<Table.Row>{columns.map((c) => <Table.Head key={c.name} className="whitespace-nowrap">{c.label}</Table.Head>)}</Table.Row>
				</Table.Header>
				<Table.Body>
					{rows.map((r) => (
						<Table.Row key={keyOf(r)} className="cursor-pointer align-top" onClick={() => open(r)}>
							{columns.map((c) => (
								<Table.Cell key={c.name} className={c.type === "bool" ? "w-px" : "max-w-80 min-w-28"} onClick={inline(c, r) ? (e) => e.stopPropagation() : undefined}>
									{inline(c, r) ? <Edit col={c} value={r[c.name]} save={save(r)(c.name)} /> : <Show col={c} value={r[c.name]} compact />}
								</Table.Cell>
							))}
						</Table.Row>
					))}
				</Table.Body>
			</Table>
		</LayerCard>
	);
}

/** 一行的卡片：第一列是标题，下面一列一行；人能改的给控件 */
function Card({ id, meta, row, save }: { id?: string; meta: Meta; row: Row; save: (col: string) => Save }) {
	const [first, ...rest] = meta.columns;
	return (
		<LayerCard id={id} className="scroll-mt-4">
			<LayerCard.Secondary className="text-base font-medium"><Show col={first!} value={row[first!.name]} /></LayerCard.Secondary>
			<LayerCard.Primary className="flex flex-col gap-3">
				{rest.map((c) => (
					<div key={c.name} className="grid gap-1 sm:grid-cols-[12rem_1fr] sm:gap-4">
						<div className="text-sm text-kumo-subtle">{c.label}</div>
						<div className="min-w-0">{editable(c, row) ? <Edit col={c} value={row[c.name]} save={save(c.name)} /> : <Show col={c} value={row[c.name]} />}</div>
					</div>
				))}
			</LayerCard.Primary>
		</LayerCard>
	);
}

/** 表单：人填一行新的（添加货源、上报到货问题） */
function AddForm({ meta, onAdded }: { meta: Meta; onAdded: () => void }) {
	const form = meta.form!;
	const [open, setOpen] = useState(false);
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const set = (name: string) => (v: string) => setValues((x) => ({ ...x, [name]: v }));
	const submit = () => {
		setBusy(true);
		api.add(meta.name, values)
			.then(() => { toast.add({ title: `${form.title}：好了`, variant: "success" }); setValues({}); setOpen(false); onAdded(); },
				fail)
			.finally(() => setBusy(false));
	};
	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Trigger render={(p) => <Button {...p} variant="primary">{form.title}</Button>} />
			<Dialog size="lg" className="flex flex-col gap-4 p-6">
				<Dialog.Title className="text-lg font-semibold">{form.title}</Dialog.Title>
				{form.fields.map((f) => {
					const label = `${f.label}${f.required ? "" : "（可以不填）"}`;
					return f.options
						? <Select key={f.name} label={label} value={values[f.name] ?? null} placeholder={f.hint || "—"} onValueChange={(v) => set(f.name)(String(v ?? ""))} items={Object.fromEntries(f.options.map((o) => [o, o]))} />
						: f.type === "number"
							? <Input key={f.name} label={label} type="number" description={f.hint} value={values[f.name] ?? ""} onChange={(e) => set(f.name)(e.target.value)} />
							: <InputArea key={f.name} label={label} description={f.hint} autoResize minRows={1} value={values[f.name] ?? ""} onValueChange={set(f.name)} />;
				})}
				<div className="flex justify-end gap-2">
					<Dialog.Close render={(p) => <Button {...p}>取消</Button>} />
					<Button variant="primary" loading={busy} onClick={submit}>提交</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
