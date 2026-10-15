// Couche de données Cluckin' Bell : IndexedDB, écritures tracées, pas de réseau.
const DB_NAME = 'cluckin-bell';
const DB_VERSION = 1;
const STORES = ['products', 'stock', 'orders', 'sales', 'movements', 'audit', 'settings'];

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const result = fn(s);
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const dbGet = (store, id) => openDB().then(db => new Promise((res, rej) => {
  const r = db.transaction(store).objectStore(store).get(id);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));

export const dbAll = (store) => openDB().then(db => new Promise((res, rej) => {
  const r = db.transaction(store).objectStore(store).getAll();
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));

export const dbPut = (store, value) => tx(store, 'readwrite', s => s.put(value));

// Écriture atomique de plusieurs stores dans une seule transaction.
export function dbMulti(writes) {
  const stores = [...new Set(writes.map(w => w.store))];
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    for (const w of writes) t.objectStore(w.store).put(w.value);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export function uid(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

// Journal d'audit : toute action sensible y passe.
export async function audit(user, action, detail) {
  await dbPut('audit', {
    id: uid('AUD'),
    at: new Date().toISOString(),
    user,
    action,
    detail
  });
}

// Données de démonstration, clairement marquées, supprimables.
export async function seedDemo() {
  const products = [
    { id: 'P-BURGER', name: 'Cluckin Burger', category: 'Burgers et sandwichs', price: 12, cost: 4, active: true, counter: true, kiosk: true, recipe: [{ ingredient: 'S-PAIN', qty: 1 }, { ingredient: 'S-POULET', qty: 1 }, { ingredient: 'S-FROMAGE', qty: 1 }], demo: true },
    { id: 'P-BUCKET', name: 'Bucket de poulet (8)', category: 'Poulet', price: 28, cost: 9, active: true, counter: true, kiosk: true, recipe: [{ ingredient: 'S-POULET', qty: 8 }], demo: true },
    { id: 'P-FRITES', name: 'Frites', category: 'Accompagnements', price: 4, cost: 1, active: true, counter: true, kiosk: true, recipe: [{ ingredient: 'S-FRITES', qty: 1 }], demo: true },
    { id: 'P-COLA', name: 'Soda', category: 'Boissons', price: 3, cost: 0.6, active: true, counter: true, kiosk: true, recipe: [{ ingredient: 'S-SODA', qty: 1 }], demo: true },
    { id: 'P-MENU', name: 'Menu Cluckin', category: 'Menus', price: 18, cost: 6, active: true, counter: true, kiosk: true, recipe: [], menuOf: ['P-BURGER', 'P-FRITES', 'P-COLA'], demo: true }
  ];
  const stock = [
    { id: 'S-PAIN', name: 'Pains', category: 'Pains', unit: 'unité', qty: 80, min: 20, unitCost: 0.5, demo: true },
    { id: 'S-POULET', name: 'Poulet', category: 'Poulet et viandes', unit: 'pièce', qty: 60, min: 15, unitCost: 2, demo: true },
    { id: 'S-FROMAGE', name: 'Fromage', category: 'Fromages', unit: 'tranche', qty: 90, min: 20, unitCost: 0.3, demo: true },
    { id: 'S-FRITES', name: 'Frites surgelées', category: 'Frites', unit: 'portion', qty: 100, min: 25, unitCost: 0.8, demo: true },
    { id: 'S-SODA', name: 'Soda', category: 'Boissons', unit: 'canette', qty: 120, min: 30, unitCost: 0.4, demo: true }
  ];
  const settings = { id: 'main', companyName: "Cluckin' Bell", currency: 'GTA$', openingBalance: 5000, paymentMethods: ['Espèces', 'Carte bancaire', 'Paiement entreprise', 'Autre mode RP'], kioskEnabled: true, demo: true };
  await dbMulti([
    ...products.map(value => ({ store: 'products', value })),
    ...stock.map(value => ({ store: 'stock', value })),
    { store: 'settings', value: settings }
  ]);
}

// Suppression des données de démonstration uniquement.
export async function removeDemo() {
  for (const store of ['products', 'stock']) {
    const items = await dbAll(store);
    const db = await openDB();
    await new Promise((res, rej) => {
      const t = db.transaction(store, 'readwrite');
      for (const it of items) if (it.demo) t.objectStore(store).delete(it.id);
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  }
  const s = await dbGet('settings', 'main');
  if (s && s.demo) await dbPut('settings', { ...s, demo: false });
}
