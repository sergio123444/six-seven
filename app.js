// ================================================
//  ROBLOX SUPPLYZ — Frontend JavaScript
//  Planos, variantes, carrinho, cupom, fluxo PIX
// ================================================

// ── State ────────────────────────────────────────
let currentPlan = 'monthly';
let quantity = 1;
let pollingInterval = null;
let currentPaymentId = null;
let currentOrderId = null;
let currentLicenseToken = null;

// O que vai para o /api/pix/create: [{productId, quantity}]
let pendingItems = [];
let pendingFromCart = false;

// Step de plano (variantes): grupo ativo e destino (compra direta ou carrinho)
let planPick = { variants: null, selected: null, intent: 'buy' };

// Cupom aplicado no checkout (validado de novo no servidor)
let appliedCoupon = null;

// Carrinho persistido por sessão/navegador
let cart = [];
try {
  const saved = JSON.parse(localStorage.getItem('rs_cart') || '[]');
  if (Array.isArray(saved)) {
    cart = saved.filter(i => i && typeof i.productId === 'string')
                .map(i => ({ productId: i.productId, quantity: Math.max(1, Math.min(10, parseInt(i.quantity) || 1)) }));
  }
} catch (e) { cart = []; }

// ── Produtos (espelho do banco, injetado pelo servidor) ──
const bootProducts = (window.BOOT && Array.isArray(window.BOOT.products)) ? window.BOOT.products : [];
const findProduct = (pid) => bootProducts.find(p => p.id === pid) || null;

const prices = {
  monthly:  Number(findProduct('ryu-hub-monthly')?.price)  || 49.90,
  lifetime: Number(findProduct('ryu-hub-lifetime')?.price) || 149.90
};

const productIds = {
  monthly:  'ryu-hub-monthly',
  lifetime: 'ryu-hub-lifetime'
};

const fmtBRL = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');

// Variantes de um produto (mesmo plan_group, ativas)
function getVariants(product) {
  if (!product || !product.plan_group) return null;
  const group = bootProducts.filter(p => p.plan_group === product.plan_group && p.active);
  return group.length > 1 ? group : null;
}

// ════════════════════════════════════════════════
//  CARD DE PREÇO (RYU)
// ════════════════════════════════════════════════

function selectPlan(plan) {
  currentPlan = plan;

  document.getElementById('plan-monthly').classList.toggle('selected', plan === 'monthly');
  document.getElementById('plan-lifetime').classList.toggle('selected', plan === 'lifetime');

  const rm = document.getElementById('radio-monthly');
  const rl = document.getElementById('radio-lifetime');

  rm.classList.toggle('checked', plan === 'monthly');
  rl.classList.toggle('checked', plan === 'lifetime');

  updateTotal();
}

function updateQty(delta) {
  quantity = Math.max(1, Math.min(10, quantity + delta));
  document.getElementById('qty-display').textContent = quantity;
  updateTotal();
}

function updateTotal() {
  document.getElementById('total-display').textContent = fmtBRL(prices[currentPlan] * quantity);
}

// ════════════════════════════════════════════════
//  CARRINHO
// ════════════════════════════════════════════════

function cartSave() {
  try { localStorage.setItem('rs_cart', JSON.stringify(cart)); } catch (e) {}
  renderCartBadge();
}

function renderCartBadge() {
  const n = cart.reduce((acc, i) => acc + i.quantity, 0);
  const badge = document.getElementById('cart-count');
  if (!badge) return;
  badge.textContent = n;
  badge.style.display = n ? 'inline-block' : 'none';
}

function pushToCart(productId, qty) {
  const pid = String(productId);
  qty = Math.max(1, Math.min(10, parseInt(qty) || 1));

  const existing = cart.find(i => i.productId === pid);
  if (existing) {
    existing.quantity = Math.min(10, existing.quantity + qty);
  } else {
    cart.push({ productId: pid, quantity: qty });
  }

  cartSave();
  renderCart();
  toggleCart(true);
}

// Botão 🛒 dos cards — se o produto tem variantes, pergunta o plano antes
function addToCart(productId) {
  const product = findProduct(productId);
  if (!product) return;

  const variants = getVariants(product);
  if (variants) {
    openPlanStep(variants, productId, 'cart');
    return;
  }

  pushToCart(productId, 1);
}

// Botão 🛒 do card de preço do Ryu (usa plano + quantidade selecionados)
function addToCartPlan() {
  pushToCart(productIds[currentPlan], quantity);
}

function cartSetQty(productId, delta) {
  const item = cart.find(i => i.productId === productId);
  if (!item) return;

  item.quantity += delta;
  if (item.quantity <= 0) {
    cart = cart.filter(i => i.productId !== productId);
  } else {
    item.quantity = Math.min(10, item.quantity);
  }

  cartSave();
  renderCart();
}

