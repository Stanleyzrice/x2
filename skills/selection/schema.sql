-- 选品的表：策略、策略的变更记录、选品规矩（商品稿的 strategy、选品快照照它们记）。
-- 每个进程第一次用库时跑一遍（平台的先跑，再按注册的先后跑每个 skill 的 schema.sql）：只建没有的表、加没有的列，所以每一句都要能重复跑。
-- 表建好以后再加列：不改 create table，在最后「加列」一节写 alter table … add column if not exists（已有的库里 create table 不会再跑）。
-- 表名、列名用英文（网页上显示中文，见各自的 tables.ts）；给人看的值（类别、状态）用中文。

-- 策略：选品的一个做法。agent 定、做实验（explore / exploit）；商品稿的 strategy 写它的名字
create table if not exists strategies (
	name text primary key,
	-- 假设：押的是什么
	bet text,
	-- 选品方法：看什么数据、什么条件、去哪找货源
	how text,
	status text not null default '试验中' check (status in ('试验中', '使用中', '已停用')),
	note text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
-- 状态的约束：先去掉，把旧取值（在用、停了）换成现在的，再加回来
alter table strategies drop constraint if exists strategies_status_check;
update strategies set status = case status when '在用' then '使用中' else '已停用' end where status in ('在用', '停了');
alter table strategies add constraint strategies_status_check check (status in ('试验中', '使用中', '已停用'));
insert into strategies (name, bet, how, status) values ('人选', '人挑的货源', '运营贴链接', '使用中') on conflict do nothing;
-- ── 加列（表建好以后加的列写在这里） ──

-- 策略的版本号：x2 selection strategy-add 是第 1 版，每次 strategy-set 加 1（加版本号之前记的策略都算第 1 版）
alter table strategies add column if not exists version int not null default 1;

-- 策略的变更记录：一行是一个策略的一版。改之前、改之后只写改了的列（{ status, bet, how, note }），第 1 版没有改之前
create table if not exists strategy_changes (
	id bigserial primary key,
	strategy text not null,
	version int not null,
	before jsonb,
	after jsonb not null,
	why text,
	changed_at timestamptz not null default now(),
	unique (strategy, version)
);

-- 选品规矩：所有策略共用的（例 1688 一件代发、48 小时发货、起订量 1）。旧的不删，停用时写结束时间和停用原因
create table if not exists selection_rules (
	id bigserial primary key,
	rule text not null,
	why text not null,
	started_at timestamptz not null default now(),
	ended_at timestamptz,
	retire_why text
);
