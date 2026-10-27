// ================================================
//  ROBLOX SUPPLYZ — Server Principal v2.0
//  Google OAuth + Mercado Pago PIX + SQLite + Admin
// ================================================
require('dotenv').config();

const express       = require('express');
const session       = require('express-session');
const passport      = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const helmet        = require('helmet');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { v4: uuidv4 } = require('uuid');
const multer        = require('multer');
const path          = require('path');
const fs            = require('fs');

// Módulos internos
const { initDatabase }  = require('./db/database');
const models            = require('./db/models');
const { generalLimiter, pixLimiter, authLimiter, webhookLimiter, chatLimiter } = require('./middleware/rateLimiter');
const { requireAuth, requireAdmin, validateWebhookSignature } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Banco de dados ───────────────────────────────
const db = initDatabase();

// Pool: anexa contadores de keys + vendas a produtos
function decorateProducts(list) {
  return list.map(p => {
    const sales = models.getSalesCount(db, p);
    return p.key_pool
      ? { ...p, ...models.getPoolStats(db, p.id), sales }
      : { ...p, sales };
  });
}

// ── View engine ──────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Middlewares globais ──────────────────────────
// Atrás de proxy (Railway/Render/Nginx): confia no X-Forwarded-For do 1º salto
// — sem isso, todos os IPs parecem o mesmo e o rate limit perde sentido
app.set('trust proxy', 1);

// Headers de segurança (X-Content-Type-Options, X-Frame-Options etc.)
// CSP fica fora por ora: páginas têm <script> inline que a CSP bloquearia
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(generalLimiter);

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-troque-em-producao',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,                                     // JS não lê o cookie de sessão
    sameSite: 'lax',                                    // mitiga CSRF cross-site
    secure: process.env.NODE_ENV === 'production',      // HTTPS only quando no ar
    maxAge: 24 * 60 * 60 * 1000                         // 24h
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// ═══════════════════════════════════════════════════
//  GOOGLE OAUTH 2.0
// ═══════════════════════════════════════════════════

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = models.getUserById(db, id);
  done(null, user || null);
});

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID !== 'SEU_CLIENT_ID_AQUI') {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  '/auth/google/callback'
  }, (accessToken, refreshToken, profile, done) => {
    const googleProfile = {
      id:          profile.id,
      displayName: profile.displayName,
      email:       profile.emails?.[0]?.value,
      avatar:      profile.photos?.[0]?.value
    };

    // Upsert no banco
    const user = models.findOrCreateGoogleUser(db, googleProfile);

    // Auto-promover a admin se for o email configurado
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail && user.email === adminEmail && user.role !== 'admin') {
      models.setUserRole(db, user.id, 'admin');
      user.role = 'admin';
    }

    return done(null, user);
  }));
  console.log('✅ Google OAuth configurado');
} else {
  console.warn('⚠️  Google OAuth NÃO configurado — preencha GOOGLE_CLIENT_ID no .env');
}

// Rotas de autenticação
app.get('/auth/google', authLimiter,
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=login' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ logged: false });
  res.json({ logged: true, user: req.user });
});

// ═══════════════════════════════════════════════════
//  UPLOAD DE IMAGENS (admin)
// ═══════════════════════════════════════════════════

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase().slice(0, 10);
      cb(null, uuidv4() + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Formato inválido — use png, jpg, webp ou gif.'), ok);
  }
});

app.post('/admin/api/upload', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
  res.json({ success: true, url: '/uploads/' + req.file.filename });
});

// ═══════════════════════════════════════════════════
//  MERCADO PAGO — PIX
// ═══════════════════════════════════════════════════

let mpClient  = null;
let mpPayment = null;

if (process.env.MERCADO_PAGO_ACCESS_TOKEN && process.env.MERCADO_PAGO_ACCESS_TOKEN !== 'SEU_ACCESS_TOKEN_AQUI') {
  mpClient = new MercadoPagoConfig({
    accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN
  });
  mpPayment = new Payment(mpClient);
  console.log('✅ Mercado Pago configurado');
} else {
  console.warn('⚠️  Mercado Pago NÃO configurado — preencha MERCADO_PAGO_ACCESS_TOKEN no .env');
}

// ── Criar pagamento PIX (multi-item + cupom) ─────
// Body: { items: [{productId, quantity}], email, coupon } — o formato legado
// { productId, quantity } também funciona (vira 1 item).

