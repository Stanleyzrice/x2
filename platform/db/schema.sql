-- 平台的表：写入、已处理、会话。
-- 每个进程第一次用库时跑一遍（平台的先跑，再按注册的先后跑每个 skill 的 schema.sql）：只建没有的表、加没有的列，所以每一句都要能重复跑。
-- 表建好以后再加列：不改 create table，在最后「加列」一节写 alter table … add column if not exists（已有的库里 create table 不会再跑）。
-- 表名、列名用英文（网页上显示中文，见各自的 tables.ts）；给人看的值（类别、状态）用中文。

-- ── 已处理和写入 ──

-- 已处理：x2 status 提醒人做的事里，x2 看不到结果的（例 取消的订单货在 chanboss，给了新订单还是退回卖家），人做完记一行，不再提醒（x2 handled）
create table if not exists handled (
	key text primary key,
	note text,
	at timestamptz not null default now()
);

create sequence if not exists batch_seq;

-- 写入：做了一次写操作。人在终端里同意了，agent 调写工具交一批（待执行），x2 先记意图（已提交），再提交一次，再读回来
-- status：待执行、已提交、成功、被拒、结果未知、已核对、不一致、未执行
create table if not exists writes (
	id bigserial primary key,
	batch bigint not null,
	op text not null,
	target text not null,
	params jsonb not null,
	display text,
	-- 防重复：同一个 key 已有成功、结果未知……的写入，不再提交
	key text not null,
	status text not null default '待执行',
	response jsonb,
	readback jsonb,
	error text,
	host text,
	created_at timestamptz not null default now(),
	started_at timestamptz,
	finished_at timestamptz,
	cost numeric
);
create index if not exists writes_key on writes (key);
create index if not exists writes_batch on writes (batch);

-- 收件箱、批准去掉了：人在终端里跟 agent 说同意，agent 调写工具直接做
drop table if exists inbox;
alter table writes alter column status set default '待执行';
update writes set status = '未执行', error = coalesce(error, '没有批准就没执行：批准的流程去掉了'), finished_at = coalesce(finished_at, now()) where status in ('待批准', '已批准');
alter table writes drop column if exists include;

-- ── 会话（网页，platform/web/sessions.ts） ──

-- 会话：agent 开的（x2 session create），网页的侧栏列出来
create table if not exists sessions (
	id bigserial primary key,
	title text not null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
-- 会话里的组件：component 是 platform/web/sessions.ts 的 COMPONENTS 里的名字，props 照它校验过。interactive 的 props 是引用（例 一张表的视图），不是数据
create table if not exists session_items (
	id bigserial primary key,
	session_id bigint not null references sessions (id) on delete cascade,
	component text not null,
	props jsonb not null,
	created_at timestamptz not null default now()
);
create index if not exists session_items_session on session_items (session_id);
