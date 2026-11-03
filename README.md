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
| `unity/PozyxReplay.cs` | Unity script: replays an exported session and turns looked-at images green (see `unity/README.md`). |
| `room_view.js` | The live map's Room view: the real space as a 3D model with the visitor as a figure. |
| `ar_scene.js` | Shared code that builds the AR overlays (used by the editor preview and the viewer). |

## 1. Arduino sketch

1. Install the Pozyx Arduino library.
2. Place 3 or more anchors around the room, powered on. A1, A2 and A3 must not be in a straight line.
3. In the sketch, fill in `num_anchors`, the anchor IDs (in order A1, A2, ...), their heights in mm, and the tag IDs.
   With anchors at about the same height the sketch uses 2.5D (x, y at a fixed
   `tag_height`); 3D needs 4+ anchors at clearly different heights.
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

6. **Export JSON** (next to a recording, or in the replay bar) downloads the
   recording for Unity: positions at a fixed height (**Height in export**,
   default 1 m), anchors, looks and taps. See `unity/README.md`.
7. To clean up: in **Saved sessions**, **Delete** removes one recording;
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

## 6. Room view (3D model of the space)

The side panels fold away: click a panel's title (Room model, Tags, Anchors,
…) to close or open it, and the Room model's sections (Plan anchors, Compass,
Line up) open and close on their own. The page remembers this on each
computer. **Visitor is viewing** sits at the top of the side column.

In the live map, **Room view** shows your space as a 3D model (GLB, in meters)
with the visitor as a 1.7 m figure walking in it, the trail, the anchors and
phone taps; live and in replays. Needs the updated `supabase/schema.sql`
(table `room_model`).

1. **Upload GLB…** (stored in Supabase; loaded automatically afterwards).
   Up to 50 MB on the free plan; Draco and meshopt compressed GLBs work.
   Or **Upload FBX folder…**: pick the folder with the `.fbx` and its texture
   files (JPG, PNG, TGA, BMP; TIFF cannot be shown in browsers). The textures
   keep their file names, which the FBX refers to and which can light up.
   FBX units (often cm) are converted to meters; a Z-up model is stood
   upright automatically (the **Upright: Z-up** box changes it).
2. Line it up: **Align with A1 and A2…**, then click the floor directly below
   anchor A1 in the model, then below A2. Fine-tune with Move x / up / z, Turn
   and Scale (1 = the model is in meters). The page reports the A1–A2 distance
   in the model and as measured, to check the result.
   **Mirror → Flipped**: when you walk to one side of the room and the model
   shows you on the other side, tick it. The model flips over the A1 – A2
   line, and A1 and A2 stay where they are. This happens when anchor A3 is to
   the right of A1 → A2 (seen from above): Pozyx's own calibration cannot tell
   left from right. It is saved with the alignment (as a negative scale).
   **Detail** (High / Balanced / Light, saved per computer): Balanced and
   Light draw at normal sharpness and shrink textures to 2048 / 1024 px for
   laptops. The view only redraws when something changes, and objects that
   share a material are joined (the panel shows "N parts drawn as M").
3. Looked-at images light up: while the visitor looks at an AR image (live or
   in a replay), the parts of the model whose texture, material or object name
   contains the image's name as a whole part glow green ("MIRO_A2" matches
   `MIRO_A2.jpg`, `MIRO_A2.001`, `MIRO_A2_baseColor`, `Mat_MIRO_A2`, but not
   `MIRO_A20`; case, extensions and spaces/dashes do not matter). The Room
   model panel lists which AR images were found, and "Names in the model"
   shows the model's texture and material names to compare.
4. **Plan anchors (before installing)**: tick **Show anchor plan and
   coverage**. The page first reads the rooms of the model: spaces closed off
   by walls (and the wall above a door) at 2.2 m become Room 1, Room 2, …
   (biggest first). Lower partitions and display cases do not split a room;
   the outside of the building and spaces smaller than 3 m² are left out. Each
   room's floor is tinted in its own colour with its name on it.
   Choose the room to plan in the **Room** list (it shows the size), by
   clicking a room's name in the model, or with **Pick in model** and a click
   on its floor. ↻ reads the rooms again (after moving the model).
   The chosen room shows the proposed anchors (orange markers with their
   height) and its floor coloured by how many anchors a phone held at 1.3 m
   can see in a straight line: green 4 or more (good 3D), yellow 3 (2.5D only),
   red 2 or fewer. Walls, partitions and display cases in the model block the
   line, so the colours show where tracking will be weak.
   **Suggest layout** puts four anchors in the room's corners (square to its
   walls, also for turned or L-shaped rooms), alternating 2.7 m and 1.0 m (the
   height difference is what gives Pozyx its height reading without the
   ceiling), plus one at 2.7 m on a stand in the middle. Change a height in
   the list, or **Move** an anchor and click a wall or the floor in the model
   (on a wall it sits 25 cm out). Every room keeps its own plan (saved per
   computer and per model), and the last room you planned is chosen again.
   The panel warns when two anchors are more than 15 m apart. If the model
   has no closed rooms, the whole model is planned as one space.

## 7. Phone direction

The AR viewer reads the phone's own orientation sensors (compass-based) about
5 times a second while the camera runs and saves where the back camera points
(table `phone_pose`: heading 0-360° from north, pitch up/down, roll) on the
server clock, under the session. The live map shows it live (via `ar_live`)
and in replays: in the Room view the phone is drawn where the tag was measured
(at its height), turned like the real phone (direction, tilt, roll), with a
view cone from its camera; **Show** switches to the person holding it (a 1.7 m
figure about 35 cm behind the phone) or both. The top and 3D views draw an
arrow on the first tag (the phone's tag).

Set up once: in Room view → **Compass**, hold the phone (AR viewer running) at
A1 with its back camera pointing at A2 and click **Phone points along A1 → A2
now** (or type the compass bearing of A1 → A2).
If the arrow points backwards, click **Arrow points backwards: turn 180°**.
More reliable: **set up by pointing at anchors**. While the phone's tag is
tracked, stand a few meters from an anchor, point the back camera at it,
choose it in the list and click **Phone points at this anchor now**; then do
the same for a second anchor at least 45° to the side. This works out the
compass bearing and whether the room turns the other way: Pozyx's own
calibration cannot tell left from right, so when anchor A3 is to the right of
A1 → A2 (seen from above) its y axis is mirrored; the page then turns the
arrow the other way (**Turns the other way**, saved with the setup).
Exports include `xAxisHeading`, `compassReversed` and `orientation`; Unity
uses them (see `unity/README.md`).
Indoor compasses can be off by 10-30° near metal and electronics.

## Syncing tips

- Both files use the same `unix_ms`, so rows can be matched directly.
- Each device stamps with its own clock. Keep automatic time on for the phone
  and the laptop. On Windows, click Settings → Time & language → Date & time →
  **Sync now** before a session.
- To measure any remaining offset, tap the phone button at the instant you
  drop the tag on the floor. The impact shows as a sharp change in z; the gap
  between it and the tap is the clock offset.
