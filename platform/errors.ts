// x2 的错误分类：退出码告诉调用方（agent）下一步做什么。0 成功；1 一般错误；2 用法不对；3 要人处理；4 写的结果未知
// 先例：himalaya、Pimalaya 的输出约定（退出码是区分结果和错误的唯一信号）

export class Usage extends Error {}

export class NeedsHuman extends Error {}

export class Challenge extends NeedsHuman {}

export const EXIT = { error: 1, usage: 2, human: 3, unknown: 4 } as const;

export function kindOf(e: unknown): "usage" | "human" | "error" {
	return e instanceof Usage ? "usage" : e instanceof NeedsHuman ? "human" : "error";
}
