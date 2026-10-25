// Connection to the Supabase database, shared by pozyx_live_map.html and sync_marker.html.
//
// Fill in the two values from Supabase: Project Settings → API (or "API Keys"):
//   url: the Project URL, e.g. https://abcdefghijkl.supabase.co
//   key: the anon public key (starts with eyJ...) or the publishable key (sb_publishable_...)
// This key is meant to be public. Never put the secret / service_role key here.
// Leave them empty to run both pages without a database.
window.POZYX_DB = {
  url: 'https://aawyndzgltaqrhcdwqfi.supabase.co',
  key: 'sb_publishable_AE8aSJSJV0Jh1HZINeai-A_IykYcd_Z',
};

window.pozyxDb = {
  configured() {
    const c = window.POZYX_DB;
    return !!(c && c.url && c.key);
  },

  // keepalive lets a small upload finish even if the page is closed right after (max 64 KB)
  async request(path, { method = 'GET', body, prefer, keepalive = false } = {}) {
    const c = window.POZYX_DB;
    const headers = { apikey: c.key, 'Content-Type': 'application/json' };
    if (c.key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + c.key;   // older anon keys
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(c.url.replace(/\/+$/, '') + '/rest/v1/' + path, {
      method, headers, keepalive, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try { const j = await res.json(); if (j.message) msg = j.message; } catch (e) {}
      throw new Error(msg);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },

  // How far this device's clock is from the database server's clock, in ms to ADD to Date.now().
  // Asks the server for its time a few times and keeps the fastest answer (least network delay).
  async measureClock(rounds = 8) {
    let best = null;
    for (let i = 0; i < rounds; i++) {
      const sent = Date.now(), p0 = performance.now();
      const server = +(await this.request('rpc/server_time_ms', { method: 'POST', body: {} }));
      const rtt = performance.now() - p0;
      const offset = server - (sent + rtt / 2);
      if (Number.isFinite(offset) && (!best || rtt < best.rtt)) best = { offset, rtt };
    }
    if (!best) throw new Error('no answer from the server clock');
    best.at = Date.now();
    return best;   // {offset, rtt, at}; accurate to about rtt / 2
  },

  // Insert rows, or update them if a row with the same key is already there (safe to retry).
  upsert(table, rows, onConflict, { keepalive = false } = {}) {
    return this.request(`${table}?on_conflict=${onConflict}`, {
      method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal', keepalive,
    });
  },

  /* ---------- file storage (bucket "ar") ---------- */

  // Public address of a stored file
  fileUrl(path) {
    return window.POZYX_DB.url.replace(/\/+$/, '') + '/storage/v1/object/public/ar/' + path.split('/').map(encodeURIComponent).join('/');
  },

  // Upload (or replace) a file; resolves with its path
  async uploadFile(path, blob, contentType) {
    const c = window.POZYX_DB;
    const headers = { apikey: c.key, 'Content-Type': contentType || blob.type || 'application/octet-stream', 'x-upsert': 'true' };
    if (c.key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + c.key;
    const res = await fetch(c.url.replace(/\/+$/, '') + '/storage/v1/object/ar/' + path.split('/').map(encodeURIComponent).join('/'), {
      method: 'POST', headers, body: blob,
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try { const j = await res.json(); if (j.message || j.error) msg = j.message || j.error; } catch (e) {}
      throw new Error(`upload failed: ${msg}`);
    }
    return path;
  },

  async removeFiles(paths) {
    const c = window.POZYX_DB;
    if (!paths.length) return;
    const headers = { apikey: c.key, 'Content-Type': 'application/json' };
    if (c.key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + c.key;
    await fetch(c.url.replace(/\/+$/, '') + '/storage/v1/object/ar', { method: 'DELETE', headers, body: JSON.stringify({ prefixes: paths }) });
  },

  remove(table, column, value) {
    return this.request(`${table}?${column}=eq.${encodeURIComponent(value)}`, { method: 'DELETE', prefer: 'return=minimal' });
  },
};
