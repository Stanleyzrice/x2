create table if not exists store_monitor_snapshots (
    shop text primary key,
    snapshot jsonb not null
);
