// Connection to the Supabase database, shared by pozyx_live_map.html and sync_marker.html.
//
// Fill in the two values from Supabase: Project Settings → API (or "API Keys"):
//   url: the Project URL, e.g. https://abcdefghijkl.supabase.co
//   key: the anon public key (starts with eyJ...) or the publishable key (sb_publishable_...)
// This key is meant to be public. Never put the secret / service_role key here.
// Leave them empty to run both pages without a database.
window.POZYX_DB = {
  url: 'https://aawyndzgltaqrhcdwqfi.supabase.co',
  key: '',
};

window.pozyxDb = {
  configured() {
    const c = window.POZYX_DB;
    return !!(c && c.url && c.key);
  },

  async request(path, { method = 'GET', body, prefer } = {}) {
    const c = window.POZYX_DB;
    const headers = { apikey: c.key, 'Content-Type': 'application/json' };
    if (c.key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + c.key;   // older anon keys
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(c.url.replace(/\/+$/, '') + '/rest/v1/' + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try { const j = await res.json(); if (j.message) msg = j.message; } catch (e) {}
      throw new Error(msg);
    }
    return method === 'GET' ? res.json() : null;
  },

  // Insert rows, or update them if a row with the same key is already there (safe to retry).
  upsert(table, rows, onConflict) {
    return this.request(`${table}?on_conflict=${onConflict}`, {
      method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal',
    });
  },

  remove(table, column, value) {
    return this.request(`${table}?${column}=eq.${encodeURIComponent(value)}`, { method: 'DELETE', prefer: 'return=minimal' });
  },
};
