-- Pozyx + phone tap database for Supabase.
-- Run once (running it again is safe; it also updates a database made with an older version): Supabase dashboard → SQL Editor → New query → paste this file → Run.
-- All times are Unix milliseconds (unix_ms) from the device clocks; `time` columns
-- show the same moment as a timestamp for reading and joining.

-- Sessions: created in pozyx_live_map.html, picked on the phone in sync_marker.html.
-- Recordings and taps carry the session id, so you know which belong together.
create table if not exists sessions (
  id                 text primary key,              -- e.g. session_2026-10-25_16-03-12
  name               text not null,
  created_at_unix_ms bigint not null,
  created_at         timestamptz generated always as (to_timestamp(created_at_unix_ms / 1000.0)) stored
);

-- One row per recording made with pozyx_live_map.html
create table if not exists recordings (
  id                 text primary key,              -- e.g. pozyx_2026-10-25_16-03-12
  started_at_unix_ms bigint not null,
  started_at         timestamptz generated always as (to_timestamp(started_at_unix_ms / 1000.0)) stored,
  duration_s         double precision,
  uploaded_at        timestamptz not null default now()
);
alter table recordings add column if not exists session_id text references sessions (id) on delete set null;
create index if not exists recordings_session on recordings (session_id);

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
  session_id   text,                                -- the session picked on the phone (empty = none)
  session_name text,
  unix_ms      bigint not null,
  time         timestamptz generated always as (to_timestamp(unix_ms / 1000.0)) stored,
  label        text not null default '',
  uploaded_at  timestamptz not null default now()
);
create index if not exists taps_unix_ms on taps (unix_ms);
alter table taps alter column session_id drop not null;   -- for databases made with the first version
create index if not exists taps_session on taps (session_id);

-- Access: the pages use the public (anon/publishable) key, so these policies let anyone
-- who has that key read and add data. Fine for a personal project; don't store secrets here.
alter table sessions   enable row level security;
alter table recordings enable row level security;
alter table anchors    enable row level security;
alter table positions  enable row level security;
alter table taps       enable row level security;

drop policy if exists "pages read"   on sessions;
drop policy if exists "pages add"    on sessions;
drop policy if exists "pages update" on sessions;
create policy "pages read"   on sessions for select to anon using (true);
create policy "pages add"    on sessions for insert to anon with check (true);
create policy "pages update" on sessions for update to anon using (true) with check (true);

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

-- Shared clock: both pages measure how far their own clock is from this server's clock
-- and save every time corrected to it, so phone and laptop line up even if their clocks differ.
create or replace function server_time_ms() returns double precision
  language sql volatile as $$ select extract(epoch from clock_timestamp()) * 1000 $$;
grant execute on function server_time_ms() to anon;
alter table taps       add column if not exists clock_offset_ms double precision;  -- correction applied (ms)
alter table recordings add column if not exists clock_offset_ms double precision;

-- Deleting from the live map (Saved sessions → Delete). Deleting a recording also deletes its
-- positions and anchors (on delete cascade above).
drop policy if exists "pages delete" on sessions;
drop policy if exists "pages delete" on recordings;
create policy "pages delete" on sessions   for delete to anon using (true);
create policy "pages delete" on recordings for delete to anon using (true);

-- ===================== AR (ar_editor.html and ar_viewer.html) =====================

-- Images the phone camera recognises (printed posters). The image file is in storage bucket "ar".
create table if not exists ar_targets (
  id                 text primary key,
  name               text not null,
  image_path         text not null,                 -- path inside the "ar" bucket
  width_px           integer not null,
  height_px          integer not null,
  created_at_unix_ms bigint not null
);

