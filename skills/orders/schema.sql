-- 订单的表：订单设置、货源、到货问题、订单（给团队看的进度）。
-- 每个进程第一次用库时跑一遍（平台的先跑，再按注册的先后跑每个 skill 的 schema.sql）：只建没有的表、加没有的列，所以每一句都要能重复跑。
-- 表建好以后再加列：不改 create table，在最后「加列」一节写 alter table … add column if not exists（已有的库里 create table 不会再跑）。
-- 表名、列名用英文（网页上显示中文，见各自的 tables.ts）；给人看的值（类别、状态）用中文。
--
-- 只存三类：站点上没有的（人的决定、设置）；给团队在网页上看的（订单的进度）。
-- 站点上有的（购物车、采购单、1688 商品详情、店里的商品、登录着的账号）不存：每次 x2 status 经浏览器现读。
create table if not exists order_settings (
	id int primary key default 1 check (id = 1),
	buy_account text,
	late_days int not null default 6,
	ship_wait_hours int not null default 48,
	-- 发货线路：海快（chanboss 的 sendway_id 752）。line_id、warehouse_id 是 chanboss 上这条线路的线路和仓库（2026-10-09 读已预报的订单：1111、5176）
	channel text not null default '海快',
	sendway_id int not null default 752,
	line_id int not null default 1111,
	warehouse_id int not null default 5176
);
insert into order_settings (id) values (1) on conflict do nothing;

create table if not exists sources (
	item_id text not null,
	site text not null default '1688',
	offer_id text not null,
	item_name text,
	item_image text,
	url text,
	title text,
	image text,
	skus jsonb not null default '[]',
	read_at timestamptz,
	score numeric,
	missing text,
	origin text,
	sure boolean not null default false,
	chosen boolean not null default false,
	broken text,
	found_at timestamptz not null default now(),
	chosen_at timestamptz,
	primary key (item_id, offer_id)
);
create unique index if not exists sources_chosen on sources (item_id) where chosen;

create table if not exists arrival_issues (
	id bigserial primary key,
	sn text not null,
	item text,
	kind text not null default '损坏',
	qty int,
	note text,
	resolution text,
	done boolean not null default false,
	reported_at timestamptz not null default now(),
	done_at timestamptz
);

create table if not exists orders (
	sn text primary key,
	shop text,
	shop_id text,
	created_at timestamptz,
	ship_by timestamptz,
	platform_status text,
	chanboss_status text,
	chanboss_id text,
	chanboss_time bigint,
	items jsonb not null default '[]',
	items_text text,
	problem text,
	cancelled_at timestamptz,
	days_left numeric,
	destination text,
	step text,
	step_detail text,
	checked_at timestamptz
);

alter table sources add column if not exists sku_exceptions text;
alter table arrival_issues alter column kind set default '损坏';
alter table order_settings drop column if exists forecast_needs_approval;
