// Replays a recording exported from the Pozyx live map (Saved sessions -> Export JSON).
//
// - Moves a visitor object along the recorded track (Pozyx x, y on the floor; the height is the
//   fixed height chosen at export).
// - While the visitor looks at an image in the AR viewer, every material named after the image
//   plus a suffix (default "_MAT", e.g. image "MIRO_D5" -> material "MIRO_D5_MAT") turns greenish.
//   Matching ignores upper/lower case, and spaces or dashes in image names count as "_".
// - Shows a small player: Play/Pause, timeline, speed, the current look and the last phone tap.
//
// Setup: add this script to an empty GameObject, drag the exported .json file into "Session Json"
// (or set "Json Path"), then press Play. Space = play/pause.

using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

[Serializable] public class PozyxSessionInfo { public string id; public string name; }
[Serializable] public class PozyxRecordingInfo { public string id; public long startUnixMs; public string startTime; public float duration; }
[Serializable] public class PozyxAnchor { public string id; public float x; public float y; public float z; }
[Serializable] public class PozyxPosition { public float t; public string tag; public float x; public float y; public float z; public long unixMs; }
[Serializable] public class PozyxLook
{
    public float start; public float end; public float duration;
    public string image; public string imageId; public string mode; public string otherSession;
    public long startUnixMs; public long endUnixMs;
}
[Serializable] public class PozyxTap { public float t; public string label; public long unixMs; }
[Serializable] public class PozyxSessionFile
{
    public string format; public int version; public float fixedHeight; public float phoneTimeShift;
    public PozyxSessionInfo session; public PozyxRecordingInfo recording;
    public PozyxAnchor[] anchors; public string[] tags; public PozyxPosition[] positions;
    public PozyxLook[] looks; public PozyxTap[] taps;
}

public class PozyxReplay : MonoBehaviour
{
    [Header("Recording")]
    [Tooltip("The .json exported from the Pozyx live map")]
    public TextAsset sessionJson;
    [Tooltip("Used when Session Json is empty: full path to an exported .json file")]
    public string jsonPath;

    [Header("Room alignment (Pozyx origin = floor below anchor A1)")]
    [Tooltip("Optional: the Pozyx origin is placed at this transform (its rotation and scale apply too)")]
    public Transform roomOrigin;
    public Vector3 offset = Vector3.zero;
    [Tooltip("Turns the Pozyx track around the vertical axis, in degrees")]
    public float rotationY = 0f;
    [Tooltip("Flip if the track comes out mirrored compared to your room")]
    public bool mirrorX = false;

    [Header("Visitor")]
    [Tooltip("Moved along the track of the first tag. A capsule is created when empty.")]
    public Transform visitor;
    [Tooltip("Other tags in the recording get a small sphere each")]
    public bool showOtherTags = true;
    public bool showAnchors = true;

    [Header("Playback")]
    public bool playOnStart = true;
    public float speed = 1f;
    public bool loop = false;
    public bool showPlayer = true;

    [Header("Looked-at images")]
    [Tooltip("Material name = image name + this suffix")]
    public string materialSuffix = "_MAT";
    public Color lookColor = new Color(0.25f, 1f, 0.35f);
    [Range(0f, 1f)] public float lookStrength = 0.6f;
    [Tooltip("Also make the material glow, so the green shows in dark scenes")]
    public bool useEmission = true;
    [Tooltip("Seconds to fade the green in and out")]
    public float fadeTime = 0.25f;

    public PozyxSessionFile Data { get; private set; }
    public float CurrentTime { get; private set; }
    public bool Playing { get; private set; }
    public float Duration => Data != null && Data.recording != null ? Data.recording.duration : 0f;

    class Track { public string tag; public List<PozyxPosition> points = new List<PozyxPosition>(); public Transform target; }
    class Tinted { public Material mat; public Color baseColor; public bool hasBase; public string colorProp; public Color emission; public bool hasEmission; public float weight; }

    readonly List<Track> tracks = new List<Track>();
    readonly Dictionary<string, List<Tinted>> tintsByImage = new Dictionary<string, List<Tinted>>();
    readonly List<GameObject> created = new List<GameObject>();
    string currentLookText = "", lastTapText = "";

    void Start()
    {
        if (Load()) Playing = playOnStart;
    }

