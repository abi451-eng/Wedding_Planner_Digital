/* =====================================================================
   db.js — LAPISAN DATA WEDDING FUND
   ---------------------------------------------------------------------
   Tugas file ini: menyembunyikan kerumitan Supabase, dan menyediakan
   fungsi-fungsi sederhana yang dipanggil index.html.

   Prinsip HYBRID OFFLINE (sesuai pilihanmu):
   - localStorage = CACHE. App selalu membaca dari sini -> instan & jalan
     tanpa sinyal (penting di Jayapura).
   - Supabase     = SUMBER KEBENARAN. Setiap perubahan dikirim ke server;
     kalau lagi offline, perubahan diantre dan dikirim otomatis saat online.

   Alur singkat:
     tulis -> update cache (UI langsung berubah) -> kirim ke server
              -> kalau gagal/offline -> masuk ANTREAN -> dikirim ulang nanti
   ===================================================================== */

(function () {
'use strict';
/* Semua variabel di bawah ini PRIVAT (terbungkus IIFE).
   Ini mencegah tabrakan nama dengan variabel di index.html
   — misalnya `DB`, yang sebelumnya bentrok dan bikin SyntaxError. */

const SUPABASE_URL  = 'https://libfjoygcjmtwznvjeav.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_cySKN13Z6qL26MelSyfqrw_aPIOiUQ1';

const CACHE_KEY  = 'wf_cache_v1';   // salinan data lokal
const QUEUE_KEY  = 'wf_queue_v1';   // antrean perubahan saat offline

// Klien Supabase (dibuat di index.html setelah library dimuat)
let sb = null;

const DB = {
  ready: false,
  online: navigator.onLine !== false,   // anggap online kecuali browser bilang offline
  user: null,          // { id, email, name, avatar }
  household: null,     // { household_id, name, invite_code, role, member_count }
  categories: [],
  pots: [],            // tiap pot: { ..., collected, can_view_amount }
  syncing: false,
  pendingCount: 0,
};

/* ---------------------------------------------------------------
   CACHE — supaya app tetap hidup saat offline
--------------------------------------------------------------- */
function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      owner: DB.user?.id || null,   // cache ini MILIK SIAPA
      household: DB.household,
      categories: DB.categories,
      pots: DB.pots,
      savedAt: Date.now(),
    }));
  } catch (e) { console.warn('cache gagal', e); }
}

/* Muat cache HANYA kalau pemiliknya sama dengan user yang sedang login.
   Kalau HP ini pernah dipakai akun lain, cache-nya dibuang — supaya data
   pasangan/orang lain tidak bocor lewat sisa cache saat offline. */
function loadCache(expectUserId) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const c = JSON.parse(raw);
    if (expectUserId && c.owner && c.owner !== expectUserId) {
      localStorage.removeItem(CACHE_KEY);   // cache milik akun lain -> buang
      return false;
    }
    DB.household  = c.household  || null;
    DB.categories = c.categories || [];
    DB.pots       = c.pots       || [];
    return true;
  } catch (e) { return false; }
}

/* ---------------------------------------------------------------
   ANTREAN — perubahan yang belum sampai ke server
   Tiap item: { id, table, action, payload }
--------------------------------------------------------------- */
function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch (e) { return []; }
}
function setQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  DB.pendingCount = q.length;
  window.dispatchEvent(new CustomEvent('db:status'));
}
function enqueue(item) {
  const q = getQueue();
  q.push({ ...item, qid: crypto.randomUUID(), at: Date.now() });
  setQueue(q);
}

/** Kirim ulang semua perubahan yang tertahan. Dipanggil saat online kembali. */
async function flushQueue() {
  if (!sb || !DB.online || DB.syncing) return;
  let q = getQueue();
  if (!q.length) return;

  DB.syncing = true;
  window.dispatchEvent(new CustomEvent('db:status'));

  const sisa = [];
  for (const item of q) {
    try {
      await applyRemote(item);
    } catch (e) {
      console.warn('gagal kirim, dicoba lagi nanti:', item.action, e.message);
      sisa.push(item);   // simpan, coba lagi nanti
    }
  }
  setQueue(sisa);

  DB.syncing = false;
  if (!sisa.length) await pull();   // tarik data terbaru dari server
  window.dispatchEvent(new CustomEvent('db:status'));
}

/** Terjemahkan satu item antrean menjadi perintah Supabase sungguhan. */
async function applyRemote(item) {
  const { table, action, payload } = item;

  if (action === 'insert') {
    const { error } = await sb.from(table).insert(payload);
    if (error) throw error;

  } else if (action === 'update') {
    const { id, ...fields } = payload;
    const { error } = await sb.from(table).update(fields).eq('id', id);
    if (error) throw error;

  } else if (action === 'delete') {
    const { error } = await sb.from(table).delete().eq('id', payload.id);
    if (error) throw error;
  }
}

