import type { DailyReport } from "./schema.ts";

export function chooseDate(selected: readonly string[], date: string): string[] {
	return selected.includes(date) ? selected.filter((value) => value !== date) : [...selected.slice(0, 1), date];
}

export function compareProducts(before: DailyReport, after?: DailyReport) {
	const previous = new Map(before.rows.map((row) => [row.id, row]));
	const current = new Map(after?.rows.map((row) => [row.id, row]));
	const ids = new Set([...previous.keys(), ...current.keys()]);
	return [...ids]
		.flatMap((id) => {
			const a = previous.get(id);
			const b = current.get(id);
			if (!(a?.visitors || b?.visitors)) return [];
			return [
				{
					id,
					name: b?.name || a?.name || id,
					before: a,
					after: b,
					change: a?.visitors != null && b?.visitors != null ? b.visitors - a.visitors : null,
				},
			];
		})
		.sort(
			(a, b) =>
				(b.change ?? Number.NEGATIVE_INFINITY) - (a.change ?? Number.NEGATIVE_INFINITY) ||
				(b.after?.visitors ?? b.before?.visitors ?? 0) - (a.after?.visitors ?? a.before?.visitors ?? 0) ||
				a.name.localeCompare(b.name, "zh-CN"),
		);
}