// Expiração do QR em minutos (a varredura cancela o que passar disso)
const PIX_EXP_MIN = Math.max(5, parseInt(process.env.PIX_EXPIRATION_MINUTES || '30', 10));

app.post('/api/pix/create', pixLimiter, async (req, res) => {
  try {
    if (!mpPayment) {
      return res.status(503).json({
        error: 'Mercado Pago não configurado. Preencha o .env com seu Access Token.'
      });
    }

    // Normalizar itens (carrinho ou produto único legado)
    let rawItems = Array.isArray(req.body.items) ? req.body.items
      : [{ productId: req.body.productId, quantity: req.body.quantity }];

    rawItems = rawItems
      .map(i => ({
        productId: String(i.productId || '').trim(),
        quantity:  Math.max(1, Math.min(10, parseInt(i.quantity) || 1))
      }))
      .filter(i => i.productId)
      .slice(0, 20);

    if (!rawItems.length) {
      return res.status(400).json({ error: 'Nenhum item no pedido.' });
    }

    // Vai consolidar produtos repetidos em uma linha só
    const byProduct = new Map();
    for (const i of rawItems) {
      byProduct.set(i.productId, (byProduct.get(i.productId) || 0) + i.quantity);
    }

    const email = String(req.body.email || req.user?.email || '').trim();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'E-mail inválido.' });
    }

    // Validar produtos e montar linhas com preço do banco (servidor é autoridade)
    const lines = [];
    for (const [pid, qty] of byProduct) {
      const product = models.getProductById(db, pid);
      if (!product)        return res.status(400).json({ error: `Produto "${pid}" não encontrado.` });
      if (!product.active) return res.status(400).json({ error: `"${product.name}" está indisponível no momento.` });
      lines.push({ product, quantity: Math.min(qty, 10) });
    }

    let subtotal = 0;
    for (const l of lines) subtotal += l.product.price * l.quantity;
    subtotal = Math.round(subtotal * 100) / 100;

    // Cupom (opcional) — desconto calculado no servidor, nunca no cliente
    let coupon = null;
    let discount = 0;
    const couponCode = String(req.body.coupon || '').trim();
    if (couponCode) {
      const check = models.validateCoupon(db, couponCode);
      if (!check.valid) return res.status(400).json({ error: check.reason });
      coupon = check.coupon;
      discount = models.computeDiscount(subtotal, coupon);
    }

    const total        = parseFloat((subtotal - discount).toFixed(2));
    const totalUnits   = lines.reduce((acc, l) => acc + l.quantity, 0);
    const description  = lines.map(l => `${l.product.name} x${l.quantity}`).join(' + ').slice(0, 120);

    // Criar pedido (token de entrega fecha IDOR na rota de licenças)
    const licenseToken = uuidv4();
    const order = models.createOrder(db, {
      email,
      productId:   lines[0].product.id,  // FK legada — itens completos ficam em order_items
      quantity:    totalUnits,
      total,
      userId:      req.user?.id || null,
      licenseToken,
      description,
      couponCode:  coupon ? coupon.code : null,
      discount
    });

    models.createOrderItems(db, order.id, lines.map(l => ({
      product_id:   l.product.id,
      product_name: l.product.name,
      unit_price:   l.product.price,
      quantity:     l.quantity
    })));

    // Reservar estoque/keys de cada linha — falha numa, desfaz tudo
    for (const l of lines) {
      if (l.product.key_pool) {
        const reserved = models.reserveKeys(db, l.product.id, l.quantity, order.id);
        if (!reserved) {
          models.updateOrderStatus(db, order.id, 'cancelled');
          releaseOrderStock(order);
          return res.status(400).json({ error: `Estoque insuficiente para "${l.product.name}".` });
        }
      } else {
        const stockCheck = models.decrementStock(db, l.product.id, l.quantity);
        if (!stockCheck.success) {
          models.updateOrderStatus(db, order.id, 'cancelled');
          releaseOrderStock(order);
          return res.status(400).json({ error: `Estoque insuficiente para "${l.product.name}".` });
        }
      }
    }

    try {
      // Criar pagamento no Mercado Pago
      const idempotencyKey = uuidv4();

      const paymentData = {
        transaction_amount: total,
        description: description.slice(0, 100),
        payment_method_id: 'pix',
        payer: { email },
        external_reference: String(order.id),
        date_of_expiration: new Date(Date.now() + PIX_EXP_MIN * 60 * 1000).toISOString(),
        // notification_url: 'https://seusite.com/api/pix/webhook'
      };

      const result = await mpPayment.create({
        body: paymentData,
        requestOptions: { idempotencyKey }
      });

      // Atualizar pedido com payment_id do Mercado Pago
      db.prepare('UPDATE orders SET payment_id = ? WHERE id = ?')
        .run(String(result.id), order.id);

      const pixData = result.point_of_interaction?.transaction_data;

      return res.json({
        success: true,
        payment: {
          id:           result.id,
          orderId:      order.id,
          licenseToken: licenseToken,
          status:       result.status,
          total:        total,
          subtotal:     subtotal,
          discount:     discount,
          description:  description,
          pix: {
            qr_code:        pixData?.qr_code || null,
            qr_code_base64: pixData?.qr_code_base64 || null,
            ticket_url:     pixData?.ticket_url || null
          },
          expires_at: result.date_of_expiration
        }
      });
    } catch (mpErr) {
      // Rollback: MP falhou → cancela o pedido e devolve o que foi reservado
      models.updateOrderStatus(db, order.id, 'cancelled');
      releaseOrderStock(order);
      console.error(`Erro MP (rollback pedido #${order.id}):`, mpErr.message);
      return res.status(502).json({
        error: 'Falha ao gerar pagamento no Mercado Pago. Tente novamente.',
        details: process.env.NODE_ENV === 'production' ? undefined : mpErr.message
      });
    }

  } catch (err) {
    console.error('Erro ao criar PIX:', err);
    res.status(500).json({
      error: 'Erro ao gerar pagamento PIX.',
      details: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
  }
});

