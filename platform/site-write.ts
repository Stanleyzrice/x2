import { AsyncLocalStorage } from "node:async_hooks";
import { Usage } from "./errors.ts";

const submission = new AsyncLocalStorage<{ available: boolean }>();

/** 写入引擎记下提交意图后开放一次站点请求，结束时收回未用额度。 */
export async function runSiteSubmission<T>(send: () => Promise<T>): Promise<T> {
	const scope = { available: true };
	try {
		return await submission.run(scope, send);
	} finally {
		scope.available = false;
	}
}

export function claimSiteSubmission(): void {
	const scope = submission.getStore();
	if (!scope?.available) throw new Usage("站点业务写入只能由写入引擎提交一次");
	scope.available = false;
}