    // Loads the recording, builds the tracks and finds the image materials. Returns false on failure.
    public bool Load()
    {
        Unload();
        string json = sessionJson != null ? sessionJson.text : (!string.IsNullOrEmpty(jsonPath) && File.Exists(jsonPath) ? File.ReadAllText(jsonPath) : null);
        if (json == null) { Debug.LogError("PozyxReplay: set Session Json (or Json Path) to a file exported from the Pozyx live map."); return false; }
        Data = JsonUtility.FromJson<PozyxSessionFile>(json);
        if (Data == null || Data.positions == null || Data.positions.Length == 0) { Debug.LogError("PozyxReplay: the file has no positions."); return false; }
        if (Data.recording == null) Data.recording = new PozyxRecordingInfo();
        if (Data.recording.duration <= 0f) Data.recording.duration = Data.positions[Data.positions.Length - 1].t;
        Data.looks = Data.looks ?? new PozyxLook[0];
        Data.taps = Data.taps ?? new PozyxTap[0];

        // one track per tag, in time order
        var byTag = new Dictionary<string, Track>();
        foreach (var p in Data.positions)
        {
            if (!byTag.TryGetValue(p.tag ?? "", out var tr)) { tr = new Track { tag = p.tag ?? "" }; byTag[tr.tag] = tr; tracks.Add(tr); }
            tr.points.Add(p);
        }
        foreach (var tr in tracks) tr.points.Sort((a, b) => a.t.CompareTo(b.t));
        for (int i = 0; i < tracks.Count; i++)
        {
            if (i == 0)
            {
                if (visitor == null) visitor = Make(PrimitiveType.Capsule, "Visitor " + tracks[0].tag, new Vector3(0.35f, 0.5f, 0.35f), new Color(0.85f, 0.35f, 0.19f));
                tracks[0].target = visitor;
            }
            else if (showOtherTags)
            {
                tracks[i].target = Make(PrimitiveType.Sphere, "Tag " + tracks[i].tag, Vector3.one * 0.25f, new Color(0.33f, 0.29f, 0.72f));
            }
        }
        if (showAnchors && Data.anchors != null)
            foreach (var a in Data.anchors)
                Make(PrimitiveType.Cube, "Anchor " + a.id, Vector3.one * 0.12f, new Color(0.11f, 0.62f, 0.46f)).position = ToWorld(a.x, a.y, a.z);

        FindImageMaterials();
        CurrentTime = 0f;
        Apply(0f, true);
        Debug.Log($"PozyxReplay: \"{Data.session?.name}\" {Data.recording.id}, {Duration:0.0} s, {Data.positions.Length} positions, {Data.looks.Length} looks, {Data.taps.Length} taps.");
        return true;
    }

    Transform Make(PrimitiveType type, string name, Vector3 scale, Color color)
    {
        var go = GameObject.CreatePrimitive(type);
        go.name = name;
        go.transform.localScale = scale;
        Destroy(go.GetComponent<Collider>());
        var r = go.GetComponent<Renderer>();
        r.material.color = color;
        created.Add(go);
        return go.transform;
    }

    // Pozyx (x, y on the floor, z up) -> Unity (x, y up, z)
    public Vector3 ToWorld(float x, float y, float height)
    {
        var local = Quaternion.Euler(0f, rotationY, 0f) * new Vector3(mirrorX ? -x : x, height, y) + offset;
        return roomOrigin != null ? roomOrigin.TransformPoint(local) : local;
    }

    static string Key(string s) => (s ?? "").Trim().ToUpperInvariant().Replace(' ', '_').Replace('-', '_');

    void FindImageMaterials()
    {
        var images = new HashSet<string>();
        foreach (var lk in Data.looks) if (!string.IsNullOrEmpty(lk.image)) images.Add(Key(lk.image));
        if (images.Count == 0) return;
#if UNITY_2023_1_OR_NEWER
        var renderers = FindObjectsByType<Renderer>(FindObjectsInactive.Include, FindObjectsSortMode.None);
#else
        var renderers = FindObjectsOfType<Renderer>(true);
#endif
        string suffix = Key(materialSuffix);
        foreach (var r in renderers)
        {
            var shared = r.sharedMaterials;
            bool any = false;
            for (int i = 0; i < shared.Length; i++) if (shared[i] != null && images.Contains(ImageOf(shared[i].name, suffix))) any = true;
            if (!any) continue;
            var mats = r.materials;   // copies for this object, so the material assets stay unchanged
            for (int i = 0; i < mats.Length; i++)
            {
                if (shared[i] == null) continue;
                string image = ImageOf(shared[i].name, suffix);
                if (!images.Contains(image)) continue;
                var m = mats[i];
                var t = new Tinted { mat = m };
                t.colorProp = m.HasProperty("_BaseColor") ? "_BaseColor" : m.HasProperty("_Color") ? "_Color" : null;
                if (t.colorProp != null) { t.baseColor = m.GetColor(t.colorProp); t.hasBase = true; }
                if (m.HasProperty("_EmissionColor")) { t.emission = m.GetColor("_EmissionColor"); t.hasEmission = true; }
                if (!tintsByImage.TryGetValue(image, out var list)) tintsByImage[image] = list = new List<Tinted>();
                list.Add(t);
            }
        }
        foreach (var img in images)
            if (!tintsByImage.ContainsKey(img)) Debug.LogWarning($"PozyxReplay: no material named \"{img}{suffix}\" for the image \"{img}\".");
    }

    // "MIRO_D5_MAT (Instance)" -> "MIRO_D5" when the suffix is "_MAT"
    static string ImageOf(string materialName, string suffix)
    {
        string k = Key(materialName.Replace(" (Instance)", ""));
        return k.EndsWith(suffix) ? k.Substring(0, k.Length - suffix.Length) : "";
    }