// ── Validar cupom (preview de desconto no checkout) ─
app.post('/api/coupons/check', (req, res) => {
  const check = models.validateCoupon(db, req.body.code);
  if (!check.valid) return res.json({ valid: false, reason: check.reason });

  res.json({
    valid: true,
    coupon: {
      code:  check.coupon.code,
      type:  check.coupon.type,
      value: check.coupon.value
    }
  });
});

// ── Verificar status do pagamento ────────────────
app.get('/api/pix/status/:paymentId', async (req, res) => {
  try {
    if (!mpPayment) {
      return res.status(503).json({ error: 'Mercado Pago não configurado.' });
    }

    const result = await mpPayment.get({ id: req.params.paymentId });

    // Se aprovado, processar
    if (result.status === 'approved') {
      processApprovedPayment(String(result.id));
    } else if (result.status === 'rejected' || result.status === 'cancelled') {
      // Sem webhook, esse caminho é quem encerra o ciclo de vida do pedido
      const order = models.getOrderByPaymentId(db, String(result.id));
      if (order && order.status === 'pending') {
        models.updateOrderStatus(db, order.id, result.status);
        releaseOrderStock(order);
      }
    }

    res.json({
      id:     result.id,
      status: result.status,
      detail: result.status_detail
    });

  } catch (err) {
    console.error('Erro ao consultar status:', err);
    res.status(500).json({ error: 'Erro ao consultar pagamento.' });
  }
});

