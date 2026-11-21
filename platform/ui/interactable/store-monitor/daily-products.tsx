import { ArrowRightIcon, CircleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "../../api.ts";
import { errorOf } from "../../lib/state.ts";
import { readCache } from "../../read-cache.ts";
import { compareProducts } from "./comparison.ts";
import { type DailyReport, dailyReportSchema } from "./schema.ts";

const cache = readCache<DailyReport>(5 * 60_000, 24);
const format = new Intl.NumberFormat("zh-CN");
const value = (n: number | null | undefined) => (n == null ? "—" : format.format(n));
const shortDate = (date: string) => date.slice(5).replace("-", "/");
type Result = { key: string; data?: DailyReport; error?: string };

function useDailyReport(item: string, stamp: string, date?: string) {
	const cacheKey = `${item}:${stamp}:${date}`;
	const [result, setResult] = useState<Result>();
	const [attempt, setAttempt] = useState(0);
	const key = `${cacheKey}:${attempt}`;
	useEffect(() => {
		if (!date) return;
		let active = true;
		void cache
			.read(cacheKey, async () => {
				const report = dailyReportSchema.parse(await api.act(item, "daily", { date }));
				if (report.date !== date) throw new Error("虾皮报表的日期与所选日期不符");
				return report;
			})
			.then(
				(data) => active && setResult({ key, data }),
				(error: unknown) => active && setResult({ key, error: errorOf(error) }),
			);
		return () => {
			active = false;
		};
	}, [key, cacheKey, date, item]);
	const current = result?.key === key ? result : undefined;
	return {
		data: current?.data,
		error: current?.error,
		retry: () => {
			cache.invalidate(cacheKey);
			setResult(undefined);
			setAttempt((n) => n + 1);
		},
	};
}

function MetricValues({ before, after, comparing }: { before?: number | null; after?: number | null; comparing: boolean }) {
	return (
		<span className="inline-flex items-center justify-end gap-1.5 tabular-nums">
			<span className={comparing ? "text-muted-foreground" : "font-medium"}>{value(before)}</span>
			{comparing && (
				<>
					<ArrowRightIcon className="size-3 text-muted-foreground" aria-hidden="true" />
					<span className="font-medium">{value(after)}</span>
				</>
			)}
		</span>
	);
}

export function DailyProducts({ item, shopId, stamp, dates, onClear }: { item: string; shopId: string; stamp: string; dates: string[]; onClear: () => void }) {
	const [start, end] = [...dates].sort();
	const first = useDailyReport(item, stamp, start);
	const second = useDailyReport(item, stamp, end);
	const comparing = end !== undefined;
	const ready = first.data !== undefined && (!comparing || second.data !== undefined);
	const rows = ready && first.data ? compareProducts(first.data, second.data) : [];
	const failure = first.error || second.error;
	if (!start) return null;
	return (
		<Card className="min-w-0 gap-3 [--card-spacing:--spacing(4)]">
			<CardHeader className="items-center">
				<CardTitle className="flex flex-wrap items-center gap-2 text-lg tracking-tight">
					{comparing ? "商品访客对比" : "当日商品访客"}
					<Badge variant="outline" className="tabular-nums">
						{shortDate(start)}
						{end && (
							<>
								{" "}
								<ArrowRightIcon aria-hidden="true" /> {shortDate(end)}
							</>
						)}
					</Badge>
				</CardTitle>
				<CardAction>
					<Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="清除日期选择" title="清除日期选择">
						<XIcon aria-hidden="true" />
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent className="min-w-0">
				{failure ? (
					<div role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
						<CircleAlertIcon className="size-4" aria-hidden="true" /> {failure}
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								if (first.error) first.retry();
								if (second.error) second.retry();
							}}
						>
							重试
						</Button>
					</div>
				) : !ready ? (
					<div role="status" aria-busy="true" className="grid gap-2 text-sm text-muted-foreground">
						正在读取虾皮日报表…
						<Skeleton className="h-20 w-full" />
					</div>
				) : !rows.length ? (
					<p className="py-3 text-sm text-muted-foreground">所选日期的报表中暂无有访客的商品。</p>
				) : (
					<>
						<Table className="min-w-120 table-fixed">
							<TableHeader className="bg-muted/60">
								<TableRow>
									<TableHead className="w-2/5 pl-3" scope="col">
										商品
									</TableHead>
									<TableHead className="text-right" scope="col">
										商品访客
									</TableHead>
									<TableHead className="text-right" scope="col">
										搜索点击
									</TableHead>
									<TableHead className="pr-3 text-right" scope="col">
										推荐点击
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row) => (
									<TableRow key={row.id}>
										<TableCell className="pl-3">
											<a
												className="block truncate font-medium hover:underline"
												href={`https://shopee.tw/product/${shopId}/${row.id}`}
												target="_blank"
												rel="noreferrer"
												title={row.name}
											>
												{row.name}
											</a>
										</TableCell>
										<TableCell className="text-right">
											<MetricValues before={row.before?.visitors} after={row.after?.visitors} comparing={comparing} />
											{row.change ? (
												<Badge
													variant="secondary"
													className={`ml-1.5 tabular-nums ${row.change > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}`}
												>
													{row.change > 0 ? "+" : ""}
													{format.format(row.change)}
												</Badge>
											) : null}
										</TableCell>
										<TableCell className="text-right">
											<MetricValues before={row.before?.search} after={row.after?.search} comparing={comparing} />
										</TableCell>
										<TableCell className="pr-3 text-right">
											<MetricValues before={row.before?.recommendation} after={row.after?.recommendation} comparing={comparing} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						<p className="mt-2 text-xs text-muted-foreground">来源按商品卡点击计。— 表示缺少该项数据。</p>
					</>
				)}
			</CardContent>
		</Card>
	);
}
