// chart：一张图（shadcn 的 chart，Recharts；快照，不要入场动画：截图、看的时候都是画完的）。bar、line、area 画 y 的几列，pie 画一列；颜色照主题的 chart-1…8 按顺序用，不循环（schema 限了最多 8 个系列、8 块）
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import { Title } from "@/components/title.tsx";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import type { Props } from "./schema.ts";

const color = (i: number) => `var(--chart-${i + 1})`;

export function View({ props }: { props: Props }) {
	const { type, data, x, y } = props;
	// 饼图一块一个颜色、图例照块的名字；别的一列一个颜色
	const config: ChartConfig =
		type === "pie"
			? Object.fromEntries(data.map((d, i) => [String(d[x]), { label: String(d[x]), color: color(i) }]))
			: Object.fromEntries(y.map((k, i) => [k, { label: k, color: color(i) }]));
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
							<Bar key={k} dataKey={k} fill={`var(--color-${k})`} radius={4} isAnimationActive={false} />
						))}
					</BarChart>
				) : type === "line" ? (
					<LineChart data={data}>
						{axes}
						{extras}
						{y.map((k) => (
							<Line key={k} dataKey={k} stroke={`var(--color-${k})`} strokeWidth={2} dot={false} isAnimationActive={false} />
						))}
					</LineChart>
				) : type === "area" ? (
					<AreaChart data={data}>
						{axes}
						{extras}
						{y.map((k) => (
							<Area key={k} dataKey={k} stroke={`var(--color-${k})`} fill={`var(--color-${k})`} fillOpacity={0.2} isAnimationActive={false} />
						))}
					</AreaChart>
				) : (
					<PieChart>
						<ChartTooltip content={<ChartTooltipContent nameKey={x} />} />
						<Pie data={data.map((d, i) => ({ ...d, fill: color(i) }))} dataKey={y[0]!} nameKey={x} innerRadius="45%" isAnimationActive={false} />
						<ChartLegend content={<ChartLegendContent nameKey={x} />} />
					</PieChart>
				)}
			</ChartContainer>
		</div>
	);
}
