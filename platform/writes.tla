---- MODULE writes ----
\* 写入引擎（platform/writes.ts）的 TLA+ 模型：一条写入从交进来到有结果，进程在任何一步都可能退出，
\* 站点可能做成了却没回话、说做了其实没做，人到站点上看过以后 x2 resolve。检查的规则（INVARIANT、PROPERTY）：
\*   OnePerKey        同一个 key（含 #n）在站点上最多提交一次
\*   NoRedoUnsettled  同一个业务 key 再提交（#n）时，前面提交过的都已核对或被拒
\*   TargetClear      同一个对象上有没核清的写入（已提交、结果未知、不一致）时不提交新的
\*   RecordsTrue      被拒的站点上没做，已核对的做了，未执行的没提交过
\*   PendingEnds      进程退出留下的待执行，之后有 x2 跑（verify 或写工具）就会清掉
\* 怎么跑（要 Java、TLC，不进 CI）：用 pstack 的 statechart（skills/statechart/scripts/statechart，第一次跑用 mise 装 TLC 和 Java），在仓库根目录：
\*   statechart platform/writes.tla --config platform/writes.cfg --out <临时目录>          一个进程，最多三条写入
\*   statechart platform/writes.tla --config platform/writes-2.cfg --out <临时目录>        两个进程（哪台电脑上都一样，锁在共用的库里）
\*   statechart platform/writes.tla --config platform/writes-drop.cfg --out <临时目录>     拿锁的连接在记意图以后、提交以前断了：已知破，见那份 cfg
\*   statechart platform/writes.tla --config platform/writes-chart.cfg --view platform/writes-view.mjs --out <临时目录>
\*     一条写入的状态图，out 里的 chart.mmd 换进 platform/writes.mmd
\* 改了 writes.ts 的状态、判断、哪一步先哪一步后，这里跟着改再跑。
\* 模型的状态名对照：pending 待执行，submitted 已提交，unknown 结果未知，mismatch 不一致，verified 已核对，refused 被拒，skipped 未执行。
\* 写入锁（exclusive）：交、核清、执行、resolve 都拿着库里的一把锁，同一时间只有一个进程碰写入；进程退出、连接断了（Drop）锁就放。
\* 没放进模型的：读回来说错（Lag = TRUE 时读回来可能看不到已经做成的）、站点上被人改、业务工具 prepare 的判断（当成可能不做）。
\* tried 的首次试跑门槛只决定进入 prepare 或跳过，抽象为 Prepare 的可选 skipped；本模型不证明业务的历史授权口径。
\* 多目标试跑在进入模型前拒绝；单次连接器提交额度对应 Submit 的至多一次转移。
\* replay 只读取已有状态，不新增 rows、不 submit，按 stuttering 处理；requestId 内容绑定由 Chat 工具的隔离测试验证。
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Procs, MaxRows, Lag, Drop

VARIABLES rows, pc, mine, unsure, todo, hb, ht, blocked, cur, reply, nextBatch, resent, crowded, holder

vars == <<rows, pc, mine, unsure, todo, hb, ht, blocked, cur, reply, nextBatch, resent, crowded, holder>>

Proposals == {<<"a">>, <<"b">>, <<"a", "b">>}
Target(k) == "t"

Ids == 1 .. Len(rows)
Min(S) == CHOOSE x \in S : \A y \in S : x <= y
Key(i) == <<rows[i].lk, rows[i].n>>
Tgt(i) == Target(rows[i].lk)
St(i) == rows[i].st

InFlight == {"pending", "submitted", "unknown", "mismatch"}
Unsettled == {"submitted", "unknown", "mismatch"}
Done == {"verified"}
Stuck == {"unknown", "mismatch"}
Look == {"unknown", "mismatch"}

SetSt(i, s) == rows' = [rows EXCEPT ![i].st = s]

\* 读回来：做了的读得到或看不出；没做的，刚提交完读得出没做，过后再读只当看不出（引擎把 false 也当看不出）
Readback(i, fresh) ==
  IF rows[i].did THEN (IF Lag THEN {"yes", "unclear", "no"} ELSE {"yes", "unclear"})
  ELSE (IF fresh THEN {"no", "unclear"} ELSE {"unclear"})

\* settle()
Settle(r, d) ==
  IF d = "yes" THEN "verified"
  ELSE IF d = "no" THEN (IF r = "done" THEN "mismatch" ELSE "refused")
  ELSE "unknown"

