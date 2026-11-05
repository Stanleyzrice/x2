---- MODULE flow ----
\* 订单流程（tools/orders/check.ts 的检查 + tools/orders/writes.ts 的加购、预报）的 TLA+ 模型：一张订单一个规格（要 1 件），
\* 从缺货源到 chanboss 打包。agent 照检查算出的 todo 交加购、预报（x2 orders cart / forecast 先再算一遍检查），
\* 写入引擎执行（prepare 现读 → 记意图 → 提交一次 → 读回对账），进程随时可能退出、之后 x2 verify；
\* 人选货源、付款、从购物车删、取消订单、到站点上看结果未知的；chanboss 收货、打包。检查的规则：
\*   NoDoubleBuy        这一行在 1688 购物车里的加上付了款的不超过要的 1 件（同一个订单行不会被准备两次加购）
\*   ForecastOnlyPaid   预报提交到 chanboss 时这一行已经付了款
\*   NoCartForCancelled 取消了的订单不再准备加购（检查不算进加购，prepare 现读也不过）
\* 怎么跑（要 Java、TLC，不进 CI）：用 pstack 的 statechart（skills/statechart/scripts/statechart），在仓库根目录：
\*   statechart tools/orders/flow.tla --config tools/orders/flow.cfg --out <临时目录>
\*   statechart tools/orders/flow.tla --config tools/orders/flow-chart.cfg --view tools/orders/flow-view.mjs --out <临时目录>
\*     状态图（检查算出的当前步骤），out 里的 chart.mmd 换进 tools/orders/flow.mmd
\* 改了 check.ts 的步骤、加购预报该不该做的判断、writes.ts 的 prepare，这里跟着改再跑。
\* 写入引擎本身的规则在 platform/writes.tla 查过，这里只放它对订单有影响的几步。
\* 状态名对照：plat 是 Shopee 的订单状态（open 待出货、cancelled 不成立或取消中、shipped 已出货）；
\* OrderSource 区分 Shopee 主来源采购与历史 Chanboss 预报；Shopee 不依赖 cb，也不自动预报。
\* cb 是 chanboss（todo 待处理、forecast 已预报、arrived 已到齐、packed 已打包）；写入的 st 同 platform/writes.tla。
\* 没放进模型的：几张订单合一行加购（key 是几行合起来的）、外部采购、退款、到货问题、规格不匹配、1688 下架涨价（当成 prepare 可能不做）。
EXTENDS Naturals, Sequences

CONSTANTS MaxW, Lag, OrderSource

VARIABLES plat, cb, sourced, cart, bought, cw, fw, pc, cur, reply, unpaidFc, cancelledPrep

vars == <<plat, cb, sourced, cart, bought, cw, fw, pc, cur, reply, unpaidFc, cancelledPrep>>

InFlight == {"pending", "submitted", "unknown", "mismatch"}
Look == {"unknown", "mismatch"}

\* check.ts：allocate 只拿做成了（已核对）的加购分采购单、购物车；没有做成的加购时，付了款的按外部采购算
DoneCart == \E i \in DOMAIN cw : cw[i].st = "verified"
LineState ==
  IF DoneCart THEN (IF bought >= 1 THEN "paid" ELSE IF cart >= 1 THEN "in cart" ELSE "gone")
  ELSE (IF bought >= 1 THEN "paid" ELSE "none")