    void Update()
    {
        if (Data == null) return;
#if ENABLE_LEGACY_INPUT_MANAGER
        if (Input.GetKeyDown(KeyCode.Space)) Playing = !Playing;
#endif
        if (Playing)
        {
            CurrentTime += Time.deltaTime * speed;
            if (CurrentTime >= Duration)
            {
                if (loop) CurrentTime = 0f;
                else { CurrentTime = Duration; Playing = false; }
            }
        }
        Apply(Time.deltaTime, false);
    }

    public void Seek(float seconds) { CurrentTime = Mathf.Clamp(seconds, 0f, Duration); Apply(0f, true); }
    public void Play() => Playing = true;
    public void Pause() => Playing = false;

    void Apply(float dt, bool snap)
    {
        float t = CurrentTime;
        foreach (var tr in tracks)
            if (tr.target != null) tr.target.position = PositionAt(tr.points, t);

        // which images are being looked at now
        var active = new HashSet<string>();
        currentLookText = "";
        foreach (var lk in Data.looks)
            if (t >= lk.start && t <= lk.end)
            {
                active.Add(Key(lk.image));
                currentLookText = $"Looking at {lk.image} ({(lk.mode == "ai" ? "AI assisted" : "Generic")}) · {t - lk.start:0.0} / {lk.duration:0.0} s";
            }
        float step = snap || fadeTime <= 0f ? 1f : dt / fadeTime;
        foreach (var kv in tintsByImage)
        {
            float goal = active.Contains(kv.Key) ? lookStrength : 0f;
            foreach (var tint in kv.Value)
            {
                tint.weight = Mathf.MoveTowards(tint.weight, goal, step * Mathf.Max(lookStrength, 0.01f));
                SetTint(tint);
            }
        }

        lastTapText = "";
        foreach (var tap in Data.taps)
            if (tap.t <= t && t - tap.t < 2f) lastTapText = "Tap" + (string.IsNullOrEmpty(tap.label) ? "" : ": " + tap.label);
    }

    void SetTint(Tinted tint)
    {
        if (tint.hasBase) tint.mat.SetColor(tint.colorProp, Color.Lerp(tint.baseColor, lookColor, tint.weight));
        if (useEmission && tint.hasEmission)
        {
            if (tint.weight > 0f) tint.mat.EnableKeyword("_EMISSION");
            tint.mat.SetColor("_EmissionColor", tint.emission + lookColor * (tint.weight * 0.6f));
        }
    }

    // Position at time t, between the two nearest samples
    Vector3 PositionAt(List<PozyxPosition> pts, float t)
    {
        if (pts.Count == 0) return Vector3.zero;
        if (t <= pts[0].t) return ToWorld(pts[0].x, pts[0].y, pts[0].z);
        if (t >= pts[pts.Count - 1].t) { var e = pts[pts.Count - 1]; return ToWorld(e.x, e.y, e.z); }
        int lo = 0, hi = pts.Count - 1;
        while (hi - lo > 1) { int mid = (lo + hi) / 2; if (pts[mid].t <= t) lo = mid; else hi = mid; }
        var a = pts[lo]; var b = pts[hi];
        float k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0f;
        return Vector3.Lerp(ToWorld(a.x, a.y, a.z), ToWorld(b.x, b.y, b.z), k);
    }

    void OnGUI()
    {
        if (!showPlayer || Data == null) return;
        const float w = 460f, h = 96f;
        GUILayout.BeginArea(new Rect(10, Screen.height - h - 10, w, h), GUI.skin.box);
        GUILayout.Label($"{Data.session?.name}  ·  {Data.recording.startTime}");
        GUILayout.BeginHorizontal();
        if (GUILayout.Button(Playing ? "Pause" : "Play", GUILayout.Width(60))) { if (!Playing && CurrentTime >= Duration) Seek(0f); Playing = !Playing; }
        float nt = GUILayout.HorizontalSlider(CurrentTime, 0f, Mathf.Max(Duration, 0.01f));
        if (!Mathf.Approximately(nt, CurrentTime)) Seek(nt);
        GUILayout.Label($"{CurrentTime:0.0} / {Duration:0.0} s", GUILayout.Width(100));
        if (GUILayout.Button($"{speed:0.##}x", GUILayout.Width(44))) speed = speed >= 4f ? 0.25f : speed * 2f;
        GUILayout.EndHorizontal();
        GUILayout.Label(string.IsNullOrEmpty(currentLookText) ? (lastTapText == "" ? " " : lastTapText) : currentLookText + (lastTapText == "" ? "" : "   " + lastTapText));
        GUILayout.EndArea();
    }

    void Unload()
    {
        RestoreMaterials();
        foreach (var go in created) if (go != null) Destroy(go);
        created.Clear();
        tracks.Clear();
        tintsByImage.Clear();
    }

    void RestoreMaterials()
    {
        foreach (var list in tintsByImage.Values)
            foreach (var tint in list) { tint.weight = 0f; if (tint.mat != null) SetTint(tint); }
    }

    void OnDisable() => RestoreMaterials();
}
