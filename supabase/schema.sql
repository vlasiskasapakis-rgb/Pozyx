-- Pozyx + phone tap database for Supabase.
-- Run once: Supabase dashboard → SQL Editor → New query → paste this file → Run.
-- All times are Unix milliseconds (unix_ms) from the device clocks; `time` columns
-- show the same moment as a timestamp for reading and joining.

-- One row per recording made with pozyx_live_map.html
create table if not exists recordings (
  id                 text primary key,              -- e.g. pozyx_2026-10-25_16-03-12
  started_at_unix_ms bigint not null,
  started_at         timestamptz generated always as (to_timestamp(started_at_unix_ms / 1000.0)) stored,
  duration_s         double precision,
  uploaded_at        timestamptz not null default now()
);

-- Anchor positions used during a recording (meters)
create table if not exists anchors (
  recording_id text not null references recordings (id) on delete cascade,
  anchor_id    text not null,
  x double precision, y double precision, z double precision,
  primary key (recording_id, anchor_id)
);

-- Tag positions (meters). x, y along the floor, z up; origin = floor below anchor A1.
create table if not exists positions (
  recording_id text not null references recordings (id) on delete cascade,
  tag          text not null,
  unix_ms      bigint not null,
  time         timestamptz generated always as (to_timestamp(unix_ms / 1000.0)) stored,
  t            double precision,                    -- seconds since Record was pressed
  x double precision, y double precision, z double precision,
  primary key (recording_id, tag, unix_ms)
);
create index if not exists positions_unix_ms on positions (unix_ms);

-- Button taps from sync_marker.html on the phone
create table if not exists taps (
  id           text primary key,                    -- made on the phone, so retries never duplicate
  session_id   text not null,
  session_name text,
  unix_ms      bigint not null,
  time         timestamptz generated always as (to_timestamp(unix_ms / 1000.0)) stored,
  label        text not null default '',
  uploaded_at  timestamptz not null default now()
);
create index if not exists taps_unix_ms on taps (unix_ms);

-- Access: the pages use the public (anon/publishable) key, so these policies let anyone
-- who has that key read and add data. Fine for a personal project; don't store secrets here.
alter table recordings enable row level security;
alter table anchors    enable row level security;
alter table positions  enable row level security;
alter table taps       enable row level security;

drop policy if exists "pages read"   on recordings;
drop policy if exists "pages add"    on recordings;
drop policy if exists "pages update" on recordings;
create policy "pages read"   on recordings for select to anon using (true);
create policy "pages add"    on recordings for insert to anon with check (true);
create policy "pages update" on recordings for update to anon using (true) with check (true);

drop policy if exists "pages read"   on anchors;
drop policy if exists "pages add"    on anchors;
drop policy if exists "pages update" on anchors;
create policy "pages read"   on anchors for select to anon using (true);
create policy "pages add"    on anchors for insert to anon with check (true);
create policy "pages update" on anchors for update to anon using (true) with check (true);

drop policy if exists "pages read"   on positions;
drop policy if exists "pages add"    on positions;
drop policy if exists "pages update" on positions;
create policy "pages read"   on positions for select to anon using (true);
create policy "pages add"    on positions for insert to anon with check (true);
create policy "pages update" on positions for update to anon using (true) with check (true);

drop policy if exists "pages read"   on taps;
drop policy if exists "pages add"    on taps;
drop policy if exists "pages update" on taps;
drop policy if exists "pages undo"   on taps;
create policy "pages read"   on taps for select to anon using (true);
create policy "pages add"    on taps for insert to anon with check (true);
create policy "pages update" on taps for update to anon using (true) with check (true);
create policy "pages undo"   on taps for delete to anon using (true);  -- the Undo button
