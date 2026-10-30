// 订单流程状态图的读法：检查算出的「当前步骤」（tools/orders/check.ts 的 STEPS），加购、预报还没核清的标出来
const arr = (s) => Object.values(s ?? {});
const flying = (ws) => arr(ws).some((w) => ["pending", "submitted", "unknown", "mismatch"].includes(w.st));
const line = (v) => {
	const done = arr(v.cw).some((w) => w.st === "verified");
	if (v.bought >= 1) return "paid";
	return done && v.cart >= 1 ? "in cart" : "none";
};
export const title = "一张订单的一个规格";
export const state = (v) => {
	if (v.plat === "cancelled") return "已取消";
	if (v.cb === "packed") return "已打包";
	if (v.cb === "arrived") return "待 chanboss 打包";
	if (v.cb === "forecast") return "待 chanboss 收货";
	if (!v.sourced && line(v) !== "paid") return "缺货源";
	if (line(v) === "none") return flying(v.cw) ? "待加购（加购没核清）" : "待加购";
	if (line(v) === "in cart") return "待 1688 付款";
	return flying(v.fw) ? "待预报（预报没核清）" : "待预报";
};
export const group = (v) => {
	const s = state(v);
	if (s.includes("没核清")) return "等核清";
	if (s === "已取消" || s === "已打包") return "结束";
	if (s.startsWith("待 chanboss")) return "chanboss";
	return "采购";
};
export const colors = { 采购: "blue", 等核清: "orange", chanboss: "teal", 结束: "tan" };
export const step = (action, _from, to) => {
	switch (action) {
		case "ChooseSource":
			return "人选定货源";
		case "PlanCart":
			return "agent 交加购";
		case "Crash":
			return "进程退出（待执行的下一个 x2 清掉）";
		case "CartPrepare":
		case "CartSubmit":
		case "CartCheck":
		case "VerifyCarts":
		case "ResolveCarts":
			return line(to) === "in cart" ? "加购做成了（读回来、核清或人看过）" : "加购没做成或没执行（被拒、不做、进程退出）";
		case "Pay":
			return "人付款";
		case "RemoveFromCart":
			return "人从购物车删了";
		case "Cancel":
			return "订单取消";
		case "PlanFc":
			return "agent 交预报";
		case "FcPrepare":
		case "FcSubmit":
		case "FcCheck":
		case "VerifyFcs":
		case "ResolveFcs":
			return to.cb === "forecast" ? "预报提交到 chanboss" : "预报没做成或没执行";
		case "ChanbossReceive":
			return "chanboss 收到货";
		case "ChanbossPack":
			return "chanboss 打包";
		default:
			return action;
	}
};
