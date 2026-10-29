// table：一张小表（数据在组件里）。数字靠右
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Props } from "../../web/sessions.ts";
import { Title } from "./title.tsx";

export function SnapshotTable({ props }: { props: Props<"table"> }) {
	const numeric = props.columns.map(
		(_, j) => props.rows.some((r) => typeof r[j] === "number") && props.rows.every((r) => r[j] === null || typeof r[j] === "number"),
	);
	return (
		<div>
			<Title>{props.title}</Title>
			<div className="overflow-x-auto rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							{props.columns.map((c, j) => (
								<TableHead key={c} className={numeric[j] ? "text-right" : ""}>
									{c}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{props.rows.map((r, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 快照，行不会变
							<TableRow key={i}>
								{r.map((v, j) => (
									<TableCell key={props.columns[j]} className={numeric[j] ? "text-right tabular-nums" : "whitespace-pre-wrap"}>
										{v === null ? "—" : typeof v === "boolean" ? (v ? "是" : "否") : typeof v === "number" ? v.toLocaleString("zh-CN") : v}
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}