// ── Webhook do Mercado Pago ──────────────────────
app.post('/api/pix/webhook',
  webhookLimiter,
  validateWebhookSignature(process.env.MERCADO_PAGO_WEBHOOK_SECRET),
  async (req, res) => {
    try {
      const { type, data } = req.body;

      if (type === 'payment') {
        const paymentId = data?.id;
        if (paymentId && mpPayment) {
          const payment = await mpPayment.get({ id: paymentId });
          console.log(`💰 Webhook: Pagamento #${paymentId} → ${payment.status}`);

          if (payment.status === 'approved') {
            processApprovedPayment(String(paymentId));
          } else if (payment.status === 'rejected' || payment.status === 'cancelled') {
            const order = models.getOrderByPaymentId(db, String(paymentId));
            if (order && order.status === 'pending') {
              models.updateOrderStatus(db, order.id, payment.status);
              releaseOrderStock(order);
              console.log(`❌ Pedido #${order.id} → ${payment.status} (estoque devolvido)`);
            }
          }
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('Erro no webhook:', err);
      res.sendStatus(500);
    }
  }
);

// ── Devolver o estoque de um pedido (multi-item) ─
function releaseOrderStock(order) {
  const items = models.getOrderItems(db, order.id);

  // Pedido antigo (sem order_items): caminho de produto único
  if (!items.length) {
    const product = models.getProductById(db, order.product_id);
    if (product && product.key_pool) {
      return models.releaseOrderKeys(db, order.id);
    }
    return models.restoreStock(db, order.product_id, order.quantity);
  }

  // Keys reservadas do pedido inteiro voltam ao pool
  models.releaseOrderKeys(db, order.id);

  // Estoque numérico volta item a item
  for (const item of items) {
    const product = models.getProductById(db, item.product_id);
    if (product && !product.key_pool) {
      models.restoreStock(db, item.product_id, item.quantity);
    }
  }
}

// ── Entregar as licenças de um pedido aprovado ─────────
// Multi-item: percorre order_items; pool consome key do fornecedor,
// gerado cria RYU-XXXX-XXXX-XXXX-XXXX por unidade.
function deliverOrderLicenses(order) {
  const items = models.getOrderItems(db, order.id);

  // Pedido antigo sem itens cadastrados: um item derivado do legado
  const list = items.length
    ? items
    : [{ product_id: order.product_id, quantity: order.quantity }];

  let delivered = 0;

  for (const item of list) {
    const isLifetime = item.product_id.includes('lifetime');
    const expiresAt  = isLifetime
      ? null
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 dias

    const product = models.getProductById(db, item.product_id);

    if (product && product.key_pool) {
      const contents = models.finalizeOrderKeys(db, order.id, item.product_id);
      for (const content of contents) {
        try {
          models.createLicense(db, {
            orderId:   order.id,
            productId: item.product_id,
            email:     order.email,
            expiresAt,
            licenseKey: content
          });
          delivered++;
        } catch (e) {
          console.warn(`⚠️  Key duplicada ignorada no pedido #${order.id}`);
        }
      }
      if (contents.length < item.quantity) {
        console.warn(`⚠️  Pedido #${order.id}: ${contents.length}/${item.quantity} keys de "${item.product_id}" entregues (pool insuficiente)`);
      }

      // Aviso de pool baixo/esgotado depois de cada key consumida
      notifyLowPool(product, models.getPoolStats(db, item.product_id).available);
      continue;
    }

    for (let i = 0; i < item.quantity; i++) {
      const license = models.createLicense(db, {
        orderId:   order.id,
        productId: item.product_id,
        email:     order.email,
        expiresAt
      });
      console.log(`🔑 Licença gerada: ${license.license_key} → ${order.email}`);
      delivered++;
    }
  }

  // Cupom só consome uso quando o pagamento realmente aprova
  if (order.coupon_code) {
    models.incrementCouponUse(db, order.coupon_code);
    console.log(`🎟️  Cupom ${order.coupon_code} consumido (pedido #${order.id})`);
  }

  return delivered;
}

// ── Processar pagamento aprovado ─────────────────
function processApprovedPayment(paymentId) {
  const order = models.getOrderByPaymentId(db, paymentId);

  if (!order) {
    console.warn(`⚠️  Pedido não encontrado para payment_id: ${paymentId}`);
    return;
  }

  const tx = db.transaction(() => {
    // Guard atômico: só pendente pode virar aprovado — pedido já cancelado
    // pela varredura (PIX pago atrasado) NÃO entrega key de novo.
    const flip = db.prepare(`
      UPDATE orders
      SET status = 'approved', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
    `).run(order.id);

    if (flip.changes === 0) return false; // webhook e polling podem chegar juntos

    deliverOrderLicenses(order);
    return true;
  });

  if (tx()) {
    console.log(`✅ Pedido #${order.id} APROVADO — licenças entregues`);
    notifySale(order);
  }
}

// ═══════════════════════════════════════════════════
//  DISCORD — notificações da loja (webhook)
//  Configure DISCORD_WEBHOOK_URL no .env para ativar.
// ═══════════════════════════════════════════════════
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

function discordPing(embed) {
  if (!DISCORD_WEBHOOK_URL) return;

  fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Roblox Supplyz', embeds: [embed] })
  }).catch(err => console.warn('[DISCORD] webhook falhou:', err.message));
}

const brl = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');

// 💰 venda aprovada (webhook, polling ou varredura — todos chegam aqui)
function notifySale(order) {
  const fields = [
    { name: 'Pedido',   value: `#${order.id}`,                          inline: true },
    { name: 'Total',    value: brl(order.total),                        inline: true },
    { name: 'Produtos', value: order.description || order.product_name, inline: false }
  ];
  if (order.coupon_code) {
    fields.push({ name: 'Cupom', value: `${order.coupon_code} (−${brl(order.discount || 0)})`, inline: true });
  }

  discordPing({
    title: '💰 Venda aprovada',
    color: 0x22c55e,
    fields,
    footer: { text: order.email }
  });
}

