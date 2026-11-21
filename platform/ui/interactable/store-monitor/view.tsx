import { lazy } from "react";
import type { Item as PageItem } from "../../api.ts";
import type { Props } from "./schema.ts";

const Dashboard = lazy(async () => ({ default: (await import("./dashboard.tsx")).View }));

export function View({ props, item }: { props: Props; item: PageItem }) {
	return <Dashboard key={`${props.shop}:${item.id}`} item={item} />;
}
