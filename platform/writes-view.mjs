// 写入引擎状态图的读法：一条写入（第一条）的状态，已提交、结果未知、不一致再分站点上做没做
const NAME = { pending: "待执行", submitted: "已提交", unknown: "结果未知", mismatch: "不一致", verified: "已核对", refused: "被拒", skipped: "未执行" };
const row = (v) => v.rows[1];
export const title = "一条写入";
export const state = (v) => {
	const r = row(v);
	if (!r) return "还没交";
	const open = ["submitted", "unknown", "mismatch"].includes(r.st);
	return open ? `${NAME[r.st]}（站点上${r.did ? "做了" : "没做"}）` : NAME[r.st];
};
export const group = (v) => {
	const r = row(v);
	if (!r || r.st === "pending") return "等执行";
	if (r.st === "submitted") return "在路上";
	if (r.st === "unknown" || r.st === "mismatch") return "要人看";
	return "有结果";
};
export const colors = { 等执行: "tan", 在路上: "blue", 要人看: "orange", 有结果: "teal" };
export const step = (action, _from, to) => {
	const b = row(to);
	switch (action) {
		case "Propose":
			return "交写入";
		case "VerifyStart":
			return "进程退出了，下一个 x2 清掉";
		case "VerifyOne":
			return b.st === "verified" ? "核清：读回来做成了" : "核清：还看不出";
		case "Gate":
			return "这一轮停下了（要人登录）";
		case "Prepare":
			return b.st === "submitted" ? "现读，记意图" : "现读后不做（业务不做、要人登录、同一个对象没核清）";
		case "Submit":
			if (b.st === "refused") return "站点拒了";
			if (b.st === "skipped") return "要人处理，没发出去";
			return b.did ? "提交，站点做了" : "提交，站点没做";
		case "Check":
			return { verified: "读回来做成了", refused: "没回话，读回来没做", mismatch: "站点说做了，读回来没有", unknown: "读回来看不出" }[b.st];
		case "Human":
			return b.st === "verified" ? "人看过：做成了" : "人看过：没做成";
		default:
			return action;
	}
};