// 🏷️ pool baixo ou esgotado — avisa uma vez por nível (memória do processo)
const poolAlerted = new Map();

function notifyLowPool(product, available) {
  if (available > 2) {
    poolAlerted.delete(product.id); // reabasteceu: a próxima queda avisa de novo
    return;
  }

  const last = poolAlerted.get(product.id);
  if (last !== undefined && available >= last) return; // já avisou nesse nível
  poolAlerted.set(product.id, available);

  const esgotado = available === 0;
  discordPing({
    title: esgotado ? '🚨 POOL ESGOTADO' : '🏷️ Pool acabando',
    color: esgotado ? 0xef4444 : 0xf97316,
    description:
      `**${product.name}** (\`${product.id}\`): ` +
      (esgotado
        ? '**0 keys** restantes — vendas desse item estão paradas!'
        : available === 1
          ? 'resta apenas **1 key** no pool.'
          : `restam **${available} keys** no pool.`) +
      '\nReabasteça pelo painel admin → **POOL DE KEYS**.'
  });
}

// 💬 cliente mandou mensagem no chat de suporte
function notifyCustomerMessage(order, body) {
  discordPing({
    title: '💬 Cliente falou no chat',
    color: 0x3b82f6,
    fields: [
      { name: 'Pedido',   value: `#${order.id} — ${order.description || order.product_name}`, inline: false },
      { name: 'Mensagem', value: body.slice(0, 300), inline: false }
    ],
    footer: { text: order.email }
  });
}

// ── Validar licença (API pública) ────────────────
app.get('/api/license/validate/:key', (req, res) => {
  const result = models.validateLicense(db, req.params.key);
  res.json(result);
});

// ── Licenças do pedido (prova de compra via token) ──
// Token sai só na resposta do /api/pix/create — quem não comprou não lê key.
app.get('/api/orders/:id/licenses', (req, res) => {
  const orderId = parseInt(req.params.id);
  const order   = models.getOrderById(db, orderId);

  if (!order || !order.license_token || order.license_token !== String(req.query.token || '')) {
    return res.status(404).json({ error: 'Pedido não encontrado.' });
  }

  if (order.status !== 'approved') {
    return res.status(409).json({ error: 'Pagamento ainda não aprovado.', status: order.status });
  }

  res.json({
    orderId:     order.id,
    productName: order.product_name,
    quantity:    order.quantity,
    licenses:    models.getLicensesByOrderId(db, order.id).map(l => ({
      key:       l.license_key,
      status:    l.status,
      expiresAt: l.expires_at
    }))
  });
});

// ── Autoriza acesso ao chat do pedido: sessão (email casa) OU token de compra ──
function chatOrderAuth(req) {
  const order = models.getOrderById(db, parseInt(req.params.id));
  if (!order) return null;

  const bySession = req.user && req.user.email === order.email;
  const token     = String(req.query.token || '').trim();
  const byToken   = order.license_token && token && token === order.license_token;

  return (bySession || byToken) ? order : null;
}

// ── Chat do pedido (cliente) ─────────────────────
app.get('/api/orders/:id/chat', (req, res) => {
  const order = chatOrderAuth(req);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

  const thread = models.getOrCreateThread(db, order.id);
  const after  = parseInt(req.query.after) || 0;
  const messages = models.getMessages(db, thread.id, after);
  models.markThreadRead(db, thread.id, 'customer');

  res.json({
    threadId:    thread.id,
    status:      thread.status,
    orderId:     order.id,
    productName: order.product_name,
    messages
  });
});

app.post('/api/orders/:id/chat', chatLimiter, (req, res) => {
  const order = chatOrderAuth(req);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Mensagem vazia.' });

  const thread = models.getOrCreateThread(db, order.id);
  if (thread.status === 'closed') {
    return res.status(409).json({ error: 'Chat encerrado pelo suporte.' });
  }

  const message = models.addMessage(db, thread.id, 'customer', body);
  notifyCustomerMessage(order, body);
  res.json({ message });
});

// ── Minhas licenças (usuário logado) ─────────────
app.get('/api/my/licenses', requireAuth, (req, res) => {
  const licenses = models.getLicensesByEmail(db, req.user.email);
  res.json(licenses);
});

// ── Meus pedidos (usuário logado) ────────────────
app.get('/api/my/orders', requireAuth, (req, res) => {
  const orders = models.getOrdersByEmail(db, req.user.email);
  res.json(orders);
});