Clear(p) ==
  /\ pc' = [pc EXCEPT ![p] = "idle"]
  /\ mine' = [mine EXCEPT ![p] = {}]
  /\ unsure' = [unsure EXCEPT ![p] = {}]
  /\ todo' = [todo EXCEPT ![p] = {}]
  /\ hb' = [hb EXCEPT ![p] = {}]
  /\ ht' = [ht EXCEPT ![p] = {}]
  /\ blocked' = [blocked EXCEPT ![p] = FALSE]
  /\ cur' = [cur EXCEPT ![p] = 0]
  /\ reply' = [reply EXCEPT ![p] = "none"]
  /\ holder' = IF holder = p THEN "none" ELSE holder

Init ==
  /\ rows = <<>>
  /\ pc = [p \in Procs |-> "idle"]
  /\ mine = [p \in Procs |-> {}]
  /\ unsure = [p \in Procs |-> {}]
  /\ todo = [p \in Procs |-> {}]
  /\ hb = [p \in Procs |-> {}]
  /\ ht = [p \in Procs |-> {}]
  /\ blocked = [p \in Procs |-> FALSE]
  /\ cur = [p \in Procs |-> 0]
  /\ reply = [p \in Procs |-> "none"]
  /\ nextBatch = 1
  /\ resent = {}
  /\ crowded = {}
  /\ holder = "none"

\* perform：拿写入锁，addWrites 读同一个业务 key 的写入，admit，插一批待执行；有没核清的整批不收
Propose(p, ks) ==
  /\ pc[p] = "idle"
  /\ holder = "none"
  /\ holder' = p
  /\ Len(rows) + Len(ks) <= MaxRows
  /\ LET same(k) == {i \in Ids : rows[i].lk = k} IN
     /\ ~\E j \in 1 .. Len(ks) : \E i \in same(ks[j]) : St(i) \in InFlight
     /\ rows' = rows \o [j \in 1 .. Len(ks) |->
          [lk |-> ks[j], n |-> Cardinality(same(ks[j])) + 1, batch |-> nextBatch,
           st |-> "pending", sends |-> 0, did |-> FALSE, by |-> p]]
  /\ mine' = [mine EXCEPT ![p] = (Len(rows) + 1) .. (Len(rows) + Len(ks))]
  /\ nextBatch' = nextBatch + 1
  /\ pc' = [pc EXCEPT ![p] = "verify0"]
  /\ UNCHANGED <<unsure, todo, hb, ht, blocked, cur, reply, resent, crowded>>

\* x2 verify：run 不带批
Verify(p) ==
  /\ pc[p] = "idle"
  /\ holder = "none"
  /\ holder' = p
  /\ pc' = [pc EXCEPT ![p] = "verify0"]
  /\ UNCHANGED <<rows, mine, unsure, todo, hb, ht, blocked, cur, reply, nextBatch, resent, crowded>>

\* execute 开头（拿着锁）：别的批的待执行是退出了的进程留下的，清掉；已提交、结果未知的都读回来
VerifyStart(p) ==
  /\ pc[p] = "verify0"
  /\ holder = p
  /\ rows' = [i \in Ids |-> IF St(i) = "pending" /\ i \notin mine[p] THEN [rows[i] EXCEPT !.st = "skipped"] ELSE rows[i]]
  /\ unsure' = [unsure EXCEPT ![p] = {i \in Ids : St(i) \in {"submitted", "unknown"}}]
  /\ pc' = [pc EXCEPT ![p] = "verify"]
  /\ UNCHANGED <<mine, todo, hb, ht, blocked, cur, reply, nextBatch, resent, crowded, holder>>

\* 一条一条读回来
VerifyOne(p) ==
  /\ pc[p] = "verify"
  /\ unsure[p] # {}
  /\ LET i == Min(unsure[p])
         rest == [unsure EXCEPT ![p] = @ \ {i}]
     IN \/ /\ holder = p
           /\ "yes" \in Readback(i, FALSE)
           /\ SetSt(i, "verified")
           /\ unsure' = rest
           /\ UNCHANGED <<hb, ht, blocked>>
        \/ /\ holder = p
           /\ SetSt(i, "unknown")
           /\ unsure' = rest
           /\ hb' = [hb EXCEPT ![p] = @ \cup {rows[i].batch}]
           /\ ht' = [ht EXCEPT ![p] = @ \cup {Tgt(i)}]
           /\ UNCHANGED blocked
        \/ /\ blocked' = [blocked EXCEPT ![p] = TRUE]
           /\ unsure' = [unsure EXCEPT ![p] = {}]
           /\ UNCHANGED <<rows, hb, ht>>
  /\ UNCHANGED <<pc, mine, todo, cur, reply, nextBatch, resent, crowded, holder>>

