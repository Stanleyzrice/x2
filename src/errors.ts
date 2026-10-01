// x2 的错误分类：退出码告诉调用方（agent）下一步做什么。0 成功；1 一般错误；2 用法不对；3 要人处理；4 写的结果未知
// 先例：himalaya、Pimalaya 的输出约定（退出码是区分结果和错误的唯一信号）

/** 命令用法不对（没有这个命令、参数不对）：改命令再跑。退出码 2 */
export class Usage extends Error {}

/** 要人处理：没登录、要过滑块、浏览器没连上。请运营在浏览器里处理好再重试。退出码 3 */
export class NeedsHuman extends Error {}

export const EXIT = { error: 1, usage: 2, human: 3, unknown: 4 } as const;

export function kindOf(e: unknown): "usage" | "human" | "error" {
	return e instanceof Usage ? "usage" : e instanceof NeedsHuman ? "human" : "error";
}