function cartRemove(productId) {
  cart = cart.filter(i => i.productId !== productId);
  cartSave();
  renderCart();
}

function cartClear() {
  cart = [];
  cartSave();
  renderCart();
}

function cartTotals() {
  let subtotal = 0, units = 0;
  for (const item of cart) {
    const p = findProduct(item.productId);
    if (p) {
      subtotal += p.price * item.quantity;
      units += item.quantity;
    }
  }
  return { subtotal, units };
}

function toggleCart(show) {
  const drawer = document.getElementById('cart-drawer');
  if (!drawer) return;

  const visible = show !== undefined ? show : drawer.style.display === 'none';
  drawer.style.display = visible ? 'block' : 'none';
  if (visible) renderCart();
}

function renderCart() {
  const box = document.getElementById('cart-items');
  const checkoutBtn = document.getElementById('cart-checkout-btn');
  if (!box) return;

  box.innerHTML = '';

  if (!cart.length) {
    const empty = document.createElement('div');
    empty.className = 'cart-empty';
    empty.textContent = 'Carrinho vazio — adicione produtos pela vitrine.';
    box.appendChild(empty);
  }

  for (const item of cart) {
    const p = findProduct(item.productId);
    if (!p) continue;

    const row = document.createElement('div');
    row.className = 'cart-item';

    const info = document.createElement('div');
    info.className = 'cart-item-info';

    const name = document.createElement('div');
    name.className = 'cart-item-name';
    name.textContent = p.name;
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'cart-item-meta';
    meta.textContent = p.plan_label ? `${p.plan_label} · ${fmtBRL(p.price)}/un` : `${fmtBRL(p.price)}/un`;
    info.appendChild(meta);

    const controls = document.createElement('div');
    controls.className = 'cart-item-controls';

    const mkBtn = (text, cls, fn) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = text;
      b.addEventListener('click', fn);
      return b;
    };

    const qty = document.createElement('span');
    qty.className = 'cart-item-qty';
    qty.textContent = item.quantity;

    controls.appendChild(mkBtn('–', 'cart-qty-btn', () => cartSetQty(item.productId, -1)));
    controls.appendChild(qty);
    controls.appendChild(mkBtn('+', 'cart-qty-btn', () => cartSetQty(item.productId, 1)));
    controls.appendChild(mkBtn('✕', 'cart-remove-btn', () => cartRemove(item.productId)));

    row.appendChild(info);
    row.appendChild(controls);
    box.appendChild(row);
  }

  const { subtotal } = cartTotals();
  const totalEl = document.getElementById('cart-total');
  if (totalEl) totalEl.textContent = fmtBRL(subtotal);
  if (checkoutBtn) checkoutBtn.disabled = cart.length === 0;
}

// Checkout do carrinho inteiro — um PIX só
function checkoutCart() {
  if (!cart.length) return;

  pendingItems = cart.map(i => ({ productId: i.productId, quantity: i.quantity }));
  pendingFromCart = true;

  toggleCart(false);
  openEmailStep();
}

// ════════════════════════════════════════════════
//  STEP DE PLANO (variantes / plan_group)
// ════════════════════════════════════════════════

function openPlanStep(variants, preselectId, intent) {
  planPick = { variants, selected: preselectId || variants[0].id, intent };

  const box = document.getElementById('plan-options');
  box.innerHTML = '';

  variants.forEach(v => {
    const opt = document.createElement('button');
    opt.className = 'plan-option' + (v.id === planPick.selected ? ' selected' : '');
    opt.dataset.pid = v.id;

    const label = document.createElement('div');
    label.className = 'plan-option-name';
    label.textContent = v.plan_label || v.name;
    opt.appendChild(label);

    const price = document.createElement('div');
    price.className = 'plan-option-price';
    price.textContent = fmtBRL(v.price);
    opt.appendChild(price);

    opt.addEventListener('click', () => {
      planPick.selected = v.id;
      box.querySelectorAll('.plan-option').forEach(o => o.classList.toggle('selected', o.dataset.pid === v.id));
    });

    box.appendChild(opt);
  });

  const confirm = document.getElementById('plan-confirm-btn');
  confirm.onclick = confirmPlanStep;

  showStep('plan');
  document.getElementById('pix-modal').style.display = 'flex';
}

function confirmPlanStep() {
  if (!planPick.selected) return;

  if (planPick.intent === 'cart') {
    const pid = planPick.selected;
    planPick.variants = null;
    closePixModal();
    pushToCart(pid, 1);
    return;
  }

  // Compra direta com o plano escolhido
  pendingItems = [{ productId: planPick.selected, quantity: 1 }];
  pendingFromCart = false;
  openEmailStep();
}

