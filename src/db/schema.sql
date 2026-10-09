-- 库的结构。x2 每个进程第一次用库时跑一遍：只建没有的表、加没有的列，所以每一句都要能重复跑。
-- 表建好以后再加列：不改 create table，在最后「加列」一节写 alter table … add column if not exists（已有的库里 create table 不会再跑）。
-- 表名、列名用英文（NocoDB 里显示中文）；给人看的值（类别、状态）用中文，NocoDB 里直接能读。
--
-- 只存三类（docs/loop.md「怎样工作」）：站点上没有的（人的决定、设置）；写入的记录；给团队在 NocoDB 里看的（订单的进度）。
-- 站点上有的（购物车、采购单、1688 商品详情、店里的商品、登录着的账号）不存：每次 x2 status 经浏览器现读。

-- ── 设置 ──

-- 订单设置：只有一行
create table if not exists order_settings (
	id int primary key default 1 check (id = 1),
	-- 采购账号（1688 会员名）：只有一个账号做采购，x2 只往它加购，别的 1688 账号只读。换账号改这一格
	buy_account text,
	-- 离出货期限不到几天、还没打包，就进收件箱给人
	late_days int not null default 6,
	-- 1688 付了款多久（小时）还没发货算异常
	ship_wait_hours int not null default 48,
	forecast_needs_approval boolean not null default true,
	-- 发货线路：海快（chanboss 的 sendway_id 752）。line_id、warehouse_id 是 chanboss 上这条线路的线路和仓库（2026-10-09 读已预报的订单：1111、5176）
	channel text not null default '海快',
	sendway_id int not null default 752,
	line_id int not null default 1111,
	warehouse_id int not null default 5176
);
insert into order_settings (id) values (1) on conflict do nothing;

-- ── 人的决定 ──

-- 货源：一行是「店里一个商品 × 一个货源」。一个商品只用一个货源（chosen：用这个，一个商品最多一行）；没 chosen 的是还在挑的。
-- 规格不存对应：加购时按店里的规格名，在货源的规格里配。
-- 货源的样子（标题、图、规格和价格）存一份快照：下架了还知道原来买的是什么，好比价、好在 NocoDB 里看图挑。x2 每次现读这个货源就更新快照；买之前一律现读，不信快照
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
	-- 像不像：店里卖过的规格有几成在这个货源里对得上；missing 是对不上的规格
	score numeric,
	missing text,
	-- 从哪来：以图搜图、人贴的链接、以前定的
	origin text,
	-- x2 认为明显对得上（卖过的规格都对得上，而且只有它对得上）：随加购一起批准，不进收件箱
	sure boolean not null default false,
	chosen boolean not null default false,
	-- 用这个的货源用不了了（下架了）：x2 现读发现时写原因，检查当成没货源
	broken text,
	found_at timestamptz not null default now(),
	chosen_at timestamptz,
	primary key (item_id, offer_id)
);
create unique index if not exists sources_chosen on sources (item_id) where chosen;

-- 到货问题：错货、少件、坏了。x2 看不到，人在 NocoDB 的表单里报（订单号、哪件、什么问题、几件），处理完勾「处理好了」。
-- 没处理好的：订单卡在「到货有问题」，不提醒打包；收件箱一行一个问题
create table if not exists arrival_issues (
	id bigserial primary key,
	sn text not null,
	item text,
	kind text not null default '坏了',
	qty int,
	note text,
	-- 怎么处理：退换、重新买、不用管
	resolution text,
	done boolean not null default false,
	reported_at timestamptz not null default now(),
	done_at timestamptz
);

-- ── 收件箱和写入 ──

-- 收件箱：一件要人做的事。key 是「类别:对象」，每轮重算，只更新不重复；条件不成立就关。
-- 人只改 approve（批准）、done（处理好了：x2 看不到结果的事，勾了就关、不再开）、snooze_until、note。role 是谁做（现在都是运营）
create table if not exists inbox (
	key text primary key,
	kind text not null,
	title text not null,
	detail text,
	role text not null default '运营',
	shop text,
	due timestamptz,
	link text,
	approve boolean,
	done boolean not null default false,
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
