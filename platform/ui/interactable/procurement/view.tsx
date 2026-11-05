// 新订单提醒在 X2 打开期间检查 Shopee；采购先预览、再确认，保存原请求，网络中断或结果未知都只查原结果。
import { ArrowUpRightIcon, BellIcon, PackageIcon, RefreshCwIcon, ShoppingCartIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLightbox } from "@/components/lightbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type Item as PageItem, type PageSummary, usePoll } from "../../api.ts";
import type { Props } from "./schema.ts";
import type { Monitor, OrderLine, PurchaseResult } from "./types.ts";

const time = (v: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未知");
const reads = new Map<string, { at: number; value: Promise<Monitor> }>();
const readMonitor = (item: string, force = false) => {
	const previous = reads.get(item);
	if (!force && previous && Date.now() - previous.at < 45_000) return previous.value;
	const value = api.act<Monitor>(item, "sync");
	reads.set(item, { at: Date.now(), value });
	value.catch(() => {
		if (reads.get(item)?.value === value) reads.delete(item);
	});
	return value;
};
const seen = new Set<string>();

export function OrderNotifications({ pages }: { pages: PageSummary[] }) {
	const id = pages.find((p) => p.workspace?.component === "procurement")?.id;
	useEffect(() => {
		if (!id) return;
		let stopped = false;
		let busy = false;
		const read = async () => {
			if (busy) return;
			busy = true;
			try {
				const page = await api.page(id);
				const item = page.items.find((i) => i.fixed && i.component === "procurement");
				if (!item || stopped) return;
				const data = await readMonitor(item.id);
				if (stopped || data.error || !data.checkedAt) return;
				const fresh = data.orders.filter((o) => {
					const key = `x2-order-notified:${o.shop}:${o.sn}`;
					if (o.cartDone || o.cartPending || seen.has(key)) return false;
					try {
						if (localStorage.getItem(key)) return false;
					} catch {
						/* 储存禁用时用本次会话去重。 */
					}
					return true;
				});
				if (!fresh.length) return;
				for (const o of fresh) {
					const key = `x2-order-notified:${o.shop}:${o.sn}`;
					seen.add(key);
					try {
						localStorage.setItem(key, "1");
					} catch {
						/* 本次会话的 seen 仍可去重。 */
					}
				}
				toast(`Shopee 有 ${fresh.length} 张待采购订单`, {
					description: fresh
						.map((o) => o.sn)
						.slice(0, 3)
						.join("、"),
					duration: 12_000,
					action: {
						label: "查看采购",
						onClick: () => {
							location.hash = page.workspace?.key ?? id;
						},
					},
				});
			} catch {
				/* 登录或读取失败由采购页面显示，后台不反复弹窗。 */
			} finally {
				busy = false;
			}
		};
		void read();
		const timer = setInterval(() => void read(), 60_000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [id]);
	return null;
}

type Pending = { requestId: string; token: string };
type Preview = { token: string; display: string; expiresAt: string; trialRequired: boolean; requestId: string };
function saved(key: string): Pending | null {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
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
	const [data, error, reload] = usePoll(() => readMonitor(item.id), 60_000, [item.id]);
	const [selected, setSelected] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const lock = useRef(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const storageKey = `x2-procurement-pending:${item.id}:${props.shops.join(",")}`;
	const [pending, setPending] = useState(() => saved(storageKey));
	const [result, setResult] = useState<PurchaseResult | null>(null);
	const available = data?.orders.filter((o) => !o.cartDone && !o.cartPending) ?? [];
	const selectedOrders = selected.filter((sn) => available.some((o) => o.sn === sn));
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
					reads.delete(item.id);
					reload();
				}
			} catch (e) {
				if (!stopped) setActionError((e as Error).message);
			}
		};
		void read();
		const timer = setInterval(() => void read(), 5000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [item.id, pending, storageKey, reload]);
	const start = async () => {
		if (lock.current || pending || !selectedOrders.length) return;
		lock.current = true;
		setBusy(true);
		setActionError(null);
		try {
			const requestId = crypto.randomUUID();
			const prepared = await api.prepare(item.id, "cart", { orders: selectedOrders, requestId });
			setPreview({ ...prepared, requestId });
		} catch (e) {
			setActionError((e as Error).message);
		} finally {
			setBusy(false);
			lock.current = false;
		}
	};
	const confirm = async () => {
		if (!preview || lock.current || pending) return;
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
			setActionError(`采购请求待核对：${(e as Error).message}。页面只查询原结果，请勿重新加购。`);
		} finally {
			setBusy(false);
			lock.current = false;
		}
	};
	const resume = async () => {
		if (!pending || lock.current || result?.state !== "prepared") return;
		lock.current = true;
		setBusy(true);
		setActionError(null);
		try {
			setResult(await api.confirm<PurchaseResult>(pending.token));
		} catch (e) {
			setActionError((e as Error).message);
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
					<p className="text-sm text-muted-foreground">{props.shops.join("、")} · X2 打开时每分钟检查新订单，点击开始采购后加入 1688 购物车。</p>
				</div>
				<Button
					variant="outline"
					disabled={busy}
					onClick={() => {
						reads.delete(item.id);
						reload();
					}}
				>
					<RefreshCwIcon />
					刷新订单
				</Button>
			</header>
			<div className="flex flex-wrap items-center gap-3 text-sm">
				<Badge variant="secondary">待采购 {available.length}</Badge>
				<span className="text-muted-foreground">Shopee 最近读取：{data?.checkedAt ? time(data.checkedAt) : "尚未读取"}</span>
				<a className="ml-auto inline-flex items-center gap-1 underline underline-offset-4" href="https://seller.shopee.tw/" target="_blank" rel="noreferrer">
					打开 Shopee Seller Centre
					<ArrowUpRightIcon className="size-4" />
				</a>
			</div>
			{(error || data?.error || actionError) && (
				<p role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
					{actionError ?? data?.error ?? error}
				</p>
			)}
			{pending && (
				<p role="status" className="rounded-lg border bg-muted/30 p-4 text-sm">
					采购请求正在执行或等待核对，页面会查询原结果。结果未知时请在 1688 核对购物车并完成结果核对，核清前不会重新加购。
				</p>
			)}
			{pending && result?.state === "prepared" && (
				<Button disabled={busy} onClick={() => void resume()}>
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
			<Card className="overflow-hidden">
				<CardContent className="p-0">
					<div className="flex flex-wrap items-center gap-3 border-b p-4">
						<div className="space-y-1 text-sm text-muted-foreground">
							<p>已选 {selectedOrders.length} 张订单</p>
							<p className="text-xs">按下单时间倒序 · 最新订单在前</p>
						</div>
						<Button
							className="ml-auto"
							disabled={busy || Boolean(pending) || !selectedOrders.length || !data?.checkedAt || Boolean(data.error)}
							onClick={() => void start()}
						>
							<ShoppingCartIcon />
							{busy ? "正在读取采购信息…" : "开始采购"}
						</Button>
					</div>
					{!data ? (
						<Skeleton className="m-4 h-48" />
					) : !data.orders.length ? (
						<p className="p-12 text-center text-sm text-muted-foreground">当前没有 Shopee 待出货订单。</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-10">
										<Checkbox
											aria-label="全选待采购订单"
											disabled={Boolean(pending)}
											checked={Boolean(available.length) && selectedOrders.length === available.length}
											indeterminate={selectedOrders.length > 0 && selectedOrders.length < available.length}
											onCheckedChange={(checked) => setSelected(checked === true ? available.map((o) => o.sn) : [])}
										/>
									</TableHead>
									<TableHead>订单</TableHead>
									<TableHead>下单时间</TableHead>
									<TableHead>商品、规格与 1688 货源</TableHead>
									<TableHead>采购状态</TableHead>
									<TableHead>出货期限</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.orders.map((order) => (
									<TableRow key={order.sn}>
										<TableCell>
											<Checkbox
												aria-label={`选择订单 ${order.sn}`}
												checked={selectedOrders.includes(order.sn)}
												disabled={Boolean(pending) || order.cartDone || order.cartPending}
												onCheckedChange={(checked) =>
													setSelected((before) => (checked === true ? [...new Set([...before, order.sn])] : before.filter((sn) => sn !== order.sn)))
												}
											/>
										</TableCell>
										<TableCell className="align-top">
											<p className="font-medium">{order.sn}</p>
											<p className="mt-1 text-xs text-muted-foreground">{order.shop}</p>
										</TableCell>
										<TableCell className="whitespace-nowrap align-top text-xs">
											{order.createdAt ? <time dateTime={order.createdAt}>{time(order.createdAt)}</time> : "未知"}
										</TableCell>
										<TableCell className="min-w-80 max-w-lg whitespace-normal align-top text-sm">
											{order.lines.length ? (
												<div className="space-y-4">
													{order.lines.map((line) => (
														<ProductLine key={`${line.itemId}:${line.modelId}`} line={line} />
													))}
												</div>
											) : (
												<p className="whitespace-pre-wrap">{order.items}</p>
											)}
										</TableCell>
										<TableCell className="text-sm">{order.step}</TableCell>
										<TableCell className="whitespace-nowrap text-xs">{time(order.shipBy)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
			<p className="text-xs text-muted-foreground">
				1688 链接对应商品，规格匹配在开始采购时核对。缺少已选货源、规格不匹配、订单取消或已有采购时会停止并显示原因。加入购物车后由你核对、付款下单。
			</p>
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
						<Button disabled={busy || Boolean(pending)} onClick={() => void confirm()}>
							确认加购
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
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