Covered == LineState \in {"paid", "in cart"}
CartFlying == \E i \in DOMAIN cw : cw[i].st \in InFlight
FcFlying == \E i \in DOMAIN fw : fw[i].st \in InFlight
Open == plat = "open" /\ (OrderSource = "shopee" \/ cb # "packed")
NeedsBuy == OrderSource = "shopee" \/ cb = "todo"
Paid == LineState = "paid"

\* 检查算出的加购（cartPlan）、预报（forecasts）
PlanCartOk == Open /\ NeedsBuy /\ sourced /\ ~Covered /\ ~CartFlying
PlanFcOk == OrderSource = "chanboss" /\ Open /\ NeedsBuy /\ Paid /\ ~FcFlying

Settle(r, d) ==
  IF d = "yes" THEN "verified"
  ELSE IF d = "no" THEN (IF r = "done" THEN "mismatch" ELSE "refused")
  ELSE "unknown"

\* 加购的读回对账：购物车里这个规格的件数比提交前多了才算做了；人这时付了款、删了，件数没多
CartReadback(i, fresh) ==
  IF cw[i].did /\ cart >= 1 THEN {"yes", "unclear"} \cup (IF Lag THEN {"no"} ELSE {})
  ELSE IF fresh THEN {"no", "unclear"} ELSE {"unclear"}

\* 预报的读回对账：chanboss 上不是待处理了才算做了
FcReadback(i, fresh) ==
  IF fw[i].did THEN {"yes", "unclear"} \cup (IF Lag THEN {"no"} ELSE {})
  ELSE IF fresh THEN {"no", "unclear"} ELSE {"unclear"}

Init ==
  /\ plat = "open"
  /\ cb = "todo"
  /\ sourced = FALSE
  /\ cart = 0
  /\ bought = 0
  /\ cw = <<>>
  /\ fw = <<>>
  /\ pc = "idle"
  /\ cur = 0
  /\ reply = "none"
  /\ unpaidFc = FALSE
  /\ cancelledPrep = FALSE

Idle == /\ pc' = "idle" /\ cur' = 0 /\ reply' = "none"

\* ---- 人、站点 ----

ChooseSource ==
  /\ ~sourced
  /\ sourced' = TRUE
  /\ UNCHANGED <<plat, cb, cart, bought, cw, fw, pc, cur, reply, unpaidFc, cancelledPrep>>

Pay ==
  /\ cart >= 1
  /\ bought' = bought + cart
  /\ cart' = 0
  /\ UNCHANGED <<plat, cb, sourced, cw, fw, pc, cur, reply, unpaidFc, cancelledPrep>>

RemoveFromCart ==
  /\ cart >= 1
  /\ cart' = cart - 1
  /\ UNCHANGED <<plat, cb, sourced, bought, cw, fw, pc, cur, reply, unpaidFc, cancelledPrep>>

Cancel ==
  /\ plat = "open"
  /\ cb \in {"todo", "forecast"}
  /\ plat' = "cancelled"
  /\ UNCHANGED <<cb, sourced, cart, bought, cw, fw, pc, cur, reply, unpaidFc, cancelledPrep>>

ChanbossReceive ==
  /\ cb = "forecast" /\ bought >= 1
  /\ cb' = "arrived"
  /\ UNCHANGED <<plat, sourced, cart, bought, cw, fw, pc, cur, reply, unpaidFc, cancelledPrep>>

ChanbossPack ==
  /\ cb = "arrived" /\ plat = "open"
  /\ cb' = "packed"
  /\ plat' = "shipped"
  /\ UNCHANGED <<sourced, cart, bought, cw, fw, pc, cur, reply, unpaidFc, cancelledPrep>>

ResolveCart(i) ==
  /\ cw[i].st \in Look
  /\ cw' = [cw EXCEPT ![i].st = IF cw[i].did THEN "verified" ELSE "refused"]
  /\ UNCHANGED <<plat, cb, sourced, cart, bought, fw, pc, cur, reply, unpaidFc, cancelledPrep>>

ResolveFc(i) ==
  /\ fw[i].st \in Look
  /\ fw' = [fw EXCEPT ![i].st = IF fw[i].did THEN "verified" ELSE "refused"]
  /\ UNCHANGED <<plat, cb, sourced, cart, bought, cw, pc, cur, reply, unpaidFc, cancelledPrep>>

\* ---- agent、写入引擎 ----

\* x2 status 算出加购 → x2 orders cart 再算一遍（planCart）→ 交一条待执行
PlanCart ==
  /\ pc = "idle"
  /\ Len(cw) < MaxW
  /\ PlanCartOk
  /\ cw' = Append(cw, [st |-> "pending", did |-> FALSE])
  /\ pc' = "cart prepare"
  /\ cur' = Len(cw) + 1
  /\ cancelledPrep' = (cancelledPrep \/ plat = "cancelled")
  /\ UNCHANGED <<plat, cb, sourced, cart, bought, fw, reply, unpaidFc>>

\* 加购的 prepare：现读采购单、购物车（covered）和 Shopee 待出货状态；货源、规格或数量变化也不做
CartPrepare ==
  /\ pc = "cart prepare"
  /\ \/ /\ Covered \/ plat # "open" \/ OrderSource # "shopee"
        /\ cw' = [cw EXCEPT ![cur].st = "skipped"]
        /\ Idle
        /\ UNCHANGED cancelledPrep
     \/ /\ cw' = [cw EXCEPT ![cur].st = "skipped"]
        /\ Idle
        /\ UNCHANGED cancelledPrep
     \/ /\ ~Covered /\ plat = "open" /\ OrderSource = "shopee"
        /\ cw' = [cw EXCEPT ![cur].st = "submitted"]
        /\ pc' = "cart submit"
        /\ cancelledPrep' = (cancelledPrep \/ plat = "cancelled")
        /\ UNCHANGED <<cur, reply>>
  /\ UNCHANGED <<plat, cb, sourced, cart, bought, fw, unpaidFc>>

CartSubmit ==
  /\ pc = "cart submit"
  /\ \/ /\ cw' = [cw EXCEPT ![cur].st = "refused"]
        /\ Idle
        /\ UNCHANGED cart
     \/ /\ cw' = [cw EXCEPT ![cur].did = TRUE]
        /\ cart' = cart + 1
        /\ reply' \in {"done", "unknown"}
        /\ pc' = "cart check"
        /\ UNCHANGED cur
     \/ /\ reply' \in {"done", "unknown"}
        /\ pc' = "cart check"
        /\ UNCHANGED <<cw, cart, cur>>
  /\ UNCHANGED <<plat, cb, sourced, bought, fw, unpaidFc, cancelledPrep>>

CartCheck ==
  /\ pc = "cart check"
  /\ \E d \in CartReadback(cur, TRUE) : cw' = [cw EXCEPT ![cur].st = Settle(reply, d)]
  /\ Idle
  /\ UNCHANGED <<plat, cb, sourced, cart, bought, fw, unpaidFc, cancelledPrep>>

PlanFc ==
  /\ pc = "idle"
  /\ Len(fw) < MaxW
  /\ PlanFcOk
  /\ fw' = Append(fw, [st |-> "pending", did |-> FALSE])
  /\ pc' = "forecast prepare"
  /\ cur' = Len(fw) + 1
  /\ UNCHANGED <<plat, cb, sourced, cart, bought, cw, reply, unpaidFc, cancelledPrep>>

\* 预报的 prepare：chanboss 上还是待出货、待处理才做
FcPrepare ==
  /\ pc = "forecast prepare"
  /\ IF plat = "open" /\ cb = "todo"
     THEN /\ fw' = [fw EXCEPT ![cur].st = "submitted"]
          /\ pc' = "forecast submit"
          /\ UNCHANGED <<cur, reply>>
     ELSE /\ fw' = [fw EXCEPT ![cur].st = "skipped"]
          /\ Idle
  /\ UNCHANGED <<plat, cb, sourced, cart, bought, cw, unpaidFc, cancelledPrep>>

FcSubmit ==
  /\ pc = "forecast submit"
  /\ \/ /\ fw' = [fw EXCEPT ![cur].st = "refused"]
        /\ Idle
        /\ UNCHANGED <<cb, unpaidFc>>
     \/ /\ fw' = [fw EXCEPT ![cur].did = TRUE]
        /\ cb' = "forecast"
        /\ unpaidFc' = (unpaidFc \/ bought = 0)
        /\ reply' \in {"done", "unknown"}
        /\ pc' = "forecast check"
        /\ UNCHANGED cur
     \/ /\ reply' \in {"done", "unknown"}
        /\ pc' = "forecast check"
        /\ UNCHANGED <<fw, cb, cur, unpaidFc>>
  /\ UNCHANGED <<plat, sourced, cart, bought, cw, cancelledPrep>>

FcCheck ==
  /\ pc = "forecast check"
  /\ \E d \in FcReadback(cur, TRUE) : fw' = [fw EXCEPT ![cur].st = Settle(reply, d)]
  /\ Idle
  /\ UNCHANGED <<plat, cb, sourced, cart, bought, cw, unpaidFc, cancelledPrep>>

\* 进程退出：待执行的下一个 x2 清成未执行，已提交的留着等核清
Crash ==
  /\ pc # "idle"
  /\ cw' = IF pc = "cart prepare" THEN [cw EXCEPT ![cur].st = "skipped"] ELSE cw
  /\ fw' = IF pc = "forecast prepare" THEN [fw EXCEPT ![cur].st = "skipped"] ELSE fw
  /\ Idle
  /\ UNCHANGED <<plat, cb, sourced, cart, bought, unpaidFc, cancelledPrep>>

\* x2 verify：已提交、结果未知的读回来
VerifyCart(i) ==
  /\ pc = "idle"
  /\ cw[i].st \in {"submitted", "unknown"}
  /\ \E d \in CartReadback(i, FALSE) : cw' = [cw EXCEPT ![i].st = IF d = "yes" THEN "verified" ELSE "unknown"]
  /\ UNCHANGED <<plat, cb, sourced, cart, bought, fw, pc, cur, reply, unpaidFc, cancelledPrep>>

VerifyFc(i) ==
  /\ pc = "idle"
  /\ fw[i].st \in {"submitted", "unknown"}
  /\ \E d \in FcReadback(i, FALSE) : fw' = [fw EXCEPT ![i].st = IF d = "yes" THEN "verified" ELSE "unknown"]
  /\ UNCHANGED <<plat, cb, sourced, cart, bought, cw, pc, cur, reply, unpaidFc, cancelledPrep>>

ResolveCarts == \E i \in DOMAIN cw : ResolveCart(i)
ResolveFcs == \E i \in DOMAIN fw : ResolveFc(i)
VerifyCarts == \E i \in DOMAIN cw : VerifyCart(i)
VerifyFcs == \E i \in DOMAIN fw : VerifyFc(i)

Settled == plat \in {"cancelled", "shipped"} /\ pc = "idle" /\ UNCHANGED vars

Next ==
  \/ ChooseSource \/ Pay \/ RemoveFromCart \/ Cancel \/ ChanbossReceive \/ ChanbossPack
  \/ ResolveCarts \/ ResolveFcs
  \/ PlanCart \/ CartPrepare \/ CartSubmit \/ CartCheck
  \/ PlanFc \/ FcPrepare \/ FcSubmit \/ FcCheck
  \/ VerifyCarts \/ VerifyFcs \/ Crash
  \/ Settled

Spec == Init /\ [][Next]_vars

NoDoubleBuy == cart + bought <= 1

ForecastOnlyPaid == ~unpaidFc

NoCartForCancelled == ~cancelledPrep

NoShopeeForecast == OrderSource # "shopee" \/ Len(fw) = 0
====
