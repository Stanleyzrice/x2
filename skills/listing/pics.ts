// 商品稿的图的类型（纯数据）：筛字的结论、一张图走到哪了、水印的设置
export type Verdict = "d" | "r" | "m" | "p" | "n";

/** 一张图走到哪了。drop 是不用它的原因（给人看） */
export type Pic = {
	from: string;
	sha?: string;
	verdict?: Verdict;
	simplified?: boolean;
	translated?: string;
	final?: string;
	imageId?: string;
	width?: number;
	height?: number;
	drop?: string;
};
export type Pics = { main: Pic[]; detail: Pic[]; options: Pic[] };

export type Mark = { text: string; size: number; opacity: number; position: "top-left" | "top-right" | "center" | "bottom-left" | "bottom-right" };
