# Replaying Pozyx sessions in Unity

`PozyxReplay.cs` plays back a recording exported from the Pozyx live map:
the visitor moves through your Unity room, and every image the visitor looks at
in the AR viewer turns greenish while they look at it.

## 1. Export from the live map

Live map → **Saved sessions** → pick the session → **Export JSON** next to a
recording (or **Export JSON** in the replay bar, which also applies the phone
time shift). **Height in export** (default 1.0 m) is the fixed height used
for the track; the measured height is left out.

## 2. Set up Unity

1. Copy `PozyxReplay.cs` into your project's `Assets` folder.
2. Copy the exported `.json` into `Assets` too (Unity imports it as a text file).
3. Create an empty GameObject, add the **Pozyx Replay** component and drag the
   `.json` into **Session Json**.
4. Press **Play**. A player appears at the bottom left: Play/Pause, timeline,
   speed. Space also plays/pauses.

## Settings

| Setting | What it does |
| --- | --- |
| Room Origin / Offset / Rotation Y / Mirror X | Line up the Pozyx origin (floor below anchor A1, x towards A2) with your room. |
| Visitor | The object that follows the tag. Left empty, a capsule is created. |
| Show Other Tags / Show Anchors | Small markers for extra tags and for the anchors. |
| Speed, Loop, Play On Start, Show Player | Playback. |
| Material Suffix | Material name = image name + this (default `_MAT`). |
| Look Color, Look Strength, Use Emission, Fade Time | How the looked-at materials change. |

## Image materials

For an image called `MIRO_D5` in the AR editor, name the material `MIRO_D5_MAT`.
Upper/lower case does not matter, and spaces or dashes in image names count as
`_` (an image called "Miro D5" matches `MIRO_D5_MAT`). Every object using that
material is tinted; the material asset itself is not changed. Works with the
Standard, URP and HDRP Lit shaders (`_Color` / `_BaseColor`, plus
`_EmissionColor` when Use Emission is on). Images without a matching material
are listed as warnings in the Console when the replay loads.

## Coordinates

Pozyx x and y (along the floor) become Unity x and z; Unity y is the fixed
export height. Units are meters.
