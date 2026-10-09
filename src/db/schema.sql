-- 库的结构。x2 每个进程第一次用库时跑一遍：只建没有的表、加没有的列，所以每一句都要能重复跑。
-- 表建好以后再加列：不改 create table，在最后「加列」一节写 alter table … add column if not exists（已有的库里 create table 不会再跑）。
-- 表名、列名用英文（NocoDB 里显示中文）；给人看的值（类别、状态）用中文，NocoDB 里直接能读。
-- 三类表：人填的设置和决定；同步来的镜像（人只看，下一轮会覆盖）；收件箱、写入和同步（x2 写，人勾、写备注）。见 docs/loop.md「表」

-- ── 设置和决定（人在 NocoDB 里填） ──

-- 一家店。shop_id 是平台店铺 id（订单上的 shop_id）；account 是账号名，用它叫这家店
create table if not exists shops (
	shop_id text primary key,
	account text unique,
	name text,
	user_id text,
	-- 登录着这家店的浏览器（cdp-relay 里的 id）：x2 按店找浏览器时写
	browser text,
	enabled boolean not null default true,
	-- 店铺参数（核价用，第三阶段）
	target_margin numeric,
	min_profit numeric,
	fx_rate numeric,
	forwarder_per_kg numeric,
	weight_step numeric,
	order_fee numeric,
	platform_fee_rate numeric,
	risk_reserve numeric,
	watermark boolean not null default false,
	watermark_text text
);

-- 订单设置：只有一行
create table if not exists order_settings (
	id int primary key default 1 check (id = 1),
	-- 发货线路：海快（chanboss 的 sendway_id 752）。line_id、warehouse_id 是 chanboss 上这条线路的线路和仓库（2026-10-09 读已预报的订单：1111、5176）
	channel text not null default '海快',
	sendway_id int not null default 752,
	line_id int not null default 1111,
	warehouse_id int not null default 5176,
	-- chanboss 的收货地址：采购单的收货地址里有这一段的，算寄到 chanboss
	chanboss_address text,
	forecast_needs_approval boolean not null default true,
	-- 离出货期限不到几天、还没打包，就进收件箱给人（2026-10-09 定的 6 天）
	late_days int not null default 6
);
insert into order_settings (id) values (1) on conflict do nothing;

-- 货源候选：选货源时 x2 找到的一个「货源 + 1688 规格」。x2 写，人勾「用这个」；勾了下一轮写进规格
create table if not exists source_options (
	model_id text not null,
	offer_id text not null,
	offer_sku_id text not null,
	-- 店里的规格（给人比着看）
	sku_name text,
	sku_image text,
	-- 1688 这边
	offer_title text,
	name text,
	image text,
	price numeric,
	stock int,
	-- 像不像：分数越高越像；missing 是店里的规格名里有、它没有的数字或颜色
	score numeric,
	missing text,
	-- 从哪来：这个商品用过的、以图搜图、人贴的链接
	origin text,
	-- x2 认为明显对得上（数字、颜色都对上，而且只有它对上）：随加购一起批准，不进收件箱
	sure boolean not null default false,
	chosen boolean not null default false,
	found_at timestamptz not null default now(),
	primary key (model_id, offer_id, offer_sku_id)
);

-- ── 镜像（同步来的，人只看） ──

-- 订单：用 chanboss 的订单列表（两家店都在）。订单号就是 Shopee 的订单号
create table if not exists orders (
	sn text primary key,
	shop_id text,
	shop text,
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
	synced_at timestamptz,
	-- 检查算出来的
	days_left numeric,
	sourced boolean,
	carted boolean,
	paid boolean,
	arrived boolean,
	destination text,
	step text,
	checked_at timestamptz
);

-- 规格：店里的一个规格。offer_id、offer_sku_id 是人定的（选货源以后写，同步不改）
create table if not exists skus (
	model_id text primary key,
	shop_id text,
	item_id text,
	item_name text,
	name text,
	image text,
	price numeric,
	stock int,
	status text,
	offer_id text,
	offer_sku_id text,
	sourced_at timestamptz,
	synced_at timestamptz
);

-- 货源：1688 上的一个商品。skus 是 1688 规格：[{ skuId, specId, name, attrs, price, stock, image }]
create table if not exists offers (
	offer_id text primary key,
	url text,
	title text,
	image text,
	unit text,
	min_qty int,
	props jsonb,
	skus jsonb not null default '[]',
	live boolean not null default true,
	read_at timestamptz
);

