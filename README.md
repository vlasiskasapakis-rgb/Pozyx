# Pozyx positioning with real timestamps

Tracks Pozyx tags in 3D, records their positions with real date and time,
and logs event markers from a phone so everything can be synced later with
other apps.

| File | What it is |
| --- | --- |
| `pozyx_auto_positioning/pozyx_auto_positioning.ino` | Arduino sketch: measures the anchors, works out their positions, then streams tag positions over USB. |
| `pozyx_live_map.html` | Web page for the laptop: live 3D/top view, recording, replay, and export to CSV/JSON with real timestamps. |
| `sync_marker.html` | Phone page: tap a big button to log the exact time of an event. |
| `ar_editor.html` | Laptop page: upload poster images and place text, images and 3D models on them. |
| `ar_viewer.html` | Phone page: shows those overlays on the posters through the camera (AR) and records which poster you look at, and for how long. |
| `ar_scene.js` | Shared code that builds the AR overlays (used by the editor preview and the viewer). |

## 1. Arduino sketch

1. Install the Pozyx Arduino library.
2. Place 3 or 4 anchors around the room, powered on. A1, A2 and A3 must not be in a straight line.
3. In the sketch, fill in the anchor IDs (in order A1–A4), their heights in mm, and the tag IDs.
4. Upload. Press the red reset button to calibrate again whenever an anchor moves.

Coordinates: (0,0,0) is the floor below anchor A1, x points from A1 to A2,
A3 is on the positive y side, z is height. Units are mm on the Arduino and
meters in saved files. In Unity use (x, z, y).

Serial lines (115200 baud):

```
ANCHOR,<id>,<x>,<y>,<z>        anchor position (mm)
POS,<tag>,<x>,<y>,<z>,<ms>     tag position (mm) + Arduino time of the measurement
ERR,<tag>,<ms>                 failed measurement
CLOCK,<ms>                     Arduino time, used to link it to the laptop clock
```

`<ms>` is milliseconds since the Arduino started (it has no real clock).

## 2. Live map (laptop)

Open `pozyx_live_map.html` in Chrome or Edge (close the Arduino IDE Serial
Monitor first) and click **Connect Arduino**. **Demo** shows made-up data
without hardware.

Click **Record**, then **Stop**, then **Save CSV** or **Save JSON**. The page
uses the `CLOCK` lines to convert every position to the laptop's real clock,
correcting for USB delay and for the Arduino clock running slightly fast or
slow.

```
t,type,id,x,y,z,unix_ms,time
0,anchor,6A67,0,0,0.7,,
0.154,tag,6A77,1.52,0.83,1.21,1792935108195,2026-10-25T16:31:48.195+02:00
```

- `unix_ms`: real time of the measurement, milliseconds since 1970-01-01 UTC. Use this to sync.
- `time`: the same moment as local date and time.
- `t`: seconds since Record was pressed (used for replay).

**Open recording** replays a saved CSV or JSON file.

## 3. Sync marker (phone)

Open `sync_marker.html` on the phone and press **Tap** at the moment
something happens (start of a test, a jump, a drop). The time is taken from
the touch itself. An optional label is saved with each tap.

```
n,unix_ms,time,label
1,1792935802517,2026-10-25T16:03:22.517+02:00,start
```

The hosted copy on claude.ai also backs taps up to the account and has
**Save CSV**. Opened as a plain file, taps stay on the phone; use
**Copy CSV** to get them out.

## 4. Database (Supabase)

Both pages save to a Supabase database set in `pozyx_db.js`.

1. Once: Supabase → **SQL Editor** → paste `supabase/schema.sql` → **Run**.
   Run it again after updates; it is safe to repeat.
2. Laptop: in the live map, click **New session** and give it a name.
3. Phone: tap **Refresh**, pick the same session, then tap during the test.
4. Laptop: **Record** / **Stop**. The recording uploads to the selected session
   (or click **Upload** to retry).

