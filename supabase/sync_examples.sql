-- Examples for lining up phone taps with Pozyx positions.
-- Run in Supabase → SQL Editor. Change the tag id ('6A77') to yours.

-- 0. Everything in one session: its recordings and its taps (change the session name)
select 'recording' as kind, r.id, r.started_at as time, null as label
from recordings r join sessions s on s.id = r.session_id
where s.name = 'Jump test 1'
union all
select 'tap', t.id, t.time, t.label
from taps t join sessions s on s.id = t.session_id
where s.name = 'Jump test 1'
order by time;

-- 1. All taps, newest first
select session_name, label, time, unix_ms
from taps
order by unix_ms desc;

-- 2. For every tap: the tag position from the same session measured closest in time, and how far apart (ms)
select t.session_name, t.label, t.time as tap_time,
       p.recording_id, p.time as position_time, p.unix_ms - t.unix_ms as gap_ms,
       p.x, p.y, p.z
from taps t
cross join lateral (
  select p.* from positions p
  join recordings r on r.id = p.recording_id and r.session_id is not distinct from t.session_id
  where p.tag = '6A77'
    and p.unix_ms between t.unix_ms - 2000 and t.unix_ms + 2000
  order by abs(p.unix_ms - t.unix_ms)
  limit 1
) p
order by t.unix_ms;

-- 3. Positions from 1 s before to 3 s after each tap labelled 'jump'
select t.time as tap_time, (p.unix_ms - t.unix_ms) / 1000.0 as seconds_from_tap, p.x, p.y, p.z
from taps t
join positions p
  on p.tag = '6A77' and p.unix_ms between t.unix_ms - 1000 and t.unix_ms + 3000
where t.label = 'jump'
order by t.unix_ms, p.unix_ms;

-- 4. Which recording was running when each tap happened
select t.label, t.time as tap_time, r.id as recording
from taps t
left join recordings r
  on t.unix_ms between r.started_at_unix_ms and r.started_at_unix_ms + r.duration_s * 1000
order by t.unix_ms;