/** Jalankan sekarang kalau online; kalau gagal/offline -> antrekan. */
async function write(table, action, payload) {
  if (DB.online && sb) {
    try {
      await applyRemote({ table, action, payload });
      return true;
    } catch (e) {
      console.warn('tulis gagal -> antre:', e.message);
    }
  }
  enqueue({ table, action, payload });
  return false;
}

/* ---------------------------------------------------------------
   AUTH
--------------------------------------------------------------- */
async function signInGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}

async function signOut() {
  await sb.auth.signOut();
  localStorage.removeItem(CACHE_KEY);
  localStorage.removeItem(QUEUE_KEY);
  DB.user = null;
  DB.household = null;
  DB.categories = [];
  DB.pots = [];
}

/* ---------------------------------------------------------------
   HOUSEHOLD
--------------------------------------------------------------- */
async function createHousehold(name, displayName) {
  const { data, error } = await sb.rpc('create_household', {
    p_name: name || 'Rumah Tangga Kita',
    p_display_name: displayName || DB.user?.name || 'Saya',
  });
  if (error) throw error;
  await loadHousehold();
  await seedDefaults();     // isi kategori & pos bawaan
  await pull();
  return data?.[0];
}

async function joinHousehold(code, displayName) {
  const { error } = await sb.rpc('join_household', {
    p_code: (code || '').trim().toUpperCase(),
    p_display_name: displayName || DB.user?.name || 'Saya',
  });
  if (error) throw error;   // mis. "Kode undangan tidak ditemukan"
  await loadHousehold();
  await pull();
}

async function loadHousehold() {
  const { data, error } = await sb.rpc('my_household');
  if (error) throw error;
  DB.household = data?.[0] || null;
  saveCache();
  return DB.household;
}

/* Isi kategori & pos bawaan saat household baru dibuat */
async function seedDefaults() {
  if (!DB.household) return;
  const hid = DB.household.household_id;

  const cats = [
    ['Venue & Akad', '💒'], ['Catering', '🍽️'], ['Busana & Rias', '👗'],
    ['Dekorasi & Bunga', '💐'], ['Foto & Video', '📸'], ['Mahar', '💍'],
    ['Seserahan', '🎁'], ['Lain-lain', '📦'],
  ].map((c, i) => ({
    household_id: hid, name: c[0], ico: c[1], plan: 0, actual: 0, sort_order: i,
  }));
  await sb.from('categories').insert(cats);

  const pots = [
    { name: 'Dana Acara', ico: '💍', note: 'Mahar, seserahan & resepsi kecil',
      is_private: false, show_amount: true,  sort_order: 0 },
    { name: 'Dana Awal Rumah Tangga', ico: '🏠', note: 'Dikumpulkan bersama nanti',
      is_private: false, show_amount: true,  sort_order: 1 },
  ].map(p => ({ ...p, household_id: hid, owner_id: DB.user.id, target: 0 }));
  await sb.from('pots').insert(pots);
}

/* ---------------------------------------------------------------
   PULL — tarik semua data dari server ke cache
   Catatan: pots dibaca lewat pots_view, BUKAN tabel pots.
   View itulah yang menyembunyikan angka kalau show_amount = false.
--------------------------------------------------------------- */
async function pull() {
  if (!sb || !DB.online || !DB.household) return;
  const hid = DB.household.household_id;

  const [catRes, potRes] = await Promise.all([
    sb.from('categories').select('*').eq('household_id', hid).order('sort_order'),
    sb.from('pots_view').select('*').eq('household_id', hid).order('sort_order'),
  ]);
  if (catRes.error) throw catRes.error;
  if (potRes.error) throw potRes.error;

  DB.categories = catRes.data || [];
  const pots = potRes.data || [];

  // Ambil setoran hanya untuk pot yang angkanya boleh dilihat.
  const ids = pots.filter(p => p.can_view_amount).map(p => p.id);
  let deps = [];
  if (ids.length) {
    const { data, error } = await sb.from('deposits')
      .select('*').in('pot_id', ids).order('date', { ascending: false });
    if (error) throw error;
    deps = data || [];
  }

  DB.pots = pots.map(p => ({
    ...p,
    deposits: deps.filter(d => d.pot_id === p.id),
  }));

  saveCache();
  window.dispatchEvent(new CustomEvent('db:change'));
}

/* ---------------------------------------------------------------
   API PUBLIK — dipanggil index.html
   Semua fungsi ini: ubah cache dulu (UI langsung berubah),
   lalu kirim ke server / antrekan.
--------------------------------------------------------------- */

/* ---- KATEGORI (Budget) ---- */
async function addCategory({ name, ico, plan, actual }) {
  const row = {
    id: crypto.randomUUID(),
    household_id: DB.household.household_id,
    name, ico, plan: plan || 0, actual: actual || 0,
    sort_order: DB.categories.length,
  };
  DB.categories.push(row);
  saveCache();
  await write('categories', 'insert', row);
}

