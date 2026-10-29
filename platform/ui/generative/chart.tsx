// chart：一张图（shadcn 的 chart，Recharts）。bar、line、area 画 y 的几列，pie 画一列；颜色照主题的 chart-1…5 轮着用
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import type { Props } from "../../web/pages.ts";
import { Title } from "./title.tsx";

const color = (i: number) => `var(--chart-${(i % 5) + 1})`;

export function Chart({ props }: { props: Props<"chart"> }) {
	const { type, data, x, y } = props;
	const config: ChartConfig = Object.fromEntries(y.map((k, i) => [k, { label: k, color: color(i) }]));
	const axes = [
		<CartesianGrid key="g" vertical={false} />,
		<XAxis key="x" dataKey={x} tickLine={false} axisLine={false} />,
		<YAxis key="y" tickLine={false} axisLine={false} width={48} />,
	];
	const extras = [
		<ChartTooltip key="t" content={<ChartTooltipContent />} />,
		...(y.length > 1 ? [<ChartLegend key="l" content={<ChartLegendContent />} />] : []),
	];
	return (
		<div>
			<Title>{props.title}</Title>
			<ChartContainer config={config} className="aspect-auto h-64 w-full">
				{type === "bar" ? (
					<BarChart data={data}>
						{axes}
						{extras}
						{y.map((k) => (
							<Bar key={k} dataKey={k} fill={`var(--color-${k})`} radius={4} />
						))}
					</BarChart>
				) : type === "line" ? (
					<LineChart data={data}>
						{axes}
						{extras}
						{y.map((k) => (
							<Line key={k} dataKey={k} stroke={`var(--color-${k})`} strokeWidth={2} dot={false} />
						))}
					</LineChart>
				) : type === "area" ? (
					<AreaChart data={data}>
						{axes}
						{extras}
						{y.map((k) => (
							<Area key={k} dataKey={k} stroke={`var(--color-${k})`} fill={`var(--color-${k})`} fillOpacity={0.2} />
						))}
					</AreaChart>
				) : (
					<PieChart>
						<ChartTooltip content={<ChartTooltipContent nameKey={x} />} />
						<Pie data={data.map((d, i) => ({ ...d, fill: color(i) }))} dataKey={y[0]!} nameKey={x} innerRadius="45%" />
					</PieChart>
				)}
			</ChartContainer>
		</div>
	);
}
