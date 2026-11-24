// 按人选定的下单日期采集 Shopee；采购先预览、再确认，保存原请求，网络中断或结果未知都只查原结果。

import { ArrowUpRightIcon, BellIcon, PackageIcon, RefreshCwIcon, ShoppingCartIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLightbox } from "@/components/lightbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorOf, saved as savedValue } from "@/lib/state";
import type { Monitor, Order, OrderLine, PurchaseMatch, PurchaseResult, SkuDemand } from "../../../web/procurement.ts";
import { api, type BrowserConnectionResult, type Item as PageItem, usePoll } from "../../api.ts";
import { BrowserConnection } from "../../browser-connection.tsx";
import type { Props } from "./schema.ts";
import { preserveMonitor, selectedDemand } from "./sync.ts";

const time = (v: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未知");
type Pending = { requestId: string; token: string };
type Preview = { token: string; display: string; expiresAt: string; trialRequired: boolean; requestId: string };
function saved(key: string): Pending | null {
	try {
		const value: unknown = JSON.parse(savedValue(key) ?? "null");
		if (
			value &&
			typeof value === "object" &&
			"requestId" in value &&
			typeof value.requestId === "string" &&
			"token" in value &&
			typeof value.token === "string"
		)
			return { requestId: value.requestId, token: value.token };
	} catch {
		/* 没有可恢复的采购请求。 */
	}
	return null;
}

export function View({ props, item }: { props: Props; item: PageItem }) {
	return <Procurement key={`${item.id}:${props.shops.join(",")}`} props={props} item={item} />;
}
function Procurement({ props, item }: { props: Props; item: PageItem }) {
	const [dateRange, setDateRange] = useState({ from: "", to: "" });
	const [data, setData] = useState<Monitor | null>(null);
	const [syncing, setSyncing] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const connectionBusy = useRef(false);
	const lock = useRef(false);
	const collecting = useRef<Promise<void> | null>(null);
	const attempted = useRef(false);
	const [syncError, setSyncError] = useState<string | null>(null);
	const validRange = Boolean(dateRange.from && dateRange.to && dateRange.from <= dateRange.to);
	const read = async (refresh = true) => {
		if (!validRange || collecting.current || connectionBusy.current || lock.current) return;
		attempted.current = true;
		setSyncing(true);
		setSyncError(null);
		const request = api
			.readProcurement(item.id, dateRange, refresh)
			.then((latest) => {
				setData((previous) => preserveMonitor(previous, latest));
				if (latest.purchases?.complete) setActionError((error) => (/滑块|安全验证/.test(error ?? "") ? null : error));
			})
			.catch((e: unknown) => setSyncError(errorOf(e)))
			.finally(() => {
				collecting.current = null;
				setSyncing(false);
			});
		collecting.current = request;
		await request;
	};
	const reload = useRef(read);
	reload.current = read;
	const [selected, setSelected] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const storageKey = `x2-procurement-pending:${item.id}:${props.shops.join(",")}`;
	const [pending, setPending] = useState(() => saved(storageKey));
	const [result, setResult] = useState<PurchaseResult | null>(null);
	const [verifiedBuyer, setVerifiedBuyer] = useState<BrowserConnectionResult["account"]>(undefined);
	const [settings, settingsError, reloadSettings] = usePoll(
		() => api.rows({ table: "order_settings", columns: ["buy_account"], filter: { id: "1" } }),
		60_000,
		[item.id],
	);
	const buyer = settings ? String(settings[0]?.buy_account ?? "") || null : data?.purchases?.selected;
	const connectionChanged = (checking: boolean) => {
		connectionBusy.current = checking;
		setConnecting(checking);
	};
	const connected = async () => {
		if (collecting.current) await collecting.current;
		if (attempted.current) await reload.current();
	};
	const changeDate = (field: "from" | "to", value: string) => {
		setDateRange({ ...dateRange, [field]: value });
		attempted.current = false;
		setData(null);
		setSelected([]);
		setSyncError(null);
		setActionError(null);
	};
	const chooseBuyer = async () => {
		if (!verifiedBuyer || buyer !== null || lock.current || syncing || connectionBusy.current || pending) return;
		lock.current = true;
		setBusy(true);
		setActionError(null);
		try {
			await api.set("order_settings", { id: "1" }, "buy_account", verifiedBuyer.id);
			reloadSettings();
			setVerifiedBuyer(undefined);
		} catch (e) {
			setActionError(errorOf(e));
			return;
		} finally {
			lock.current = false;
			setBusy(false);
		}
		await connected();
	};
	const errors = [
		...new Set([actionError, syncError, settingsError, data?.error, data?.purchases?.error].filter((message): message is string => Boolean(message))),
	];
	const verificationRequired = [data?.error, data?.purchases?.error].some((message) => /滑块|安全验证/.test(message ?? ""));
	// 勾选用于读取和核对；是否允许加购由预览及确认的服务端实时检查决定。
	const selectable = data?.orders.filter((o) => !o.cartPending) ?? [];
	const selectedOrders = selected.filter((sn) => selectable.some((o) => o.sn === sn));
	const selectionNeedsReview = selectable.some((o) => selectedOrders.includes(o.sn) && !o.purchase?.canPurchase);
	useEffect(() => {
		if (!pending) return;
		let stopped = false;
		const read = async () => {
			try {
				const response = await api.act<PurchaseResult>(item.id, "result", { requestId: pending.requestId });
				if (stopped) return;
				setResult(response);
				if ((response.state === "completed" && !response.outcome?.unknown) || ["expired", "not-found"].includes(response.state)) {
					localStorage.removeItem(storageKey);
					setPending(null);
					setSelected([]);
					if (attempted.current) void reload.current(false);
				}
			} catch (e) {
				if (!stopped) setActionError(errorOf(e));
			}
		};
		void read();
		const timer = setInterval(() => void read(), 5000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [item.id, pending, storageKey]);
	const start = async () => {
		if (lock.current || connectionBusy.current || pending || !selectedOrders.length) return;
		lock.current = true;
		setBusy(true);
		setActionError(null);
		try {
			const requestId = crypto.randomUUID();
			const prepared = await api.prepare(item.id, "cart", { orders: selectedOrders, requestId, dateRange });
			setPreview({ ...prepared, requestId });
		} catch (e) {
			setActionError(errorOf(e));
		} finally {
			setBusy(false);
			lock.current = false;
		}
	};
	const confirm = async () => {
		if (!preview || lock.current || connectionBusy.current || pending) return;
		lock.current = true;
		setBusy(true);
		setActionError(null);
		const request = { requestId: preview.requestId, token: preview.token };
		try {
			localStorage.setItem(storageKey, JSON.stringify(request));
			setPending(request);
			setPreview(null);
			const response = await api.confirm<PurchaseResult>(request.token);
			setResult(response);
		} catch (e) {
			setActionError(`采购请求待核对：${errorOf(e)}。页面只查询原结果，请勿重新加购。`);
		} finally {
			setBusy(false);
			lock.current = false;
		}
	};
	const resume = async () => {
		if (!pending || lock.current || connectionBusy.current || result?.state !== "prepared") return;
		lock.current = true;
		setBusy(true);
		setActionError(null);
		try {
			setResult(await api.confirm<PurchaseResult>(pending.token));
		} catch (e) {
			setActionError(errorOf(e));
		} finally {
			setBusy(false);
			lock.current = false;
		}
	};
	return (
		<div className="mx-auto w-full max-w-6xl space-y-6 p-5 md:p-8">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-2">
					<p className="flex items-center gap-2 text-xs text-muted-foreground">
						<BellIcon className="size-4" /> SHOPEE ORDERS
					</p>
					<h2 className="text-2xl font-semibold">订单采购</h2>
					<p className="text-sm text-muted-foreground">{props.shops.join("、")} · 按下单日期采集待出货订单，核对后可加入 1688 购物车。</p>
				</div>
			</header>
			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1.5">
					<Label htmlFor={`order-from-${item.id}`}>下单起始日</Label>
					<Input
						id={`order-from-${item.id}`}
						type="date"
						className="w-44"
						disabled={syncing || busy || connecting || Boolean(preview)}
						value={dateRange.from}
						onChange={(e) => changeDate("from", e.target.value)}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={`order-to-${item.id}`}>下单截止日</Label>
					<Input
						id={`order-to-${item.id}`}
						type="date"
						className="w-44"
						disabled={syncing || busy || connecting || Boolean(preview)}
						value={dateRange.to}
						min={dateRange.from || undefined}
						onChange={(e) => changeDate("to", e.target.value)}
					/>
				</div>
				<Button variant="outline" disabled={!validRange || busy || syncing || connecting} onClick={() => void read()}>
					<RefreshCwIcon />
					{syncing ? "正在读取订单…" : "开始采集"}
				</Button>
				{dateRange.from && dateRange.to && !validRange && (
					<span role="alert" className="text-sm text-destructive">
						截止日不能早于起始日
					</span>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-3 text-sm">
				{data && <Badge variant="secondary">可选订单 {selectable.length}</Badge>}
				<span className="text-muted-foreground">Shopee 最近读取：{data?.checkedAt ? time(data.checkedAt) : "尚未读取"}</span>
				{data && (
					<span className="text-xs text-muted-foreground">
						下单日期 {dateRange.from} 至 {dateRange.to}（UTC+8）
					</span>
				)}
				<a className="ml-auto inline-flex items-center gap-1 underline underline-offset-4" href="https://seller.shopee.tw/" target="_blank" rel="noreferrer">
					打开 Shopee Seller Centre
					<ArrowUpRightIcon className="size-4" />
				</a>
			</div>
			<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
				<span>1688 采购账号：{data?.purchases?.loginId ?? buyer ?? "尚未选择"}</span>
				<span>上次完整同步：{data?.purchases?.capturedAt ? time(data.purchases.capturedAt) : "尚未同步"}</span>
				{data?.purchases?.error && !syncing ? <span>{data.purchases.capturedAt ? "本次同步未完成，保留上次完整记录。" : "采购订单同步尚未完成。"}</span> : null}
			</div>
			<div className="grid gap-3 md:grid-cols-2">
				<Card>
					<CardContent className="space-y-3 p-4">
						<h3 className="text-sm font-medium">1688 采购账号连接</h3>
						<BrowserConnection
							expectedAccount={data?.purchases?.account ?? buyer ?? undefined}
							verificationRequired={errors.some((message) => /滑块|安全验证/.test(message))}
							disabled={busy || connecting}
							onCheckingChange={(checking) => {
								if (checking) setVerifiedBuyer(undefined);
								connectionChanged(checking);
							}}
							onConnected={async (account) => {
								if (buyer == null) setVerifiedBuyer(account);
								await connected();
							}}
						/>
						{buyer === null && verifiedBuyer && (
							<Button variant="outline" size="sm" disabled={busy || syncing || connecting || Boolean(pending)} onClick={() => void chooseBuyer()}>
								将 {verifiedBuyer.name} 设为采购账号
							</Button>
						)}

						{verificationRequired && <p className="text-xs text-muted-foreground">采购记录等候人工验证。完成后点「验证完成，重新检测」，X2 会重新读取订单。</p>}
					</CardContent>
				</Card>
				{props.shops.map((shop) => (
					<Card key={shop}>
						<CardContent className="space-y-3 p-4">
							<h3 className="text-sm font-medium">Shopee（虾皮）店铺授权 · {shop}</h3>
							<BrowserConnection
								site="shopee"
								expectedAccount={shop}
								disabled={busy || connecting}
								onCheckingChange={connectionChanged}
								onConnected={connected}
							/>
						</CardContent>
					</Card>
				))}
			</div>
			{errors.length > 0 && (
				<div role="alert" className="space-y-2 rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
					{errors.map((message) => (
						<p key={message}>{message}</p>
					))}
				</div>
			)}
			{pending && (
				<p role="status" className="rounded-lg border bg-muted/30 p-4 text-sm">
					采购请求正在执行或等待核对，页面会查询原结果。结果未知时请在 1688 核对购物车并完成结果核对，核清前不会重新加购。
				</p>
			)}
			{pending && result?.state === "prepared" && (
				<Button disabled={busy || connecting} onClick={() => void resume()}>
					继续原确认
				</Button>
			)}
			{result && (
				<Card>
					<CardContent className="space-y-2 py-4">
						<p className="font-medium">
							{result.state === "completed"
								? "采购执行结果"
								: result.state === "prepared"
									? "采购确认尚未提交，可继续原确认"
									: result.state === "expired"
										? "确认已过期，可重新查看采购预览"
										: "采购请求待核对"}
						</p>
						{result.outcome?.ran.map((row) => (
							<p key={row.id} className="text-sm">
								{row.display}：{row.status}
								{row.why ? ` · ${row.why}` : ""}
							</p>
						))}
						{result.outcome?.blocked && <p className="text-sm text-destructive">{result.outcome.blocked}</p>}
						<a
							className="inline-flex items-center gap-1 text-sm underline underline-offset-4"
							href="https://cart.1688.com/cart.htm"
							target="_blank"
							rel="noreferrer"
						>
							前往 1688 购物车核对并付款
							<ArrowUpRightIcon className="size-4" />
						</a>
					</CardContent>
				</Card>
			)}
			{!data?.error && data?.excluded?.length ? (
				<details className="rounded-lg border px-4 py-3 text-sm">
					<summary className="cursor-pointer">本次读取有 {data.excluded.length} 张订单未计入采购</summary>
					{data.excluded.map((order) => (
						<p key={order.sn} className="mt-2 text-muted-foreground">
							{order.sn} · {order.reason}（Shopee 状态：{order.status}）
						</p>
					))}
				</details>
			) : null}
			<Card className="overflow-hidden">
				<CardContent className="p-0">
					<div className="flex flex-wrap items-center gap-3 border-b p-4">
						<div className="space-y-1 text-sm text-muted-foreground">
							<h3 className="font-medium text-foreground">按 SKU（商品规格）汇总</h3>
							<label htmlFor={`select-orders-${item.id}`} className="flex items-center gap-2">
								<Checkbox
									id={`select-orders-${item.id}`}
									aria-label="全选待采购订单"
									disabled={Boolean(pending) || !selectable.length || Boolean(data?.error || syncError) || syncing || !data?.demand?.length}
									checked={Boolean(selectable.length) && selectedOrders.length === selectable.length}
									indeterminate={selectedOrders.length > 0 && selectedOrders.length < selectable.length}
									onCheckedChange={(checked) => setSelected(checked ? selectable.map((order) => order.sn) : [])}
								/>
								全选订单 · 已选 {selectedOrders.length} 张
							</label>
							{selectionNeedsReview ? <p className="text-xs">所选订单含需核对的采购状态，将先读取核对；勾选不会加购或付款。</p> : null}
						</div>
						<Button
							className="ml-auto"
							disabled={
								busy ||
								connecting ||
								buyer === null ||
								Boolean(pending) ||
								!selectedOrders.length ||
								Boolean(data?.error || syncError) ||
								syncing ||
								!data?.demand?.length
							}
							onClick={() => void start()}
						>
							<ShoppingCartIcon />
							{busy ? "正在读取采购信息…" : "开始采购"}
						</Button>
					</div>
					{!data ? (
						syncing ? (
							<Skeleton className="m-4 h-48" />
						) : (
							<p className="p-12 text-center text-sm text-muted-foreground">
								{syncError ? "采集未完成，请重试。" : "选择下单起始日和截止日后，点击「开始采集」。"}
							</p>
						)
					) : !data.orders.length ? (
						<p className="p-12 text-center text-sm text-muted-foreground">
							{data.error || syncError
								? "暂时无法确认待出货订单，请查看读取错误后重试。"
								: data.checkedAt
									? "本次读取没有可整单采购的 Shopee 待出货订单。"
									: "尚未取得已核对的 Shopee 待出货订单，正在后台更新…"}
						</p>
					) : !data.demand?.length ? (
						<p className="p-4 text-sm text-muted-foreground">暂时无法核对规格汇总，请刷新订单后重试。</p>
					) : (
						<SkuDemandTable
							rows={data.demand}
							orders={data.orders}
							selected={new Set(selectedOrders)}
							pending={Boolean(pending || data.error || syncError) || syncing}
							stale={Boolean(data.error || syncError)}
							onSelect={(sn, checked) => setSelected((before) => (checked ? [...new Set([...before, sn])] : before.filter((id) => id !== sn)))}
						/>
					)}
				</CardContent>
			</Card>
			<p className="text-xs text-muted-foreground">需补件数已扣除能匹配的已付和待付数量。待核对件数单列；部分已采购的订单请核对后补齐，以免整单重复加购。</p>
			<Dialog
				open={Boolean(preview)}
				onOpenChange={(open) => {
					if (!open && !busy) setPreview(null);
				}}
			>
				<DialogContent className="max-h-[85vh] overflow-auto sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>确认加入 1688 购物车</DialogTitle>
						<DialogDescription>核对订单、采购账号、规格与数量后确认。</DialogDescription>
					</DialogHeader>
					<p className="whitespace-pre-wrap text-sm leading-7">{preview?.display}</p>
					<DialogFooter>
						<Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>
							取消
						</Button>
						<Button disabled={busy || connecting || Boolean(pending)} onClick={() => void confirm()}>
							确认加购
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function SkuDemandTable({
	rows,
	orders,
	selected,
	stale,
	pending,
	onSelect,
}: {
	rows: SkuDemand[];
	orders: Order[];
	selected: Set<string>;
	stale: boolean;
	pending: boolean;
	onSelect: (sn: string, checked: boolean) => void;
}) {
	const [detailSn, setDetailSn] = useState<string | null>(null);
	const bySn = new Map(orders.map((order) => [order.sn, order]));
	const detail = detailSn ? bySn.get(detailSn) : undefined;
	const scoped = selectedDemand(rows, selected);
	const amounts = new Map(scoped.map((row) => [row.key, row]));
	const showOrder = (source: SkuDemand["orders"][number]) => (
		<div key={source.sn} className="mt-2 flex items-center gap-2">
			<Checkbox
				aria-label={`选择整单 ${source.sn}`}
				checked={selected.has(source.sn)}
				disabled={pending || bySn.get(source.sn)?.cartPending !== false}
				onCheckedChange={(checked) => onSelect(source.sn, checked === true)}
			/>
			<button type="button" className="underline underline-offset-2" onClick={() => setDetailSn(source.sn)}>
				{source.sn}
			</button>
			<span>× {source.qty}</span>
		</div>
	);
	return (
		<div className="space-y-3 p-4">
			<p className="text-sm">
				{stale && "上次成功读取的快照 · "}
				{selected.size ? "已选订单" : "全部待出货订单"} · {scoped.length} 个规格，订单需求 {scoped.reduce((n, r) => n + r.qty, 0)} 件， 本次已确认要买{" "}
				{scoped.reduce((n, r) => n + r.buyQty, 0)} 件，待核对 {scoped.reduce((n, r) => n + r.reviewQty, 0)} 件。
			</p>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>商品规格</TableHead>
						<TableHead className="text-right">需求件数</TableHead>
						<TableHead className="text-right">本次要买</TableHead>
						<TableHead>采购进度</TableHead>
						<TableHead>来源订单</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => {
						const total = amounts.get(row.key);
						return (
							<TableRow key={row.key}>
								<TableCell className="min-w-56 max-w-md whitespace-normal align-top">
									<div className="flex items-start gap-3">
										<ProductPicture key={row.image ?? "missing"} image={row.image ?? null} name={row.name} spec={row.spec} />
										<div className="min-w-0">
											<p className="font-medium">{row.name || "未命名商品"}</p>
											<p className="text-xs text-muted-foreground">{row.spec || "单规格"}</p>
											{row.target && (
												<a className="text-xs underline" href={`https://detail.1688.com/offer/${row.target.offerId}.html`} target="_blank" rel="noreferrer">
													1688 SKU {row.target.skuId}
												</a>
											)}
										</div>
									</div>
								</TableCell>
								<TableCell className="text-right align-top tabular-nums">{total ? total.qty : "—"}</TableCell>
								<TableCell className="text-right align-top font-semibold tabular-nums">
									{total ? (total.buyQty || !total.reviewQty ? `${total.buyQty} 件` : "待核对") : "—"}
								</TableCell>
								<TableCell className="align-top text-xs text-muted-foreground">
									{total && total.paidQty > 0 && <p>已付 {total.paidQty} 件</p>}
									{total && total.unpaidQty > 0 && <p>待付款 {total.unpaidQty} 件</p>}
									{total && total.reviewQty > 0 && <p>待核对 {total.reviewQty} 件</p>}
								</TableCell>
								<TableCell className="align-top text-xs">
									{row.orders.slice(0, 2).map(showOrder)}
									{row.orders.length > 2 && (
										<details>
											<summary className="cursor-pointer">另有 {row.orders.length - 2} 张订单</summary>
											{row.orders.slice(2).map(showOrder)}
										</details>
									)}
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
			<Dialog
				open={Boolean(detail)}
				onOpenChange={(open) => {
					if (!open) setDetailSn(null);
				}}
			>
				<DialogContent className="max-h-[85vh] overflow-auto">
					<DialogHeader>
						<DialogTitle>来源订单 {detail?.sn}</DialogTitle>
						<DialogDescription>
							{detail?.shop} · 下单 {time(detail?.createdAt ?? null)} · 出货期限 {time(detail?.shipBy ?? null)}
						</DialogDescription>
					</DialogHeader>
					{detail?.lines.length ? detail.lines.map((line) => <ProductLine key={`${line.itemId}:${line.modelId}`} line={line} />) : <p>{detail?.items}</p>}
					<ProcurementStatus purchase={detail?.purchase} />
					{detail?.cartPending ? <p>加购请求待核对</p> : detail?.cartDone ? <p>已有加购记录</p> : null}
				</DialogContent>
			</Dialog>
		</div>
	);
}

function ProcurementStatus({ purchase }: { purchase: PurchaseMatch | undefined }) {
	if (!purchase) return <Badge variant="outline">等待 1688 采购记录</Badge>;
	const records = [...new Map(purchase.matches.map((record) => [record.orderId, record])).values()];
	return (
		<div className="space-y-1.5">
			<Badge variant={purchase.state === "paid" ? "secondary" : "outline"}>{purchase.label}</Badge>
			<p className="text-xs text-muted-foreground">
				需求 {purchase.requiredQty} 件 · 已付 {purchase.paidQty} 件{purchase.unpaidQty ? ` · 待付 ${purchase.unpaidQty} 件` : ""}
			</p>
			{records.map((record) => (
				<a key={record.orderId} href={record.url} target="_blank" rel="noreferrer" className="block break-all text-xs underline underline-offset-4">
					1688 订单 {record.orderId} <ArrowUpRightIcon className="inline size-3" />
				</a>
			))}
			{purchase.reason ? <p className="max-w-72 text-xs text-muted-foreground">{purchase.reason}</p> : null}
		</div>
	);
}

function ProductLine({ line }: { line: OrderLine }) {
	return (
		<div className="flex items-start gap-3">
			<ProductPicture key={line.image ?? "missing"} image={line.image} name={line.name} spec={line.spec} />
			<div className="min-w-0 flex-1 space-y-1.5">
				<p className="break-words font-medium leading-5">{line.name || "未命名商品"}</p>
				<p className="break-words text-xs text-muted-foreground">
					{line.spec || "规格未提供"} · 数量 × {line.qty}
				</p>
				{line.purchase ? (
					<span className="text-xs text-muted-foreground">
						{line.purchase.label} · 已付 {line.purchase.paidQty}/{line.purchase.requiredQty} 件
					</span>
				) : null}
				{line.sources.length ? (
					<div className="space-y-1.5">
						{line.sources.map((source) => (
							<div key={source.offerId} className="space-y-1">
								<a
									className="inline-flex max-w-full items-start gap-1 text-xs underline underline-offset-4"
									href={source.url}
									target="_blank"
									rel="noreferrer"
									title={source.title || source.offerId}
								>
									<span className="min-w-0 break-words">
										1688 · {source.chosen ? "已选货源" : "上品来源"} · {source.title || source.offerId}
									</span>
									<ArrowUpRightIcon className="size-3 shrink-0" />
								</a>
								{source.broken && <p className="text-xs text-destructive">货源不可用：{source.broken}</p>}
							</div>
						))}
					</div>
				) : (
					<p className="text-xs text-muted-foreground">1688 货源待补充</p>
				)}
			</div>
		</div>
	);
}

function ProductPicture({ image, name, spec }: { image: string | null; name: string; spec: string }) {
	const [failed, setFailed] = useState(false);
	const alt = [name, spec].filter(Boolean).join(" · ") || "订单商品";
	const lightbox = useLightbox(image ? [{ src: image, alt }] : []);
	return (
		<>
			{image && !failed ? (
				<button
					type="button"
					className="size-16 shrink-0 overflow-hidden rounded-lg border bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring"
					aria-label={`查看商品图片：${alt}`}
					onClick={() => lightbox.open(0)}
				>
					<img src={image} alt={alt} loading="lazy" referrerPolicy="no-referrer" className="size-full object-contain" onError={() => setFailed(true)} />
				</button>
			) : (
				<div className="flex size-16 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border bg-muted/30 text-muted-foreground">
					<PackageIcon className="size-5" />
					<span className="text-[10px]">{failed ? "图片加载失败" : "暂无图片"}</span>
				</div>
			)}
			{lightbox.lightbox}
		</>
	);
}
