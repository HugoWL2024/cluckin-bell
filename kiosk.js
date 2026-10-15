// Borne client : menu, panier, commande transmise au système central.
// Ne donne accès à aucune donnée interne. Retour à l'accueil après inactivité.
import { getProducts, getSettings, createOrder } from './orders.js';

const screen = document.getElementById('screen');
const params = new URLSearchParams(location.search);
const kioskId = (params.get('borne') || 'BORNE-1').slice(0, 20);
const IDLE_MS = 60000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `${Number(n || 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} GTA$`;

let products = [];
let settings = null;
let cart = [];
let category = null;
let mode = 'Sur place';
let lastOrderId = null;
let idleTimer = null;

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Retour à l'accueil. Une commande déjà validée n'est jamais effacée, seul le panier en cours l'est.
    cart = [];
    lastOrderId = null;
    home();
  }, IDLE_MS);
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, resetIdle, { passive: true }));

async function load() {
  settings = await getSettings();
  products = (await getProducts()).filter(p => p.kiosk && p.active);
  if (!settings.kioskEnabled) {
    screen.innerHTML = '<div class="panel"><p>Borne momentanément indisponible. Merci de vous adresser au comptoir.</p></div>';
    return false;
  }
  return true;
}

async function home() {
  if (!(await load())) return;
  screen.innerHTML = `
    <div class="panel" style="text-align:center;padding:32px">
      <h2 style="font-size:26px;margin-top:0">Bienvenue</h2>
      <p style="font-size:18px;color:#ccc">Un burger, du poulet, des frites : tout est prêt.</p>
      <button class="big-btn" id="start">Commander</button>
    </div>`;
  screen.querySelector('#start').onclick = () => { category = null; menu(); };
  resetIdle();
}