5. Later: **Saved sessions** → pick the session and a recording → **Replay**.
   The phone taps made during that recording appear as markers on the
   timeline, in a "Phone taps" list (click one to jump there), as a flash
   while playing, and as diamonds on the map where the tag was at each tap.

6. To clean up: in **Saved sessions**, **Delete** removes one recording;
   **Delete session** removes the session with all its recordings,
   positions and phone taps. Both ask first and cannot be undone.

Tables: `sessions`, `recordings`, `anchors`, `positions`, `taps`. Taps and
recordings carry the `session_id`; positions belong to a recording. See
`supabase/sync_examples.sql` for queries that line taps up with positions.

### Shared clock

Phone and laptop clocks can differ by seconds. Both pages measure their own
clock against the Supabase server (function `server_time_ms` in the schema)
and save every time corrected to it, so taps and positions line up. Each page
shows the measured difference. For recordings made before this, use
**Tap shift** in the replay to move the taps by hand.

## 5. AR posters

Needs the updated `supabase/schema.sql` (tables `ar_targets`, `ar_overlays`,
`ar_published`, `looks`, and the storage bucket `ar`).

**Editor (laptop)**: `ar_editor.html`
1. **Upload images**: the posters as printed. Recognition works best with
   detailed, high-contrast pictures (photos, illustrations), not plain shapes
   or mostly text.
   Each image is checked as a marker after upload: a score (0-100, Excellent
   to Unusable) from its feature points (detail, tracking, spread over the
   image, and what is left from far away), with tips to improve it.
   **Show feature points** draws the points and tints areas without detail.
2. Pick an image and a mode: **Generic** or **AI assisted**. Each mode has
   its own items; **Copy items from …** copies the other mode's items as a
   starting point.
   Then **Add text**, **Add image**, **Add 3D model** (`.glb`, or a `.gltf`
   with everything embedded), **Add audio** or **Add video** (MP4 or WebM).
   Audio shows as a round play button with an optional label, video as a
   screen; both have a player in the panel to check them, and a Loop option. Drag items into place and
   use the panel on the right for size, height above the poster and rotation.
   The 3D preview shows how it will look on the phone. Changes save by themselves.
3. **Publish to phone** after adding, removing or replacing posters (not
   needed after only moving or editing items).

**Viewer (phone)**: `ar_viewer.html`
1. Pick the session at the top (**Refresh** loads new ones) and the content
   mode (**Generic** or **AI assisted**; it can be switched any time), then
   **Start camera**.
2. Tap an audio button or a video to play it. A player bar appears with
   Play/Pause, Stop and a timeline; only one plays at a time, and switching
   mode or leaving the page pauses it.
3. Point the circle in the middle of the screen at a poster. While it stays
   on a poster, that counts as a look; glances under 0.3 s are ignored.
4. Each look is saved with start, end, length and mode, on the server clock,
   under the chosen session. Switching mode during a look ends it and starts a
   new one, so every look has one mode.

**Seeing what visitors see (live map)**
- Live: the "Visitor is viewing" box shows the poster the phone points at right
  now, drawn with the items of the mode it shows (Generic or AI assisted), how
  long, and the session. The phone reports this to the `ar_live` table on every
  change and every 5 s; the live map checks it every second.
- Replay: the same box shows what was being viewed at each moment. Look bars
  and the Looks list are coloured by mode (orange Generic, purple AI assisted). Replays in the live map show looks as bars under the
   timeline and in a "Looks" list.

## Syncing tips

- Both files use the same `unix_ms`, so rows can be matched directly.
- Each device stamps with its own clock. Keep automatic time on for the phone
  and the laptop. On Windows, click Settings → Time & language → Date & time →
  **Sync now** before a session.
- To measure any remaining offset, tap the phone button at the instant you
  drop the tag on the floor. The impact shows as a sharp change in z; the gap
  between it and the tap is the clock offset.