-- What appears on top of each image. Positions: x, y from the image's top-left (0..1 of width/height);
-- z = height above the image and size = width, both as a fraction of the image width.
create table if not exists ar_overlays (
  id         text primary key,
  target_id  text not null references ar_targets (id) on delete cascade,
  kind       text not null check (kind in ('text', 'image', 'model')),
  x double precision not null default 0.5,
  y double precision not null default 0.5,
  z double precision not null default 0,
  size       double precision not null default 0.3,
  rot_x double precision not null default 0,       -- degrees
  rot_y double precision not null default 0,
  rot_z double precision not null default 0,
  text       text,                                  -- kind = text
  color      text default '#ffffff',
  background text default '#000000aa',
  asset_path text,                                  -- kind = image or model: file in the "ar" bucket
  asset_name text,
  updated_at_unix_ms bigint
);
create index if not exists ar_overlays_target on ar_overlays (target_id);

-- The recognition file the phone downloads, made by "Publish to phone" in the editor.
-- target_ids lists the targets in the order they are inside the file.
create table if not exists ar_published (
  id                   text primary key,            -- always 'current'
  mind_path            text not null,
  target_ids           text[] not null,
  published_at_unix_ms bigint not null
);

-- Looks recorded by the phone: which image was in the centre of the screen, and for how long.
create table if not exists looks (
  id              text primary key,
  session_id      text,
  session_name    text,
  target_id       text,
  target_name     text,
  start_unix_ms   bigint not null,
  end_unix_ms     bigint not null,
  duration_ms     bigint generated always as (end_unix_ms - start_unix_ms) stored,
  start_time      timestamptz generated always as (to_timestamp(start_unix_ms / 1000.0)) stored,
  clock_offset_ms double precision,
  uploaded_at     timestamptz not null default now()
);
create index if not exists looks_start on looks (start_unix_ms);
create index if not exists looks_session on looks (session_id);

alter table ar_targets   enable row level security;
alter table ar_overlays  enable row level security;
alter table ar_published enable row level security;
alter table looks        enable row level security;

do $$
declare t text;
begin
  foreach t in array array['ar_targets', 'ar_overlays', 'ar_published', 'looks'] loop
    execute format('drop policy if exists "pages read" on %I', t);
    execute format('drop policy if exists "pages add" on %I', t);
    execute format('drop policy if exists "pages update" on %I', t);
    execute format('drop policy if exists "pages delete" on %I', t);
    execute format('create policy "pages read" on %I for select to anon using (true)', t);
    execute format('create policy "pages add" on %I for insert to anon with check (true)', t);
    execute format('create policy "pages update" on %I for update to anon using (true) with check (true)', t);
    execute format('create policy "pages delete" on %I for delete to anon using (true)', t);
  end loop;
end $$;

-- File storage for images, 3D models and the recognition file. Public to read.
insert into storage.buckets (id, name, public) values ('ar', 'ar', true)
on conflict (id) do update set public = true;

drop policy if exists "ar read"   on storage.objects;
drop policy if exists "ar add"    on storage.objects;
drop policy if exists "ar update" on storage.objects;
drop policy if exists "ar delete" on storage.objects;
create policy "ar read"   on storage.objects for select to anon using (bucket_id = 'ar');
create policy "ar add"    on storage.objects for insert to anon with check (bucket_id = 'ar');
create policy "ar update" on storage.objects for update to anon using (bucket_id = 'ar') with check (bucket_id = 'ar');
create policy "ar delete" on storage.objects for delete to anon using (bucket_id = 'ar');

-- Content modes: every image has a Generic and an AI assisted set of items; the phone picks one.
alter table ar_overlays add column if not exists mode text not null default 'generic';
alter table ar_overlays drop constraint if exists ar_overlays_mode_check;
alter table ar_overlays add constraint ar_overlays_mode_check check (mode in ('generic', 'ai'));
alter table looks add column if not exists mode text;   -- the mode the phone showed during the look

-- What each phone is pointing at right now (one row per phone), for the live map.
create table if not exists ar_live (
  device_id          text primary key,
  session_id         text,
  session_name       text,
  target_id          text,                          -- empty when not looking at an image
  target_name        text,
  mode               text,
  since_unix_ms      bigint,                        -- when the current look started
  updated_at_unix_ms bigint not null
);
alter table ar_live enable row level security;
drop policy if exists "pages read"   on ar_live;
drop policy if exists "pages add"    on ar_live;
drop policy if exists "pages update" on ar_live;
create policy "pages read"   on ar_live for select to anon using (true);
create policy "pages add"    on ar_live for insert to anon with check (true);
create policy "pages update" on ar_live for update to anon using (true) with check (true);