// ═══════════════════════════════════════════════════
//  ADMIN PANEL
// ═══════════════════════════════════════════════════

// Página admin
app.get('/admin', requireAdmin, (req, res) => {
  const statusFilter = req.query.status || 'all';
  const stats    = models.getOrderStats(db);
  const orders   = models.getAllOrders(db, {
    limit: 50,
    status: statusFilter !== 'all' ? statusFilter : undefined
  });
  const products = decorateProducts(models.getAllProducts(db));
  const threads  = models.listThreads(db);
  const coupons  = models.getAllCoupons(db);
  const licenses = db.prepare(`
    SELECT l.*, p.name AS product_name
    FROM licenses l
    JOIN products p ON p.id = l.product_id
    ORDER BY l.created_at DESC
    LIMIT 20
  `).all();

  res.render('admin', {
    user: req.user,
    stats,
    orders,
    products,
    licenses,
    threads,
    coupons,
    statusFilter
  });
});

// Admin API — Aprovar pedido manualmente
app.post('/admin/api/orders/:id/approve', requireAdmin, (req, res) => {
  const orderId = parseInt(req.params.id);
  const order = models.getOrderById(db, orderId);

  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (order.status !== 'pending') {
    return res.status(400).json({ error: 'Só é possível aprovar pedidos pendentes.' });
  }

  models.updateOrderStatus(db, orderId, 'approved');
  deliverOrderLicenses(order);

  console.log(`[ADMIN] Pedido #${orderId} aprovado manualmente por ${req.user.email}`);
  res.json({ success: true });
});

// Admin API — Cancelar pedido
app.post('/admin/api/orders/:id/cancel', requireAdmin, (req, res) => {
  const orderId = parseInt(req.params.id);
  const order = models.getOrderById(db, orderId);

  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

  const wasPending = order.status === 'pending';
  models.updateOrderStatus(db, orderId, 'cancelled');
  if (wasPending) {
    releaseOrderStock(order);
  }
  console.log(`[ADMIN] Pedido #${orderId} cancelado por ${req.user.email}`);
  res.json({ success: true });
});

// Admin API — Toggle produto ativo/inativo
app.post('/admin/api/products/:id/toggle', requireAdmin, (req, res) => {
  models.toggleProductActive(db, req.params.id);
  res.json({ success: true });
});

// Admin API — Atualizar estoque
app.post('/admin/api/products/:id/stock', requireAdmin, (req, res) => {
  const stock = parseInt(req.body.stock);
  if (isNaN(stock)) return res.status(400).json({ error: 'Estoque inválido.' });
  models.updateProductStock(db, req.params.id, stock);
  res.json({ success: true });
});

// Admin API — Colar lote de keys no pool (uma por linha)
app.post('/admin/api/products/:id/keys', requireAdmin, (req, res) => {
  const product = models.getProductById(db, req.params.id);
  if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });

  const lines = String(req.body.keys || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!lines.length) return res.status(400).json({ error: 'Nenhuma key enviada.' });
  if (lines.length > 500) return res.status(400).json({ error: 'Máximo de 500 keys por lote.' });

  const added = models.addKeys(db, req.params.id, lines);
  console.log(`[ADMIN] ${added} key(s) adicionadas a "${req.params.id}" por ${req.user.email}`);
  res.json({ success: true, added });
});