function menu() {
  const categories = [...new Set(products.map(p => p.category))];
  if (!category) category = categories[0];
  const visible = products.filter(p => p.category === category);
  screen.innerHTML = `
    <div class="cats">${categories.map(c => `<button class="${c === category ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div class="grid-k">
      ${visible.map(p => `<button class="tile" data-p="${esc(p.id)}"><strong>${esc(p.name)}</strong>
        <div class="price">${money(p.price)}</div></button>`).join('') || '<p>Aucun produit dans cette catégorie.</p>'}
    </div>
    <div style="position:sticky;bottom:0;padding:14px 0;display:flex;gap:10px">
      <button class="big-btn" id="to-cart" style="flex:1">Voir le panier (${cartCount()}) · ${money(cartTotal())}</button>
      <button class="tile" id="back" style="min-height:0;width:auto">Accueil</button>
    </div>`;
  screen.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { category = b.dataset.cat; menu(); });
  screen.querySelectorAll('[data-p]').forEach(b => b.onclick = () => detail(b.dataset.p));
  screen.querySelector('#to-cart').onclick = () => review();
  screen.querySelector('#back').onclick = () => { cart = []; home(); };
  resetIdle();
}

function detail(productId) {
  const p = products.find(x => x.id === productId);
  if (!p) return menu();
  const options = p.options || [];
  screen.innerHTML = `
    <div class="panel">
      <h2 style="font-size:26px;margin-top:0">${esc(p.name)}</h2>
      <p style="color:#ccc">${esc(p.description || '')}</p>
      ${options.length ? `<h3>Suppléments</h3>${options.map((o, i) => `
        <label class="tile" style="display:flex;justify-content:space-between;margin-bottom:10px;min-height:0">
          <span><input type="checkbox" data-opt="${i}" style="width:auto;min-height:0;margin-right:10px">${esc(o.label)}</span>
          <span class="price" style="margin:0">+${money(o.price)}</span></label>`).join('')}` : ''}
      <div style="display:flex;align-items:center;gap:14px;justify-content:center;margin:18px 0">
        <button class="tile" id="dec" style="min-height:70px;width:90px;text-align:center">−</button>
        <span id="qty" style="font-size:36px;font-weight:800">1</span>
        <button class="tile" id="inc" style="min-height:70px;width:90px;text-align:center">+</button>
      </div>
      <button class="big-btn" id="add">Ajouter au panier · <span id="line">${money(p.price)}</span></button>
      <p><button class="tile" id="cancel" style="min-height:0;width:100%">Retour au menu</button></p>
    </div>`;

  let qty = 1;
  const update = () => {
    const extra = [...screen.querySelectorAll('[data-opt]')].filter(c => c.checked).reduce((s, c) => s + options[c.dataset.opt].price, 0);
    screen.querySelector('#qty').textContent = qty;
    screen.querySelector('#line').textContent = money((p.price + extra) * qty);
  };
  screen.querySelector('#inc').onclick = () => { qty = Math.min(qty + 1, 20); update(); };
  screen.querySelector('#dec').onclick = () => { qty = Math.max(qty - 1, 1); update(); };
  screen.querySelectorAll('[data-opt]').forEach(c => c.onchange = update);
  screen.querySelector('#add').onclick = () => {
    const chosen = [...screen.querySelectorAll('[data-opt]')].filter(c => c.checked).map(c => options[c.dataset.opt]);
    cart.push({ productId: p.id, qty, options: chosen });
    menu();
  };
  screen.querySelector('#cancel').onclick = () => menu();
  resetIdle();
}

function cartCount() { return cart.reduce((s, l) => s + l.qty, 0); }
function lineTotal(l) {
  const p = products.find(x => x.id === l.productId);
  if (!p) return 0;
  return (p.price + l.options.reduce((s, o) => s + o.price, 0)) * l.qty;
}
function cartTotal() { return cart.reduce((s, l) => s + lineTotal(l), 0); }

function review() {
  if (!cart.length) return menu();
  const methods = settings.paymentMethods;
  screen.innerHTML = `
    <div class="panel">
      <h2 style="font-size:26px;margin-top:0">Votre panier</h2>
      ${cart.map((l, i) => {
        const p = products.find(x => x.id === l.productId);
        return `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #333">
          <div>${l.qty} × ${esc(p?.name || '')}${l.options.length ? '<br><small>+ ' + esc(l.options.map(o => o.label).join(', ')) + '</small>' : ''}</div>
          <div style="display:flex;gap:8px;align-items:center">${money(lineTotal(l))}
            <button class="tile" data-rm="${i}" style="min-height:0;padding:6px 12px">Retirer</button></div></div>`;
      }).join('')}
      <div style="display:flex;justify-content:space-between;font-size:26px;font-weight:900;margin:16px 0">
        <span>Total</span><span style="color:var(--yellow)">${money(cartTotal())}</span></div>
      <h3>Consommation</h3>
      <div style="display:flex;gap:10px;margin-bottom:14px">
        ${['Sur place', 'À emporter'].map(m => `<button class="${m === mode ? 'big-btn' : 'tile'}" data-mode="${esc(m)}" style="flex:1;min-height:64px;font-size:18px">${esc(m)}</button>`).join('')}
      </div>
      <h3>Paiement</h3>
      <p style="color:#ccc;font-size:14px">Votre commande est transmise au comptoir. Le paiement est confirmé par un employé.</p>
      <div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">
        ${methods.map((m, i) => `<button class="tile" data-pay="${i}" style="min-height:64px;text-align:center;font-size:16px" aria-pressed="false">${esc(m)}</button>`).join('')}
      </div>
      <p id="err" style="color:#ff8a80"></p>
      <div style="display:flex;gap:10px;margin-top:18px">
        <button class="tile" id="back" style="min-height:70px;flex:1">Retour</button>
        <button class="big-btn" id="confirm" style="flex:2">Confirmer la commande</button>
      </div>
    </div>`;

  let payIndex = null;
  screen.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { mode = b.dataset.mode; review(); });
  screen.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { cart.splice(b.dataset.rm, 1); review(); });
  screen.querySelectorAll('[data-pay]').forEach(b => b.onclick = () => {
    payIndex = Number(b.dataset.pay);
    screen.querySelectorAll('[data-pay]').forEach(x => {
      const on = Number(x.dataset.pay) === payIndex;
      x.setAttribute('aria-pressed', on);
      x.style.borderColor = on ? 'var(--yellow)' : 'transparent';
    });
  });
  screen.querySelector('#back').onclick = () => menu();
  screen.querySelector('#confirm').onclick = async () => {
    const err = screen.querySelector('#err');
    if (payIndex === null) { err.textContent = 'Choisissez un mode de paiement.'; return; }
    const btn = screen.querySelector('#confirm');
    btn.disabled = true;
    try {
      const id = await createOrder({
        source: 'Borne', kioskId, mode,
        lines: cart,
        payment: { method: methods[payIndex], status: 'En attente' }
      });
      lastOrderId = id;
      cart = [];
      confirmation(id);
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
    }
  };
  resetIdle();
}

function confirmation(id) {
  screen.innerHTML = `
    <div class="panel" style="text-align:center;padding:32px">
      <p style="font-size:20px;margin:0">Votre numéro de commande</p>
      <div class="ticket-no">${esc(id)}</div>
      <p style="font-size:18px">Commande enregistrée. Présentez-vous au comptoir pour régler et récupérer votre commande.</p>
      <p style="color:#ccc;font-size:14px">Commande non payée tant qu'un employé n'a pas confirmé le paiement.</p>
      <button class="big-btn" id="new">Nouvelle commande</button>
    </div>`;
  screen.querySelector('#new').onclick = () => { category = null; mode = 'Sur place'; home(); };
  resetIdle();
  // Après 20 s, retour automatique à l'accueil ; la commande reste enregistrée.
  setTimeout(() => { if (lastOrderId === id) home(); }, 20000);
}

home();