-- Audio and video items (played when the visitor taps them on the phone)
alter table ar_overlays drop constraint if exists ar_overlays_kind_check;
alter table ar_overlays add constraint ar_overlays_kind_check check (kind in ('text', 'image', 'model', 'audio', 'video'));
alter table ar_overlays add column if not exists loop_play boolean not null default false;   -- start again at the end

-- Marker quality of each image (score, parts, tips and feature points), measured by the AR editor
alter table ar_targets add column if not exists quality jsonb;

-- 3D model of the real space for the live map's Room view, and how it lines up with the
-- Pozyx coordinates (meters, degrees). One row, id 'current'. The file is in storage bucket "ar".
create table if not exists room_model (
  id                 text primary key,
  model_path         text,
  model_name         text,
  offset_x           double precision not null default 0,
  offset_y           double precision not null default 0,
  offset_z           double precision not null default 0,
  rotation_deg       double precision not null default 0,
  scale              double precision not null default 1,
  updated_at_unix_ms bigint
);
alter table room_model enable row level security;
drop policy if exists "pages read"   on room_model;
drop policy if exists "pages add"    on room_model;
drop policy if exists "pages update" on room_model;
create policy "pages read"   on room_model for select to anon using (true);
create policy "pages add"    on room_model for insert to anon with check (true);
create policy "pages update" on room_model for update to anon using (true) with check (true);

-- Room model as FBX with separate texture files (model_files: texture file name -> storage path)
alter table room_model add column if not exists model_type  text not null default 'glb';
alter table room_model add column if not exists model_files jsonb;
alter table room_model add column if not exists z_up        boolean;   -- empty = detect when loading

-- Phone orientation from the AR viewer (about 5 per second while the camera runs): where the back
-- camera points. heading = compass bearing (0 = north, 90 = east), pitch = up (+) / down (-),
-- roll = sideways tilt, all in degrees; times on the server clock like the positions.
create table if not exists phone_pose (
  id           text primary key,
  device_id    text,
  session_id   text,
  unix_ms      bigint not null,
  heading      real,
  pitch        real,
  roll         real
);
create index if not exists phone_pose_time on phone_pose (unix_ms);
alter table phone_pose enable row level security;
drop policy if exists "pages read"   on phone_pose;
drop policy if exists "pages add"    on phone_pose;
drop policy if exists "pages update" on phone_pose;
drop policy if exists "pages delete" on phone_pose;
create policy "pages read"   on phone_pose for select to anon using (true);
create policy "pages add"    on phone_pose for insert to anon with check (true);
create policy "pages update" on phone_pose for update to anon using (true) with check (true);
create policy "pages delete" on phone_pose for delete to anon using (true);

-- The phone's direction right now, for the live map
alter table ar_live add column if not exists heading real;
alter table ar_live add column if not exists pitch   real;

-- Compass bearing of the room's x axis (from A1 towards A2), to turn compass headings into room
-- directions; set in the live map with "Phone points along A1 -> A2 now"
alter table room_model add column if not exists x_axis_heading real;

-- Real size of each painting as it hangs (meters), entered in the AR editor (Painting sizes);
-- the AR viewer uses the width to show how far the phone is from the painting
alter table ar_targets add column if not exists width_m  real;
alter table ar_targets add column if not exists height_m real;

-- Distance from the phone to the painting during each look (AR viewer, from MindAR and the painting's
-- width): average, closest and farthest in meters, and the average viewing angle (0 = straight on).
-- Empty for looks of paintings without a size, and for looks saved before these columns existed.
alter table looks add column if not exists distance_avg_m real;
alter table looks add column if not exists distance_min_m real;
alter table looks add column if not exists distance_max_m real;
alter table looks add column if not exists view_angle_deg real;

-- Make the API notice new tables and columns straight away
notify pgrst, 'reload schema';