VerifyEnd(p) ==
  /\ pc[p] = "verify"
  /\ unsure[p] = {}
  /\ todo' = [todo EXCEPT ![p] = {i \in mine[p] : St(i) = "pending"}]
  /\ pc' = [pc EXCEPT ![p] = "gate"]
  /\ UNCHANGED <<rows, mine, unsure, hb, ht, blocked, cur, reply, nextBatch, resent, crowded, holder>>

\* gate()：要人处理的、这一轮停下的批和对象不做
Gate(p) ==
  /\ pc[p] = "gate"
  /\ todo[p] # {}
  /\ LET i == Min(todo[p]) IN
     IF blocked[p] \/ rows[i].batch \in hb[p] \/ Tgt(i) \in ht[p]
     THEN /\ holder = p
          /\ SetSt(i, "skipped")
          /\ todo' = [todo EXCEPT ![p] = @ \ {i}]
          /\ UNCHANGED <<pc, cur>>
     ELSE /\ cur' = [cur EXCEPT ![p] = i]
          /\ pc' = [pc EXCEPT ![p] = "prepare"]
          /\ UNCHANGED <<rows, todo>>
  /\ UNCHANGED <<mine, unsure, hb, ht, blocked, reply, nextBatch, resent, crowded, holder>>

Next1(p) ==
  /\ todo' = [todo EXCEPT ![p] = @ \ {cur[p]}]
  /\ pc' = [pc EXCEPT ![p] = "gate"]

\* prepare 现读站点（业务可能不做、可能要人登录），看同一个对象、同一个 key（held），fence 看锁还在，再记意图
Prepare(p) ==
  /\ pc[p] = "prepare"
  /\ LET i == cur[p]
         held == \E j \in Ids : /\ j # i
                                /\ \/ (Tgt(j) = Tgt(i) \/ Key(j) = Key(i)) /\ St(j) \in Unsettled
                                   \/ Key(j) = Key(i) /\ St(j) \in Done
     IN \/ /\ holder = p
           /\ SetSt(i, "skipped")
           /\ Next1(p)
           /\ UNCHANGED blocked
        \/ /\ holder = p
           /\ SetSt(i, "skipped")
           /\ Next1(p)
           /\ blocked' = [blocked EXCEPT ![p] = TRUE]
        \/ /\ held /\ holder = p
           /\ SetSt(i, "skipped")
           /\ Next1(p)
           /\ UNCHANGED blocked
        \/ /\ ~held /\ holder = p
           /\ SetSt(i, "submitted")
           /\ pc' = [pc EXCEPT ![p] = "submit"]
           /\ UNCHANGED <<todo, blocked>>
  /\ UNCHANGED <<mine, unsure, hb, ht, cur, reply, nextBatch, resent, crowded, holder>>

\* 提交那一刻记下有没有破规则
Sent(i) ==
  /\ resent' = IF \E j \in Ids : j # i /\ rows[j].lk = rows[i].lk /\ rows[j].sends > 0 /\ St(j) \notin {"refused", "verified"}
               THEN resent \cup {i} ELSE resent
  /\ crowded' = IF \E j \in Ids : j # i /\ Tgt(j) = Tgt(i) /\ St(j) \in Unsettled
                THEN crowded \cup {i} ELSE crowded

\* 连接器的写只发一次：要人处理（没发）、被拒、做了、说做了其实没做、没回话（做了或没做）。记被拒时锁没了：发出去了，记不上，停下（lost）
Submit(p) ==
  /\ pc[p] = "submit"
  /\ LET i == cur[p] IN
     \/ /\ holder = p
        /\ SetSt(i, "skipped")
        /\ blocked' = [blocked EXCEPT ![p] = TRUE]
        /\ Next1(p)
        /\ UNCHANGED <<reply, resent, crowded>>
     \/ /\ holder = p
        /\ rows' = [rows EXCEPT ![i].sends = @ + 1, ![i].st = "refused"]
        /\ Sent(i)
        /\ Next1(p)
        /\ UNCHANGED <<blocked, reply>>
     \/ /\ holder # p
        /\ rows' = [rows EXCEPT ![i].sends = @ + 1]
        /\ Sent(i)
        /\ pc' = [pc EXCEPT ![p] = "lost"]
        /\ UNCHANGED <<todo, blocked, reply>>
     \/ /\ \E r \in {[did |-> TRUE, said |-> "done"], [did |-> FALSE, said |-> "done"],
                     [did |-> TRUE, said |-> "unknown"], [did |-> FALSE, said |-> "unknown"]} :
             /\ rows' = [rows EXCEPT ![i].sends = @ + 1, ![i].did = @ \/ r.did]
             /\ reply' = [reply EXCEPT ![p] = r.said]
        /\ Sent(i)
        /\ pc' = [pc EXCEPT ![p] = "check"]
        /\ UNCHANGED <<todo, blocked>>
  /\ UNCHANGED <<mine, unsure, hb, ht, cur, nextBatch, holder>>

