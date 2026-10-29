-- 订单的表：订单设置、货源、到货问题、订单（给团队看的进度）。
-- 每个进程第一次用库时跑一遍（平台的先跑，再按注册的先后跑每个 skill 的 schema.sql）：只建没有的表、加没有的列，所以每一句都要能重复跑。
-- 表建好以后再加列：不改 create table，在最后「加列」一节写 alter table … add column if not exists（已有的库里 create table 不会再跑）。
-- 表名、列名用英文（网页上显示中文，见各自的 tables.ts）；给人看的值（类别、状态）用中文。
--
-- 只存三类：站点上没有的（人的决定、设置）；给团队在网页上看的（订单的进度）。
-- 站点上有的（购物车、采购单、1688 商品详情、店里的商品、登录着的账号）不存：每次 x2 status 经浏览器现读。

-- ── 设置 ──

-- 订单设置：只有一行
create table if not exists order_settings (
	id int primary key default 1 check (id = 1),
	-- 采购账号（1688 会员名）：只有一个账号做采购，x2 只往它加购，别的 1688 账号只读。换账号改这一格
	buy_account text,
	-- 离出货期限不到几天、还没打包，x2 status 就提醒人
	late_days int not null default 6,
	-- 未发货提醒：1688 付款后多少小时还没发货，x2 status 就提醒人
	ship_wait_hours int not null default 48,
	-- 发货线路：海快（chanboss 的 sendway_id 752）。line_id、warehouse_id 是 chanboss 上这条线路的线路和仓库（2026-10-09 读已预报的订单：1111、5176）
	channel text not null default '海快',
	sendway_id int not null default 752,
	line_id int not null default 1111,
	warehouse_id int not null default 5176
);
insert into order_settings (id) values (1) on conflict do nothing;

-- ── 人的决定 ──

-- 货源：一行是「店里一个商品 × 一个货源」。一个商品只用一个货源（chosen：选用，一个商品最多一行）；没 chosen 的是还在挑的。
-- 规格不存对应：加购时按店里的规格名，在货源的规格里配。
-- 货源的样子（标题、图、规格和价格）存一份快照：下架了还知道原来买的是什么，好比价、好在网页上看图挑。x2 每次现读这个货源就更新快照；买之前一律现读，不信快照
create table if not exists sources (
	item_id text not null,
	-- 货源在哪个站、站上的 id：现在都是 1688
	site text not null default '1688',
	offer_id text not null,
	-- 店里的商品（给人看）
	item_name text,
	item_image text,
	-- 快照：链接、标题、图、规格 [{ skuId, specId, name, price, stock, image }]、什么时候读的
	url text,
	title text,
	image text,
	skus jsonb not null default '[]',
	read_at timestamptz,
	-- 相似度：店里卖过的规格有几成在这个货源里对得上；missing 是未匹配的规格
	score numeric,
	missing text,
	-- 来源：以图搜图、人工添加、原有
	origin text,
	-- 明显匹配：x2 认为明显对得上（卖过的规格都对得上，而且只有它对得上），人同意加购时一起定下，不用人另外选
	sure boolean not null default false,
	chosen boolean not null default false,
	-- 不可用：选用的货源下架时 x2 现读发现，写原因；检查当成缺货源
	broken text,
	found_at timestamptz not null default now(),
	chosen_at timestamptz,
	primary key (item_id, offer_id)
);
create unique index if not exists sources_chosen on sources (item_id) where chosen;

-- 到货问题：错货、少件、损坏。x2 看不到，人在网页的表单里上报（订单号、商品和规格、问题类型、件数），处理完勾「已处理」。
-- 未处理的：订单停在「有到货问题」，不提醒打包；x2 status 一个问题提醒一行
create table if not exists arrival_issues (
	id bigserial primary key,
	sn text not null,
	item text,
	kind text not null default '损坏',
	qty int,
	note text,
	-- 处理方式：退换、重新采购、无需处理
	resolution text,
	done boolean not null default false,
	reported_at timestamptz not null default now(),
	done_at timestamptz
);

-- ── 给团队看的 ──

-- 订单：每次 x2 status 现读 chanboss 的订单列表（两家店都在）以后整份重写，加上检查算出来的列。给不在开着浏览器的那台电脑前的人看进度（待出货看板），不当真相用
create table if not exists orders (
	sn text primary key,
	shop text,
	shop_id text,
	created_at timestamptz,
	ship_by timestamptz,
	platform_status text,
	chanboss_status text,
	-- chanboss 上这张订单的 id、下单时间（秒）：预报要带
	chanboss_id text,
	chanboss_time bigint,
	-- 商品：[{ itemId, modelId, chanbossModelId, name, spec, qty, image }]
	items jsonb not null default '[]',
	items_text text,
	-- chanboss 标的问题（没有是 null）
	problem text,
	cancelled_at timestamptz,
	-- 检查算出来的
	days_left numeric,
	destination text,
	step text,
	step_detail text,
	checked_at timestamptz
);

-- ── 加列（表建好以后加的列写在这里） ──

-- 规格例外：店里的规格按名字在货源的规格里配不上时，人定的。一行一个「店里的规格名 = 货源的规格名」（单规格写「（单规格）」）；
-- 只记例外，配得上的不记。人在网页上写，或者人在终端里说了、agent 用 x2 orders spec 写。换了货源就跟着那一行删掉
alter table sources add column if not exists sku_exceptions text;
-- 到货问题的类型默认「损坏」
alter table arrival_issues alter column kind set default '损坏';
-- 批准去掉了
alter table order_settings drop column if exists forecast_needs_approval;