// Admin API — Criar produto
app.post('/admin/api/products/create', requireAdmin, (req, res) => {
  const name        = String(req.body.name || '').trim().slice(0, 80);
  const description = String(req.body.description || '').trim().slice(0, 300) || null;
  const image       = String(req.body.image || '').trim().slice(0, 500) || null;
  const price       = parseFloat(req.body.price);
  const keyPool     = req.body.key_pool ? 1 : 0;
  const planGroup   = String(req.body.plan_group || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || null;
  const planLabel   = String(req.body.plan_label || '').trim().slice(0, 30) || null;

  // ID: usa o enviado ou deriva do nome (slug limpo)
  const slug = (s) => String(s).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const id = slug(req.body.id || name);

  if (!name)               return res.status(400).json({ error: 'Nome é obrigatório.' });
  if (!id)                 return res.status(400).json({ error: 'ID inválido.' });
  if (!(price > 0))        return res.status(400).json({ error: 'Preço inválido.' });
  if (models.getProductById(db, id)) {
    return res.status(409).json({ error: `Já existe um produto com o ID "${id}".` });
  }

  let stock = -1; // gerado/ilimitado por padrão
  if (keyPool) {
    stock = 0; // pool deriva do product_keys
  } else if (req.body.stock !== undefined && req.body.stock !== '' && req.body.stock !== null) {
    const s = parseInt(req.body.stock);
    if (isNaN(s) || s < -1) return res.status(400).json({ error: 'Estoque inválido.' });
    stock = s;
  }

  const product = models.createProduct(db, {
    id, name, price, stock,
    key_pool:    keyPool,
    description, image,
    plan_group:  planGroup,
    plan_label:  planLabel
  });

  console.log(`[ADMIN] Produto "${id}" criado por ${req.user.email}`);
  res.json({ success: true, product });
});

// Admin API — Editar produto (dados de vitrine)
app.post('/admin/api/products/:id/update', requireAdmin, (req, res) => {
  const id = req.params.id;
  const product = models.getProductById(db, id);
  if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });

  const name        = String(req.body.name        ?? product.name).trim().slice(0, 80) || product.name;
  const description = String(req.body.description ?? product.description ?? '').trim().slice(0, 300) || null;
  const image       = String(req.body.image       ?? product.image ?? '').trim().slice(0, 500) || null;
  const price       = req.body.price !== undefined ? parseFloat(req.body.price) : product.price;
  const planGroup   = req.body.plan_group !== undefined
    ? (String(req.body.plan_group).trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || null)
    : product.plan_group;
  const planLabel   = req.body.plan_label !== undefined
    ? (String(req.body.plan_label).trim().slice(0, 30) || null)
    : product.plan_label;

  if (!(price > 0)) return res.status(400).json({ error: 'Preço inválido.' });

  models.updateProduct(db, id, { name, price, description, image, plan_group: planGroup, plan_label: planLabel });
  console.log(`[ADMIN] Produto "${id}" editado por ${req.user.email}`);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════
//  ADMIN — CHAT SUPORTE
// ═══════════════════════════════════════════════════

// Lista de threads (polling do painel)
app.get('/admin/api/chats', requireAdmin, (req, res) => {
  res.json(models.listThreads(db));
});

// Mensagens de uma thread (polling incremental + marca como lida)
app.get('/admin/api/chats/:threadId/messages', requireAdmin, (req, res) => {
  const thread = models.getThreadById(db, parseInt(req.params.threadId));
  if (!thread) return res.status(404).json({ error: 'Thread não encontrada.' });

  const messages = models.getMessages(db, thread.id, parseInt(req.query.after) || 0);
  models.markRead(db, thread.id, 'admin');

  const order = models.getOrderById(db, thread.order_id);
  res.json({ thread, order, messages });
});

// Responder ao cliente (reabre a thread se estava fechada)
app.post('/admin/api/chats/:threadId/messages', requireAdmin, chatLimiter, (req, res) => {
  const thread = models.getThreadById(db, parseInt(req.params.threadId));
  if (!thread) return res.status(404).json({ error: 'Thread não encontrada.' });

  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Mensagem vazia.' });

  if (thread.status === 'closed') {
    models.setThreadStatus(db, thread.id, 'open');
  }

  const message = models.addMessage(db, thread.id, 'admin', body);
  res.json({ message });
});

// Encerrar/abrir thread
app.post('/admin/api/chats/:threadId/status', requireAdmin, (req, res) => {
  const thread = models.getThreadById(db, parseInt(req.params.threadId));
  if (!thread) return res.status(404).json({ error: 'Thread não encontrada.' });

  const status = String(req.body.status) === 'closed' ? 'closed' : 'open';
  models.setThreadStatus(db, thread.id, status);
  res.json({ success: true, status });
});

// ═══════════════════════════════════════════════════
//  ADMIN — CUPONS
// ═══════════════════════════════════════════════════

// Criar cupom
app.post('/admin/api/coupons/create', requireAdmin, (req, res) => {
  const code   = String(req.body.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
  const type   = req.body.type === 'fixed' ? 'fixed' : 'percent';
  const value  = parseFloat(req.body.value);
  const maxUses = req.body.max_uses === '' || req.body.max_uses === undefined ? -1 : parseInt(req.body.max_uses);
  const expiresAt = String(req.body.expires_at || '').trim() || null;

  if (!code)                              return res.status(400).json({ error: 'Código é obrigatório.' });
  if (!(value > 0))                       return res.status(400).json({ error: 'Valor inválido.' });
  if (type === 'percent' && value > 100)  return res.status(400).json({ error: 'Percentual máximo é 100.' });
  if (maxUses === 0 || maxUses < -1)      return res.status(400).json({ error: 'Limite de usos inválido (−1 = ilimitado).' });
  if (expiresAt && isNaN(Date.parse(expiresAt))) return res.status(400).json({ error: 'Data de expiração inválida.' });
  if (models.getCouponByCode(db, code))   return res.status(409).json({ error: 'Já existe um cupom com esse código.' });

  const coupon = models.createCoupon(db, { code, type, value, maxUses, expiresAt });
  console.log(`[ADMIN] Cupom "${code}" criado por ${req.user.email}`);
  res.json({ success: true, coupon });
});

// Ativar/desativar cupom
app.post('/admin/api/coupons/:id/toggle', requireAdmin, (req, res) => {
  models.toggleCoupon(db, parseInt(req.params.id));
  res.json({ success: true });
});

// Excluir cupom
app.post('/admin/api/coupons/:id/delete', requireAdmin, (req, res) => {
  models.deleteCoupon(db, parseInt(req.params.id));
  console.log(`[ADMIN] Cupom #${req.params.id} excluído por ${req.user.email}`);
  res.json({ success: true });
});

// Admin API — Revogar licença
app.post('/admin/api/licenses/:id/revoke', requireAdmin, (req, res) => {
  models.revokeLicense(db, parseInt(req.params.id));
  console.log(`[ADMIN] Licença #${req.params.id} revogada por ${req.user.email}`);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════
//  ÁREA DO CLIENTE
// ═══════════════════════════════════════════════════

app.get('/conta', requireAuth, (req, res) => {
  res.render('conta', {
    user:     req.user,
    orders:   models.getOrdersByEmail(db, req.user.email),
    licenses: models.getLicensesByEmail(db, req.user.email)
  });
});

// ═══════════════════════════════════════════════════
//  PÁGINA PRINCIPAL
// ═══════════════════════════════════════════════════

app.get('/', (req, res) => {
  const products = decorateProducts(models.getAllProducts(db));
  res.render('index', {
    user: req.user || null,
    products,
    totalSales: models.getTotalSales(db),
    mpPublicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || null
  });
});

// ── Varredura de PIX expirado ────────────────────
// Fecha o ciclo sem depender da aba do cliente: pendente mais velho que
// PIX_EXP_MIN é cancelado no Mercado Pago e as keys voltam pro pool sozinhas.
async function sweepExpiredOrders() {
  const pending = db.prepare(`
    SELECT * FROM orders
    WHERE status = 'pending'
      AND payment_id IS NOT NULL
      AND created_at <= datetime('now', ?)
  `).all(`-${PIX_EXP_MIN} minutes`);

  for (const order of pending) {
    if (!mpPayment) {
      console.warn(`[SWEEP] Mercado Pago não configurado — pedido #${order.id} aguarda configuração`);
      continue;
    }

    try {
      const payment = await mpPayment.get({ id: order.payment_id });

      // Caiu pagamento que webhook e polling não viram (rede/restart): entrega
      if (payment.status === 'approved') {
        processApprovedPayment(String(payment.id));
        continue;
      }

      if (payment.status === 'pending') {
        await mpPayment.cancel({ id: order.payment_id }).catch(() => {});
      }

      models.updateOrderStatus(db, order.id, 'cancelled');
      releaseOrderStock(order);
      console.log(`[SWEEP] ⏱ Pedido #${order.id} expirou (${PIX_EXP_MIN} min sem pagar) → cancelado, estoque devolvido`);
    } catch (err) {
      // MP fora do ar: não decide nada agora — tenta de novo no próximo ciclo
      console.warn(`[SWEEP] pedido #${order.id}: ${err.message}`);
    }
  }
}

// Primeira passada 1 min após o boot; depois a cada 5 min
setTimeout(sweepExpiredOrders, 60 * 1000).unref();
setInterval(sweepExpiredOrders, 5 * 60 * 1000).unref();

// ── Start ────────────────────────────────────────
// Sobe o servidor quando rodado direto (node server.js / Railway / VPS);
// quando importado por um wrapper (Vercel, testes), só exporta o app.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 Roblox Supplyz v2.0 rodando em http://localhost:${PORT}`);
    console.log(`📊 Admin panel em http://localhost:${PORT}/admin\n`);
  });
}

module.exports = app;
