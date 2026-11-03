-- 采购记录按账号与原始订单号保存；成功批次原子发布，历史事实与失败进度分开保留。
create table if not exists reimbursement_accounts (
 account_id text primary key,
 name text not null,
 last_success_at timestamptz,
 revision text,
 created_at timestamptz not null default now()
);
create table if not exists reimbursement_runs (
 id text primary key,
 account_id text,
 status text not null,
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 page int not null default 0,
 pages int,
 observed int not null default 0,
 total int,
 paid_count int,
 unknown_count int,
 backend_pid int,
 error text
);
create index if not exists reimbursement_runs_account on reimbursement_runs(account_id, started_at desc);
create table if not exists reimbursement_orders (
 account_id text not null references reimbursement_accounts(account_id),
 order_id text not null,
 fact jsonb not null,
 paid_at timestamptz,
 captured_at timestamptz not null,
 revision text not null references reimbursement_runs(id),
 primary key(account_id, order_id)
);
create table if not exists reimbursement_order_history (
 run_id text not null references reimbursement_runs(id),
 account_id text not null,
 order_id text not null,
 fact jsonb not null,
 captured_at timestamptz not null,
 primary key(run_id, account_id, order_id)
);
-- 本地人工报帐标记与网站事实分开，刷新采购记录不覆盖人工选择。
create table if not exists reimbursement_marks (
 account_id text not null,
 order_id text not null,
 reported boolean not null,
 revision int not null check (revision > 0),
 updated_at timestamptz not null default now(),
 primary key(account_id, order_id),
 foreign key(account_id, order_id) references reimbursement_orders(account_id, order_id)
);
