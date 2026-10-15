// Logique métier : commandes centrales (caisse et borne), stock, statuts.
// Règle : la déduction de stock a lieu une seule fois, à la confirmation de la commande.
// Un menu n'a pas de recette propre : seuls ses produits composants déduisent le stock.
import { openDB, dbGet, dbAll, uid, audit } from './db.js';

export const PREP_STATUSES = ['Nouvelle commande', 'En préparation', 'Prête', 'Remise au client', 'Terminée', 'Annulée'];
export const PAYMENT_STATUSES = ['En attente', 'Confirmé', 'Remboursé', 'Annulé'];

// Lignes : [{ productId, qty, options: [{label, price}] }]
// Retourne le total (menu inclus), sans toucher au stock.
export function priceLines(lines, productsById) {
  let total = 0;
  const detailed = lines.map(line => {
    const p = productsById[line.productId];
    if (!p) throw new Error(`Produit introuvable : ${line.productId}`);
    if (!p.active) throw new Error(`Produit indisponible : ${p.name}`);
    const optionsTotal = (line.options || []).reduce((s, o) => s + Number(o.price || 0), 0);
    const unit = Number(p.price) + optionsTotal;
    const subtotal = unit * line.qty;
    total += subtotal;
    return { productId: p.id, name: p.name, qty: line.qty, unitPrice: unit, options: line.options || [], subtotal };
  });
  return { lines: detailed, total };
}

// Calcule les besoins en stock d'une liste de lignes (menus développés en composants).
export function stockNeeds(lines, productsById) {
  const needs = {};
  const addRecipe = (productId, qty) => {
    const p = productsById[productId];
    if (!p) return;
    if (p.menuOf && p.menuOf.length) {
      for (const sub of p.menuOf) addRecipe(sub, qty);
      return;
    }
    for (const r of p.recipe || []) {
      needs[r.ingredient] = (needs[r.ingredient] || 0) + r.qty * qty;
    }
  };
  for (const line of lines) addRecipe(line.productId, line.qty);
  return needs;
}

// Crée une commande et déduit le stock dans une seule transaction.
// Refuse la commande si le stock est insuffisant (si le contrôle est activé).
export async function createOrder({ source, kioskId, staff, mode, lines, payment, comment, controlStock = true }) {
  if (!lines || !lines.length) throw new Error('Commande vide.');
  const [products, stockItems] = await Promise.all([dbAll('products'), dbAll('stock')]);
  const productsById = Object.fromEntries(products.map(p => [p.id, p]));
  const priced = priceLines(lines, productsById);
  const needs = stockNeeds(lines, productsById);

  const db = await openDB();
  const id = uid('CMD');
  const at = new Date().toISOString();

  await new Promise((resolve, reject) => {
    const t = db.transaction(['stock', 'orders', 'movements', 'audit'], 'readwrite');
    const stockStore = t.objectStore('stock');
    const stockIds = Object.keys(needs);
    let pending = stockIds.length;
    const stockMap = {};

    const finish = () => {
      if (controlStock) {
        for (const sid of stockIds) {
          const item = stockMap[sid];
          if (!item || item.qty < needs[sid]) {
            t.abort();
            reject(new Error(`Stock insuffisant : ${item ? item.name : sid}`));
            return;
          }
        }
      }
      for (const sid of stockIds) {
        const item = stockMap[sid];
        const before = item.qty;
        item.qty = before - needs[sid];
        stockStore.put(item);
        t.objectStore('movements').put({
          id: uid('MVT'), at, kind: 'Consommation', ingredient: sid,
          qty: -needs[sid], before, after: item.qty, orderId: id, user: staff
        });
      }
      t.objectStore('orders').put({
        id, at, source, kioskId: kioskId || null, staff: staff || null, mode,
        lines: priced.lines, total: priced.total, comment: comment || '',
        payment: { method: payment.method, status: payment.status },
        prepStatus: 'Nouvelle commande', history: [{ at, status: 'Nouvelle commande', user: staff || 'borne' }]
      });
      t.objectStore('audit').put({ id: uid('AUD'), at, user: staff || 'borne', action: 'Commande créée', detail: id });
    };

    if (pending === 0) finish();
    for (const sid of stockIds) {
      const req = stockStore.get(sid);
      req.onsuccess = () => {
        stockMap[sid] = req.result;
        if (--pending === 0) finish();
      };
    }
    t.oncomplete = () => resolve(id);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction annulée'));
  });

  return id;
}

// Change le statut de préparation : horodaté, tracé.
export async function setPrepStatus(orderId, status, user) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['orders', 'audit'], 'readwrite');
    const os = t.objectStore('orders');
    const req = os.get(orderId);
    req.onsuccess = () => {
      const o = req.result;
      if (!o) { t.abort(); reject(new Error('Commande introuvable')); return; }
      const at = new Date().toISOString();
      o.prepStatus = status;
      o.history = [...(o.history || []), { at, status, user }];
      os.put(o);
      t.objectStore('audit').put({ id: uid('AUD'), at, user, action: 'Statut préparation', detail: `${orderId} → ${status}` });
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Annulé'));
  });
}

// Paiement : distinct de la préparation. Confirmation explicite requise.
export async function setPaymentStatus(orderId, status, user) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['orders', 'audit'], 'readwrite');
    const os = t.objectStore('orders');
    const req = os.get(orderId);
    req.onsuccess = () => {
      const o = req.result;
      if (!o) { t.abort(); reject(new Error('Commande introuvable')); return; }
      const at = new Date().toISOString();
      o.payment = { ...o.payment, status, confirmedBy: user, confirmedAt: at };
      os.put(o);
      t.objectStore('audit').put({ id: uid('AUD'), at, user, action: 'Statut paiement', detail: `${orderId} → ${status}` });
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Annulé'));
  });
}

export const getOrders = () => dbAll('orders');
export const getProducts = () => dbAll('products');
export const getStock = () => dbAll('stock');
export const getMovements = () => dbAll('movements');
// Réglages par défaut si la base est vide : l'application doit fonctionner sans démo.
export const DEFAULT_SETTINGS = {
  id: 'main', companyName: "Cluckin' Bell", currency: 'GTA$', openingBalance: 0,
  paymentMethods: ['Espèces', 'Carte bancaire', 'Paiement entreprise', 'Autre mode RP'],
  kioskEnabled: true, demo: false
};
export const getSettings = async () => ({ ...DEFAULT_SETTINGS, ...(await dbGet('settings', 'main')) });
