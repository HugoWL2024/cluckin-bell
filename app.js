// Interface d'administration, caisse, cuisine et commandes.
import { dbGet, dbPut, dbAll, seedDemo, removeDemo, audit } from './db.js';
import {
  createOrder, setPrepStatus, setPaymentStatus, getOrders, getProducts, getStock,
  getSettings, PREP_STATUSES
} from './orders.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const staffInput = document.getElementById('staff');
const staff = () => staffInput.value.trim() || 'Employé';

// Échappement systématique de toute donnée saisie.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur = 'GTA$') => `${Number(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${cur}`;
const fmtDate = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

function notice(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'notice' + (isError ? ' error' : '');
  el.textContent = msg;
  view.prepend(el);
  setTimeout(() => el.remove(), 4000);
}

const prepBadge = (s) => {
  const cls = { 'Nouvelle commande': 'new', 'En préparation': 'prep', 'Prête': 'ready', 'Remise au client': 'done', 'Terminée': 'done', 'Annulée': 'danger' }[s] || '';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
};
const payBadge = (s) => {
  const cls = { 'Confirmé': 'ready', 'En attente': 'warn', 'Remboursé': 'done', 'Annulé': 'danger' }[s] || '';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
};

// ---------- Navigation ----------
const routes = {
  dashboard, caisse, cuisine, commandes, catalogue, stock, compta, parametres
};

function go(name) {
  nav.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  history.replaceState(null, '', '#' + name);
  routes[name]().catch(err => { view.innerHTML = ''; notice(err.message || String(err), true); });
}
nav.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) go(b.dataset.view);
});

document.getElementById('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('cb-theme', next); } catch (e) {}
});

// ---------- Tableau de bord ----------
async function dashboard() {
  const [orders, stock, settings] = await Promise.all([getOrders(), getStock(), getSettings()]);
  const now = new Date();
  const startDay = new Date(now); startDay.setHours(0, 0, 0, 0);
  const startWeek = new Date(startDay); startWeek.setDate(startDay.getDate() - ((startDay.getDay() + 6) % 7));
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const confirmed = orders.filter(o => o.payment?.status === 'Confirmé' && o.prepStatus !== 'Annulée');
  const sumSince = (d) => confirmed.filter(o => new Date(o.at) >= d).reduce((s, o) => s + o.total, 0);
  const countSince = (d) => orders.filter(o => new Date(o.at) >= d && o.prepStatus !== 'Annulée').length;
  const pendingOrders = orders.filter(o => !['Terminée', 'Remise au client', 'Annulée'].includes(o.prepStatus)).length;
  const lowStock = stock.filter(s => s.qty <= s.min);
  const soldToday = confirmed.filter(o => new Date(o.at) >= startDay);
  const avgBasket = soldToday.length ? soldToday.reduce((s, o) => s + o.total, 0) / soldToday.length : 0;
  const cashIn = confirmed.reduce((s, o) => s + o.total, 0);

  view.innerHTML = `
    <h1>Tableau de bord</h1>
    ${settings?.demo ? '<p class="demo-tag">DONNÉES DE DÉMONSTRATION : supprimables dans Paramètres</p>' : ''}
    <div class="grid">
      ${kpi('CA du jour', money(sumSince(startDay), settings?.currency))}
      ${kpi('CA de la semaine', money(sumSince(startWeek), settings?.currency))}
      ${kpi('CA du mois', money(sumSince(startMonth), settings?.currency))}
      ${kpi('Commandes du jour', countSince(startDay))}
      ${kpi('Panier moyen (jour)', money(avgBasket, settings?.currency))}
      ${kpi('Commandes en cours', pendingOrders)}
      ${kpi('Stocks faibles', lowStock.length)}
      ${kpi('Encaissé (total)', money(cashIn, settings?.currency))}
    </div>
    <h2>Actions à effectuer</h2>
    <div class="card">
      ${pendingOrders ? `<p>${pendingOrders} commande(s) à traiter. <a href="#cuisine">Ouvrir la cuisine</a></p>` : '<p>Aucune commande en attente.</p>'}
      ${orders.some(o => o.payment?.status === 'En attente') ? '<p>Des paiements attendent une confirmation en caisse.</p>' : ''}
      ${lowStock.length ? `<p>Stock faible : ${lowStock.map(s => esc(s.name)).join(', ')}</p>` : '<p>Aucun stock faible.</p>'}
    </div>
    <h2>Activité récente</h2>
    ${orders.length ? recentTable(orders.slice(-8).reverse()) : '<p class="card">Aucune commande enregistrée.</p>'}
  `;
}
const kpi = (label, value) => `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div></div>`;
function recentTable(list) {
  return `<div class="card"><table><tr><th>N°</th><th>Date</th><th>Origine</th><th>Total</th><th>Paiement</th><th>Préparation</th></tr>
    ${list.map(o => `<tr><td>${esc(o.id)}</td><td>${fmtDate(o.at)}</td><td>${esc(o.source)}</td><td>${money(o.total)}</td><td>${payBadge(o.payment?.status)}</td><td>${prepBadge(o.prepStatus)}</td></tr>`).join('')}
    </table></div>`;
}