// ════════════════════════════════════════════════
//  PIX PAYMENT FLOW
// ════════════════════════════════════════════════

// Compra direta do card de preço (Ryu: plano + quantidade)
function handlePixPayment() {
  pendingItems = [{ productId: productIds[currentPlan], quantity }];
  pendingFromCart = false;
  openEmailStep();
}

// Compra direta de um produto — pergunta plano se tiver variantes
function buyProduct(productId) {
  const product = findProduct(productId);
  if (!product) return;

  const variants = getVariants(product);
  if (variants) {
    openPlanStep(variants, productId, 'buy');
    return;
  }

  pendingItems = [{ productId, quantity: 1 }];
  pendingFromCart = false;
  openEmailStep();
}

function openEmailStep() {
  appliedCoupon = null;
  const couponInput = document.getElementById('pix-coupon');
  if (couponInput) couponInput.value = '';
  const feedback = document.getElementById('coupon-feedback');
  if (feedback) { feedback.textContent = ''; feedback.className = 'coupon-feedback'; }

  showStep('email');
  document.getElementById('pix-modal').style.display = 'flex';
}

function closePixModal() {
  document.getElementById('pix-modal').style.display = 'none';
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function showStep(step) {
  const planEl = document.getElementById('pix-step-plan');
  if (planEl) planEl.style.display = step === 'plan' ? 'block' : 'none';
  document.getElementById('pix-step-email').style.display = step === 'email' ? 'block' : 'none';
  document.getElementById('pix-step-qr').style.display    = step === 'qr'    ? 'block' : 'none';
  document.getElementById('pix-step-done').style.display  = step === 'done'  ? 'block' : 'none';
}

// ── Cupom: preview de desconto (servidor valida de novo no create) ──
async function applyCoupon() {
  const input = document.getElementById('pix-coupon');
  const btn = document.getElementById('coupon-apply-btn');
  const feedback = document.getElementById('coupon-feedback');
  const code = input.value.trim();

  if (!code) {
    feedback.textContent = 'Digite um código de cupom.';
    feedback.className = 'coupon-feedback err';
    return;
  }

  btn.disabled = true;
  btn.textContent = '…';

  try {
    const res = await fetch('/api/coupons/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = await res.json();

    if (!data.valid) {
      appliedCoupon = null;
      feedback.textContent = data.reason || 'Cupom inválido.';
      feedback.className = 'coupon-feedback err';
    } else {
      appliedCoupon = data.coupon;

      // Estimativa local (valor final vem calculado do servidor no create)
      const subtotal = pendingItems.reduce((acc, i) => {
        const p = findProduct(i.productId);
        return acc + (p ? p.price * i.quantity : 0);
      }, 0);

      let est;
      if (data.coupon.type === 'percent') {
        est = subtotal * data.coupon.value / 100;
      } else {
        est = Math.min(data.coupon.value, subtotal);
      }

      const label = data.coupon.type === 'percent'
        ? `−${data.coupon.value}%` : `−${fmtBRL(data.coupon.value)}`;

      feedback.textContent = `✓ ${data.coupon.code} aplicado (${label}) — total estimado: ${fmtBRL(Math.max(subtotal - est, 1))}`;
      feedback.className = 'coupon-feedback ok';
    }
  } catch (err) {
    appliedCoupon = null;
    feedback.textContent = 'Erro de conexão. Tente de novo.';
    feedback.className = 'coupon-feedback err';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Aplicar';
  }
}

async function submitPixEmail(btn) {
  const email = document.getElementById('pix-email').value.trim();

  if (!email || !email.includes('@')) {
    alert('Por favor, insira um e-mail válido.');
    return;
  }

  if (!pendingItems.length) {
    alert('Nenhum item selecionado.');
    return;
  }

  const originalText = btn.textContent;
  btn.textContent = 'Gerando...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/pix/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: pendingItems,
        email,
        coupon: appliedCoupon ? appliedCoupon.code : null
      })
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      alert(data.error || 'Erro ao gerar PIX. Tente novamente.');
      btn.textContent = originalText;
      btn.disabled = false;
      return;
    }

    // Guarda prova de compra para buscar as licenças ao aprovar
    currentPaymentId    = data.payment.id;
    currentOrderId      = data.payment.orderId;
    currentLicenseToken = data.payment.licenseToken;

    // Pedido criado com sucesso: carrinho cumpriu o papel
    if (pendingFromCart) {
      cartClear();
      pendingFromCart = false;
    }
    pendingItems = [];

    showStep('qr');

    // Descrição + total (com desconto do cupom já embutido)
    let descText = `${data.payment.description} — ${fmtBRL(data.payment.total)}`;
    if (data.payment.discount > 0) {
      descText += ` (cupom: −${fmtBRL(data.payment.discount)})`;
    }
    document.getElementById('pix-desc-text').textContent = descText;

    // QR Code image
    const qrContainer = document.getElementById('pix-qr-image');
    if (data.payment.pix.qr_code_base64) {
      qrContainer.innerHTML = `<img src="data:image/png;base64,${data.payment.pix.qr_code_base64}" alt="QR Code PIX">`;
    } else {
      qrContainer.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted); font-size:13px;">QR Code não disponível.<br>Use o código abaixo.</div>';
    }

    // Copia e cola code
    document.getElementById('pix-code').value = data.payment.pix.qr_code || 'Código não disponível';

    startPolling();

  } catch (err) {
    console.error('Erro:', err);
    alert('Erro de conexão. Verifique se o servidor está rodando.');
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

function copyPixCode(btn) {
  const input = document.getElementById('pix-code');
  input.select();
  navigator.clipboard.writeText(input.value).then(() => {
    btn.textContent = 'Copiado!';
    btn.style.background = '#22c55e';
    setTimeout(() => {
      btn.textContent = 'Copiar';
      btn.style.background = '';
    }, 2000);
  });
}

// ── Poll payment status ──────────────────────────
function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);

  pollingInterval = setInterval(async () => {
    if (!currentPaymentId) return;

    try {
      const res = await fetch(`/api/pix/status/${currentPaymentId}`);
      const data = await res.json();

      const statusEl = document.getElementById('pix-status');

      if (data.status === 'approved') {
        clearInterval(pollingInterval);
        pollingInterval = null;
        showStep('done');
        fetchLicenses();
      } else if (data.status === 'rejected' || data.status === 'cancelled') {
        clearInterval(pollingInterval);
        pollingInterval = null;
        statusEl.innerHTML = '❌ Pagamento rejeitado. Tente novamente.';
        statusEl.style.color = '#ef4444';
        statusEl.style.background = 'rgba(239,68,68,0.08)';
        statusEl.style.borderColor = 'rgba(239,68,68,0.2)';
      }
    } catch (err) {
      console.error('Erro ao verificar status:', err);
    }
  }, 5000);
}