Check(p) ==
  /\ pc[p] = "check"
  /\ holder = p
  /\ LET i == cur[p] IN
     \E d \in Readback(i, TRUE) :
       LET s == Settle(reply[p], d) IN
       /\ SetSt(i, s)
       /\ IF s \in Stuck
          THEN /\ hb' = [hb EXCEPT ![p] = @ \cup {rows[i].batch}]
               /\ ht' = [ht EXCEPT ![p] = @ \cup {Tgt(i)}]
          ELSE UNCHANGED <<hb, ht>>
       /\ IF s = "verified"
          THEN /\ pc' = [pc EXCEPT ![p] = "after"]
               /\ UNCHANGED todo
          ELSE Next1(p)
  /\ UNCHANGED <<mine, unsure, blocked, cur, reply, nextBatch, resent, crowded, holder>>

\* 写操作的 after（更新库）做成了也好、出错也好，状态不改（failed）
After(p) ==
  /\ pc[p] = "after"
  /\ Next1(p)
  /\ UNCHANGED <<rows, mine, unsure, hb, ht, blocked, cur, reply, nextBatch, resent, crowded, holder>>

Finish(p) ==
  /\ pc[p] = "gate"
  /\ todo[p] = {}
  /\ Clear(p)
  /\ UNCHANGED <<rows, nextBatch, resent, crowded>>

Crash(p) ==
  /\ pc[p] # "idle"
  /\ Clear(p)
  /\ UNCHANGED <<rows, nextBatch, resent, crowded>>

\* 拿锁的连接断了：锁放了，进程不知道，接着往下走；改写入的每一步都带着「锁还在」（holds），锁没了改不了、停下，只能退出
LoseLock(p) ==
  /\ Drop
  /\ holder = p
  /\ holder' = "none"
  /\ UNCHANGED <<rows, pc, mine, unsure, todo, hb, ht, blocked, cur, reply, nextBatch, resent, crowded>>

\* x2 resolve：人到站点上看过（只收结果未知、不一致），拿着锁改（一步里拿、改、放）
Resolve(i) ==
  /\ holder = "none"
  /\ St(i) \in Look
  /\ SetSt(i, IF rows[i].did THEN "verified" ELSE "refused")
  /\ UNCHANGED <<pc, mine, unsure, todo, hb, ht, blocked, cur, reply, nextBatch, resent, crowded, holder>>

Human == \E i \in Ids : Resolve(i)

Run(p) ==
  \/ VerifyStart(p) \/ VerifyOne(p) \/ VerifyEnd(p) \/ Gate(p)
  \/ Prepare(p) \/ Submit(p) \/ Check(p) \/ After(p) \/ Finish(p)

Next ==
  \/ \E p \in Procs :
       \/ \E ks \in Proposals : Propose(p, ks)
       \/ Verify(p) \/ Run(p) \/ Crash(p) \/ LoseLock(p)
  \/ Human

\* 公平：开着的进程会往下走（一直退出也会有一次走到），闲着的进程会有一次跑 x2 verify
Fairness == \A p \in Procs : SF_vars(Run(p)) /\ WF_vars(Verify(p))

Spec == Init /\ [][Next]_vars /\ Fairness

OnePerKey ==
  \A i \in Ids :
    /\ rows[i].sends <= 1
    /\ \A j \in Ids : (i # j /\ Key(i) = Key(j)) => (rows[i].sends = 0 \/ rows[j].sends = 0)

NoRedoUnsettled == resent = {}

TargetClear == crowded = {}

RecordsTrue ==
  \A i \in Ids :
    /\ St(i) = "refused" => ~rows[i].did
    /\ St(i) = "verified" => rows[i].did
    /\ St(i) = "skipped" => rows[i].sends = 0

PendingEnds ==
  \A i \in 1 .. MaxRows : [](i \in Ids /\ rows[i].st = "pending" => <>(i \in Ids /\ rows[i].st # "pending"))
====