-- 1688 购物车的一行。account 是 1688 账号的 userId
create table if not exists cart (
	account text not null,
	offer_id text not null,
	offer_sku_id text not null,
	qty int not null,
	-- 检查算出来的：属于哪几张订单（按加购的写入）、该不该买
	orders text,
	should_buy text,
	synced_at timestamptz,
	primary key (account, offer_id, offer_sku_id)
);

-- 1688 采购单的一行（一个采购单号的一个规格）
create table if not exists purchases (
	order_id text not null,
	line int not null,
	account text not null,
	offer_id text,
	spec_id text,
	offer_sku_id text,
	qty int,
	price numeric,
	-- 整张采购单的实付
	paid numeric,
	status text,
	status_label text,
	created_at timestamptz,
	paid_at timestamptz,
	address text,
	to_chanboss boolean,
	tracking_no text,
	shipped_at timestamptz,
	logistics text,
	signed boolean,
	raw jsonb,
	synced_at timestamptz,
	primary key (order_id, line)
);

-- ── 收件箱、写入和同步（x2 写，人勾、写备注） ──

-- 收件箱：一件要人做的事。key 是「类别:对象」，每轮重算，只更新不重复；条件不成立就关。人只改 approve、snooze_until、note
create table if not exists inbox (
	key text primary key,
	kind text not null,
	title text not null,
	detail text,
	shop text,
	due timestamptz,
	link text,
	approve boolean,
	open boolean not null default true,
	snooze_until timestamptz,
	note text,
	opened_at timestamptz not null default now(),
	closed_at timestamptz,
	updated_at timestamptz not null default now()
);

create sequence if not exists batch_seq;

-- 写入：做了一次写操作。先记意图（已提交），再提交一次，再读回来
-- status：待批准、已批准、已提交、成功、被拒、结果未知、已核对、不一致、没做
create table if not exists writes (
	id bigserial primary key,
	batch bigint not null,
	op text not null,
	target text not null,
	params jsonb not null,
	display text,
	-- 防重复：同一个 key 已有成功、结果未知……的写入，不再提交
	key text not null,
	-- 人在批准前取消勾：这一项不做
	include boolean not null default true,
	status text not null default '待批准',
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

-- 同步：一样要同步的东西。max_minutes 是目标多新（分钟，人在 NocoDB 里能改）；result 是上次的结果：成功、部分、失败
create table if not exists syncs (
	name text not null,
	scope text not null default '',
	max_minutes int not null,
	last_at timestamptz,
	last_ok_at timestamptz,
	result text,
	error text,
	-- 上次失败是要人处理（没登录、浏览器没连上）
	blocked boolean not null default false,
	rows int,
	host text,
	primary key (name, scope)
);

-- ── 加列（表建好以后加的列写在这里） ──

-- 2026-10-09：syncs.max_age（interval，NocoDB 显示成 [object Object]）换成 max_minutes（分钟）
do $$ begin
	if exists (select 1 from information_schema.columns where table_name = 'syncs' and column_name = 'max_age') then
		alter table syncs add column if not exists max_minutes int;
		update syncs set max_minutes = extract(epoch from max_age)::int / 60;
		alter table syncs alter column max_minutes set not null;
		alter table syncs drop column max_age;
	end if;
end $$;

-- 2026-10-09：采购账号。只有一个账号做采购：x2 只往它加购，别的 1688 账号只读（换账号改这一格）。存 1688 的 userId，会员名在 accounts_1688
alter table order_settings add column if not exists buy_account text;

-- 2026-10-09：见过的 1688 账号：userId → 会员名（给人看）。x2 按账号找浏览器时写
create table if not exists accounts_1688 (
	user_id text primary key,
	login_id text,
	seen_at timestamptz
);

-- 2026-10-09：收件箱的「谁做」和「处理好了」。
-- 谁做：哪一类归谁写在 inbox_roles（人改），x2 每轮照它填；以后分人，在 NocoDB 里按「谁做」各建一个视图。
-- 处理好了：x2 看不到结果的事（取消的货退回卖家、上架台湾仓、合并发货……），人做完勾上，这一行关掉，以后不再开
alter table inbox add column if not exists role text;
alter table inbox add column if not exists done boolean not null default false;
create table if not exists inbox_roles (
	kind text primary key,
	role text not null
);
insert into inbox_roles (kind, role)
select k, '运营' from unnest(array['付款', '批准', '打包', '快到期', '取消', '问题单', '选货源', '登录', '结果未知', '设置']) as k
on conflict do nothing;

-- 2026-10-09：订单的「卡在哪一步」只放固定的几步（看板按它分列），细节（还差哪件……）放 step_detail
alter table orders add column if not exists step_detail text;