// ── Buscar licenças do pedido aprovado ───────────
async function fetchLicenses() {
  const box = document.getElementById('license-keys');
  if (!box) return;

  if (!currentOrderId || !currentLicenseToken) {
    box.innerHTML = '<div class="key-error">Prova de compra indisponível nesta sessão — contate o suporte.</div>';
    return;
  }

  box.innerHTML = '<div class="key-loading">Carregando suas chaves…</div>';

  try {
    const res = await fetch(`/api/orders/${currentOrderId}/licenses?token=${encodeURIComponent(currentLicenseToken)}`);
    const data = await res.json();

    if (!res.ok) {
      box.innerHTML = `<div class="key-error">${data.error || 'Não foi possível carregar as chaves.'}</div>`;
      return;
    }

    box.innerHTML = '';

    for (const lic of data.licenses) {
      const row = document.createElement('div');
      row.className = 'key-row';

      const meta = document.createElement('div');
      meta.className = 'key-product';
      meta.textContent = lic.product;
      row.appendChild(meta);

      const line = document.createElement('div');
      line.className = 'key-line';

      const code = document.createElement('code');
      code.className = 'key-value';
      code.textContent = lic.key;

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn-copy';
      copyBtn.textContent = 'Copiar';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(lic.key).then(() => {
          copyBtn.textContent = 'Copiado!';
          copyBtn.style.background = '#22c55e';
          setTimeout(() => {
            copyBtn.textContent = 'Copiar';
            copyBtn.style.background = '';
          }, 2000);
        });
      });

      line.appendChild(code);
      line.appendChild(copyBtn);
      row.appendChild(line);

      const exp = document.createElement('div');
      exp.className = 'key-expires';
      exp.textContent = lic.expiresAt
        ? `Expira em ${String(lic.expiresAt).slice(0, 10).split('-').reverse().join('/')}`
        : 'Lifetime';
      row.appendChild(exp);

      box.appendChild(row);
    }

    if (data.licenses.length === 0) {
      box.innerHTML = '<div class="key-loading">Licenças sendo geradas… atualize em instantes.</div>';
    }

  } catch (err) {
    console.error('Erro ao buscar licenças:', err);
    box.innerHTML = '<div class="key-error">Erro de conexão ao buscar as chaves.</div>';
  }
}

// ── Boot ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('pix-modal');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePixModal();
  });

  // Sincroniza carrinho com o que já existia no navegador
  renderCartBadge();
});