async function updateCategory(id, fields) {
  const c = DB.categories.find(x => x.id === id);
  if (c) Object.assign(c, fields);
  saveCache();
  await write('categories', 'update', { id, ...fields });
}

async function deleteCategory(id) {
  DB.categories = DB.categories.filter(x => x.id !== id);
  saveCache();
  await write('categories', 'delete', { id });
}

/* ---- POS TABUNGAN ---- */
async function addPot({ name, ico, note, target, is_private, show_amount }) {
  const row = {
    id: crypto.randomUUID(),
    household_id: DB.household.household_id,
    owner_id: DB.user.id,
    name, ico, note: note || null, target: target || 0,
    is_private: !!is_private,
    show_amount: show_amount !== false,
    sort_order: DB.pots.length,
  };
  DB.pots.push({ ...row, deposits: [], collected: 0, can_view_amount: true });
  saveCache();
  await write('pots', 'insert', row);
}

async function updatePot(id, fields) {
  const p = DB.pots.find(x => x.id === id);
  if (p) Object.assign(p, fields);
  saveCache();
  await write('pots', 'update', { id, ...fields });
}

async function deletePot(id) {
  DB.pots = DB.pots.filter(x => x.id !== id);
  saveCache();
  await write('pots', 'delete', { id });
}

/** Tombol "boleh dilihat pasangan" */
async function toggleShowAmount(id, show) {
  await updatePot(id, { show_amount: !!show });
}

/* ---- SETORAN ---- */
async function addDeposit(potId, { amount, by_label, note, date }) {
  const row = {
    id: crypto.randomUUID(),
    pot_id: potId,
    amount,
    by_label: by_label || 'Saya',
    note: note || null,
    date: date || new Date().toISOString().slice(0, 10),
    created_by: DB.user.id,
  };
  const p = DB.pots.find(x => x.id === potId);
  if (p) {
    p.deposits.push(row);
    p.collected = (p.collected || 0) + amount;
  }
  saveCache();
  await write('deposits', 'insert', row);
}

/** Hapus setoran — hanya yang mencatatnya (dijaga juga oleh RLS di server). */
async function deleteDeposit(potId, depId) {
  const p = DB.pots.find(x => x.id === potId);
  if (p) {
    const d = p.deposits.find(x => x.id === depId);
    if (d && d.created_by !== DB.user.id) {
      throw new Error('Setoran ini dicatat oleh pasanganmu — hanya dia yang bisa menghapusnya.');
    }
    if (d) {
      p.deposits = p.deposits.filter(x => x.id !== depId);
      p.collected = Math.max(0, (p.collected || 0) - d.amount);
    }
  }
  saveCache();
  await write('deposits', 'delete', { id: depId });
}

/* ---------------------------------------------------------------
   INIT — dipanggil sekali saat app dibuka
--------------------------------------------------------------- */
async function initDB(onReady) {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  DB.pendingCount = getQueue().length;

  // pantau status koneksi
  window.addEventListener('online',  () => { DB.online = true;  flushQueue(); window.dispatchEvent(new CustomEvent('db:status')); });
  window.addEventListener('offline', () => { DB.online = false; window.dispatchEvent(new CustomEvent('db:status')); });

  // pantau status login
  sb.auth.onAuthStateChange(async (_event, session) => {
    if (session?.user) {
      const u = session.user;
      DB.user = {
        id: u.id,
        email: u.email,
        name: u.user_metadata?.full_name || u.email?.split('@')[0] || 'Saya',
        avatar: u.user_metadata?.avatar_url || null,
      };

      // Tampilkan cache dulu (instan & jalan offline) — tapi hanya cache MILIKNYA.
      loadCache(DB.user.id);

      try {
        await loadHousehold();
        if (DB.household) {
          await flushQueue();
          await pull();          // data terbaru dari server menimpa cache
        }
      } catch (e) { console.warn('muat data gagal:', e.message); }
    } else {
      // logout / belum login -> jangan tinggalkan data siapa pun di layar
      DB.user = null;
      DB.household = null;
      DB.categories = [];
      DB.pots = [];
    }
    DB.ready = true;
    if (onReady) onReady();
    window.dispatchEvent(new CustomEvent('db:change'));
  });

  // cek sesi yang sudah ada
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    DB.ready = true;
    if (onReady) onReady();
  }
}

/* Ekspor ke global supaya index.html bisa memanggil */
window.WF = {
  DB, initDB,
  signInGoogle, signOut,
  createHousehold, joinHousehold, loadHousehold,
  addCategory, updateCategory, deleteCategory,
  addPot, updatePot, deletePot, toggleShowAmount,
  addDeposit, deleteDeposit,
  pull, flushQueue,
};

})();