// ---------- Caisse ----------
let cart = [];
let cartCategory = 'Tous';

async function caisse() {
  const [products, settings] = await Promise.all([getProducts(), getSettings()]);
  const categories = ['Tous', ...new Set(products.map(p => p.category))];
  const visible = products.filter(p => p.counter && p.active && (cartCategory === 'Tous' || p.category === cartCategory));

  view.innerHTML = `
    <h1>Caisse</h1>
    <div class="pos">
      <div>
        <div class="cats" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
          ${categories.map(c => `<button class="btn ${c === cartCategory ? '' : 'ghost'}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
        <div class="product-grid">
          ${visible.map(p => `<button class="product-tile" data-add="${esc(p.id)}">
            <strong>${esc(p.name)}</strong><div style="color:var(--muted);font-size:13px">${esc(p.category)}</div>
            <div class="price">${money(p.price, settings.currency)}</div></button>`).join('') || '<p>Aucun produit disponible.</p>'}
        </div>
      </div>
      <div class="card" id="cart"></div>
    </div>`;
  renderCart(products, settings);

  view.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { cartCategory = b.dataset.cat; caisse(); });
  view.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    const found = cart.find(l => l.productId === b.dataset.add && !l.options.length);
    if (found) found.qty++; else cart.push({ productId: b.dataset.add, qty: 1, options: [] });
    renderCart(products, settings);
  });
}

function renderCart(products, settings) {
  const byId = Object.fromEntries(products.map(p => [p.id, p]));
  const el = document.getElementById('cart');
  let total = 0;
  const rows = cart.map((l, i) => {
    const p = byId[l.productId];
    const sub = (p ? p.price : 0) * l.qty;
    total += sub;
    return `<div class="cart-line"><div>${esc(p?.name || l.productId)}</div>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="btn ghost" data-dec="${i}" style="min-height:36px;padding:4px 10px">−</button>
        <span>${l.qty}</span>
        <button class="btn ghost" data-inc="${i}" style="min-height:36px;padding:4px 10px">+</button>
        <span style="min-width:90px;text-align:right">${money(sub, settings.currency)}</span>
      </div></div>`;
  }).join('');

  el.innerHTML = `
    <h2 style="margin-top:0">Panier</h2>
    ${rows || '<p style="color:var(--muted)">Panier vide.</p>'}
    <div class="cart-total"><span>Total</span><span>${money(total, settings.currency)}</span></div>
    <label>Mode
      <select id="mode"><option>Sur place</option><option>À emporter</option></select></label>
    <label>Moyen de paiement
      <select id="pay">${settings.paymentMethods.map(m => `<option>${esc(m)}</option>`).join('')}</select></label>
    <label>Commentaire<textarea id="comment" rows="2"></textarea></label>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" id="validate" ${cart.length ? '' : 'disabled'}>Valider la commande</button>
      <button class="btn ghost" id="clear" ${cart.length ? '' : 'disabled'}>Vider</button>
    </div>
    <p style="color:var(--muted);font-size:13px">La commande est enregistrée « en attente de paiement ». Le paiement n'est comptabilisé qu'après confirmation dans la liste des commandes.</p>`;

  el.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => { cart[b.dataset.inc].qty++; renderCart(products, settings); });
  el.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => {
    const l = cart[b.dataset.dec]; l.qty--; if (l.qty <= 0) cart.splice(b.dataset.dec, 1);
    renderCart(products, settings);
  });
  el.querySelector('#clear').onclick = () => {
    if (confirm('Vider le panier ?')) { cart = []; renderCart(products, settings); }
  };
  el.querySelector('#validate').onclick = async () => {
    const btn = el.querySelector('#validate');
    btn.disabled = true;
    try {
      const id = await createOrder({
        source: 'Caisse', staff: staff(),
        mode: el.querySelector('#mode').value,
        lines: cart, payment: { method: el.querySelector('#pay').value, status: 'En attente' },
        comment: el.querySelector('#comment').value
      });
      cart = [];
      notice(`Commande ${id} enregistrée.`);
      caisse();
    } catch (err) {
      notice(err.message, true);
      btn.disabled = false;
    }
  };
}

// ---------- Cuisine ----------
async function cuisine() {
  const orders = (await getOrders())
    .filter(o => !['Terminée', 'Remise au client', 'Annulée'].includes(o.prepStatus))
    .sort((a, b) => a.at.localeCompare(b.at));
  const now = Date.now();

  view.innerHTML = `
    <h1>Cuisine</h1>
    <p style="color:var(--muted)">Caisse et bornes dans une même file, plus anciennes en premier.</p>
    <div class="kitchen">
      ${orders.map(o => {
        const minutes = Math.floor((now - new Date(o.at)) / 60000);
        const cls = o.prepStatus === 'Prête' ? 'ready' : minutes > 10 ? 'urgent' : '';
        return `<div class="card ticket ${cls}">
          <div style="display:flex;justify-content:space-between"><strong>${esc(o.id)}</strong>${prepBadge(o.prepStatus)}</div>
          <div style="color:var(--muted);font-size:13px">${fmtDate(o.at)} · ${minutes} min · ${esc(o.source)}${o.kioskId ? ' (' + esc(o.kioskId) + ')' : ''}</div>
          <ul style="padding-left:18px">${o.lines.map(l => `<li>${l.qty} × ${esc(l.name)}${l.options.length ? ' : ' + esc(l.options.map(x => x.label).join(', ')) : ''}</li>`).join('')}</ul>
          ${o.comment ? `<p><em>${esc(o.comment)}</em></p>` : ''}
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${o.prepStatus === 'Nouvelle commande' ? `<button class="btn" data-st="${esc(o.id)}|En préparation">Prendre en charge</button>` : ''}
            ${o.prepStatus === 'En préparation' ? `<button class="btn" data-st="${esc(o.id)}|Prête">Marquer prête</button>` : ''}
            ${o.prepStatus === 'Prête' ? `<button class="btn" data-st="${esc(o.id)}|Remise au client">Remise au client</button>` : ''}
          </div></div>`;
      }).join('') || '<p>Aucune commande en cours.</p>'}
    </div>`;

  view.querySelectorAll('[data-st]').forEach(b => b.onclick = async () => {
    const [id, status] = b.dataset.st.split('|');
    try { await setPrepStatus(id, status, staff()); cuisine(); }
    catch (err) { notice(err.message, true); }
  });
}

// ---------- Commandes ----------
let orderFilter = { source: 'Toutes', status: 'Toutes', q: '' };

async function commandes() {
  const [orders, settings] = await Promise.all([getOrders(), getSettings()]);
  const list = orders
    .filter(o => orderFilter.source === 'Toutes' || o.source === orderFilter.source)
    .filter(o => orderFilter.status === 'Toutes' || o.prepStatus === orderFilter.status)
    .filter(o => !orderFilter.q || o.id.toLowerCase().includes(orderFilter.q.toLowerCase()))
    .sort((a, b) => b.at.localeCompare(a.at));

  view.innerHTML = `
    <h1>Commandes</h1>
    <div class="card" style="display:flex;gap:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:160px"><label>Recherche<input id="q" value="${esc(orderFilter.q)}" placeholder="CMD-…"></label></div>
      <div style="min-width:150px"><label>Origine<select id="src">${['Toutes', 'Caisse', 'Borne'].map(s => `<option ${s === orderFilter.source ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div>
      <div style="min-width:180px"><label>Préparation<select id="stt"><option>Toutes</option>${PREP_STATUSES.map(s => `<option ${s === orderFilter.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label></div>
    </div>
    <div class="card" style="overflow-x:auto"><table>
      <tr><th>N°</th><th>Date</th><th>Origine</th><th>Produits</th><th>Total</th><th>Paiement</th><th>Préparation</th><th></th></tr>
      ${list.map(o => `<tr>
        <td>${esc(o.id)}</td><td>${fmtDate(o.at)}</td><td>${esc(o.source)}${o.kioskId ? '<br><small>' + esc(o.kioskId) + '</small>' : ''}</td>
        <td>${o.lines.map(l => `${l.qty} × ${esc(l.name)}`).join('<br>')}</td>
        <td>${money(o.total, settings.currency)}</td>
        <td>${payBadge(o.payment?.status)}</td><td>${prepBadge(o.prepStatus)}</td>
        <td>${o.payment?.status === 'En attente' ? `<button class="btn" data-pay="${esc(o.id)}">Confirmer paiement</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="8">Aucune commande.</td></tr>'}
    </table></div>`;

  document.getElementById('q').oninput = (e) => { orderFilter.q = e.target.value; commandes(); };
  document.getElementById('src').onchange = (e) => { orderFilter.source = e.target.value; commandes(); };
  document.getElementById('stt').onchange = (e) => { orderFilter.status = e.target.value; commandes(); };
  view.querySelectorAll('[data-pay]').forEach(b => b.onclick = async () => {
    if (!confirm('Confirmer que le paiement a bien été reçu ?')) return;
    try { await setPaymentStatus(b.dataset.pay, 'Confirmé', staff()); commandes(); }
    catch (err) { notice(err.message, true); }
  });
}

// ---------- Catalogue ----------
async function catalogue() {
  const products = await getProducts();
  view.innerHTML = `
    <h1>Catalogue</h1>
    <div class="card" style="overflow-x:auto"><table>
      <tr><th>Produit</th><th>Catégorie</th><th>Prix</th><th>Coût estimé</th><th>Marge</th><th>Caisse</th><th>Borne</th><th>Actif</th></tr>
      ${products.map(p => `<tr>
        <td>${esc(p.name)}${p.demo ? ' <span class="demo-tag">démo</span>' : ''}</td>
        <td>${esc(p.category)}</td><td>${money(p.price)}</td><td>${money(p.cost)}</td>
        <td>${money(p.price - p.cost)}</td>
        <td><input type="checkbox" data-flag="${esc(p.id)}|counter" ${p.counter ? 'checked' : ''} style="width:auto;min-height:0"></td>
        <td><input type="checkbox" data-flag="${esc(p.id)}|kiosk" ${p.kiosk ? 'checked' : ''} style="width:auto;min-height:0"></td>
        <td><input type="checkbox" data-flag="${esc(p.id)}|active" ${p.active ? 'checked' : ''} style="width:auto;min-height:0"></td>
      </tr>`).join('')}
    </table></div>
    <p style="color:var(--muted)">La modification des prix ne s'applique qu'aux nouvelles commandes ; les ventes passées conservent leur prix.</p>`;

  view.querySelectorAll('[data-flag]').forEach(cb => cb.onchange = async () => {
    const [id, field] = cb.dataset.flag.split('|');
    const p = (await getProducts()).find(x => x.id === id);
    p[field] = cb.checked;
    await dbPut('products', p);
    await audit(staff(), 'Produit modifié', `${id}.${field}=${cb.checked}`);
  });
}

// ---------- Stock ----------
async function stock() {
  const items = await getStock();
  view.innerHTML = `
    <h1>Stock</h1>
    <div class="card" style="overflow-x:auto"><table>
      <tr><th>Ingrédient</th><th>Catégorie</th><th>Quantité</th><th>Minimum</th><th>Statut</th></tr>
      ${items.map(s => {
        const low = s.qty <= s.min;
        return `<tr><td>${esc(s.name)}${s.demo ? ' <span class="demo-tag">démo</span>' : ''}</td><td>${esc(s.category)}</td>
          <td>${s.qty} ${esc(s.unit)}</td><td>${s.min}</td>
          <td>${low ? '<span class="badge warn">Stock faible</span>' : '<span class="badge ready">OK</span>'}</td></tr>`;
      }).join('')}
    </table></div>
    <p style="color:var(--muted)">Les consommations sont déduites automatiquement à la validation des commandes. Les réceptions et inventaires seront ajoutés dans un prochain lot.</p>`;
}

// ---------- Comptabilité ----------
async function compta() {
  const [orders, settings] = await Promise.all([getOrders(), getSettings()]);
  const cur = settings?.currency;
  const confirmed = orders.filter(o => o.payment?.status === 'Confirmé' && o.prepStatus !== 'Annulée');
  const encaissements = confirmed.reduce((s, o) => s + o.total, 0);
  const pendingPay = orders.filter(o => o.payment?.status === 'En attente' && o.prepStatus !== 'Annulée');
  const cogs = await computeCogs(confirmed);
  const opening = Number(settings?.openingBalance || 0);

  view.innerHTML = `
    <h1>Comptabilité</h1>
    <div class="grid">
      ${kpi('Solde initial', money(opening, cur))}
      ${kpi('Encaissements confirmés', money(encaissements, cur))}
      ${kpi('Solde de trésorerie', money(opening + encaissements, cur))}
      ${kpi('Coût des marchandises', money(cogs, cur))}
      ${kpi('Marge brute estimée', money(encaissements - cogs, cur))}
      ${kpi('Paiements en attente', pendingPay.length)}
    </div>
    <div class="notice">Le module de dépenses, salaires et factures fournisseurs n'est pas encore dans cette version : le solde et le résultat ne couvrent donc que les ventes.</div>`;
}

async function computeCogs(confirmed) {
  const products = Object.fromEntries((await getProducts()).map(p => [p.id, p]));
  let total = 0;
  for (const o of confirmed) for (const l of o.lines) total += (products[l.productId]?.cost || 0) * l.qty;
  return total;
}

// ---------- Paramètres ----------
async function parametres() {
  const settings = await getSettings();
  const hasDemo = (await getProducts()).some(p => p.demo);
  view.innerHTML = `
    <h1>Paramètres</h1>
    <div class="card">
      <h2 style="margin-top:0">Données de démonstration</h2>
      <p>${hasDemo ? 'Les données de démonstration sont présentes.' : 'Aucune donnée de démonstration.'}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="seed" ${hasDemo ? 'disabled' : ''}>Charger la démo</button>
        <button class="btn red" id="unseed" ${hasDemo ? '' : 'disabled'}>Supprimer la démo</button>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Sauvegarde</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="export">Exporter les données (JSON)</button>
      </div>
    </div>`;

  document.getElementById('seed').onclick = async () => { await seedDemo(); await audit(staff(), 'Démo chargée', ''); notice('Démo chargée.'); parametres(); };
  document.getElementById('unseed').onclick = async () => {
    if (!confirm('Supprimer uniquement les données de démonstration ?')) return;
    await removeDemo(); await audit(staff(), 'Démo supprimée', ''); notice('Démo supprimée.'); parametres();
  };
  document.getElementById('export').onclick = async () => {
    const data = {
      exportedAt: new Date().toISOString(),
      products: await dbAll('products'), stock: await dbAll('stock'), orders: await dbAll('orders'),
      movements: await dbAll('movements'), audit: await dbAll('audit'), settings: await dbAll('settings')
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cluckin-bell-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
}

// Premier chargement : pas de démo imposée, base vide acceptée.
const initial = (location.hash || '#dashboard').slice(1);
go(routes[initial] ? initial : 'dashboard');
