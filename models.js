/**
 * @module models
 * @description Funções de modelo (CRUD) para todas as entidades do Supplyz.
 * Todas as funções utilizam prepared statements para segurança e performance.
 */

const crypto = require('crypto');

// ============================================================================
// USUÁRIOS
// ============================================================================

/**
 * Busca ou cria um usuário a partir do perfil do Google OAuth.
 * Faz upsert pelo google_id — se já existir, atualiza nome, email e avatar.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {Object} googleProfile - Perfil retornado pelo Google OAuth
 * @param {string} googleProfile.id - ID do Google
 * @param {string} googleProfile.displayName - Nome do usuário
 * @param {string} googleProfile.email - Email do usuário
 * @param {string} [googleProfile.avatar] - URL do avatar
 * @returns {Object} Registro do usuário no banco
 */
function findOrCreateGoogleUser(db, googleProfile) {
  const upsert = db.prepare(`
    INSERT INTO users (google_id, name, email, avatar)
    VALUES (@google_id, @name, @email, @avatar)
    ON CONFLICT(google_id) DO UPDATE SET
      name   = excluded.name,
      email  = excluded.email,
      avatar = excluded.avatar
  `);

  upsert.run({
    google_id: googleProfile.id,
    name: googleProfile.displayName,
    email: googleProfile.email,
    avatar: googleProfile.avatar || null,
  });

  return db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleProfile.id);
}

/**
 * Busca um usuário pelo ID interno.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {number} id - ID do usuário
 * @returns {Object|undefined} Registro do usuário ou undefined
 */
function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/**
 * Busca um usuário pelo email.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} email - Email do usuário
 * @returns {Object|undefined} Registro do usuário ou undefined
 */
function getUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

/**
 * Retorna todos os usuários cadastrados.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @returns {Object[]} Lista de todos os usuários
 */
function getAllUsers(db) {
  return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
}

/**
 * Atualiza o papel (role) de um usuário.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {number} userId - ID do usuário
 * @param {string} role - Novo papel ('customer' ou 'admin')
 * @returns {import('better-sqlite3').RunResult} Resultado da operação
 */
function setUserRole(db, userId, role) {
  return db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}

// ============================================================================
// PEDIDOS (ORDERS)
// ============================================================================

/**
 * Cria um novo pedido no banco de dados.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {Object} data - Dados do pedido
 * @param {string} data.email - Email do comprador
 * @param {string} data.productId - ID do produto
 * @param {number} [data.quantity=1] - Quantidade
 * @param {number} data.total - Valor total em BRL
 * @param {string} [data.paymentId] - ID do pagamento no Mercado Pago
 * @param {number} [data.userId] - ID do usuário (null para checkout como visitante)
 * @returns {Object} Pedido criado
 */
function createOrder(db, { email, productId, quantity = 1, total, paymentId = null, userId = null, licenseToken = null, description = null, couponCode = null, discount = 0 }) {
  const stmt = db.prepare(`
    INSERT INTO orders (user_id, email, product_id, quantity, total, payment_id, license_token, description, coupon_code, discount)
    VALUES (@userId, @email, @productId, @quantity, @total, @paymentId, @licenseToken, @description, @couponCode, @discount)
  `);

  const result = stmt.run({ userId, email, productId, quantity, total, paymentId, licenseToken, description, couponCode, discount });
  return getOrderById(db, result.lastInsertRowid);
}

// ============================================================================
// ITENS DO PEDIDO (carrinho — 1 pedido, N produtos)
// ============================================================================

/**
 * Grava os itens de um pedido (snapshot de nome e preço por linha).
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {number} orderId - ID do pedido
 * @param {Object[]} items - [{ product_id, product_name, unit_price, quantity }]
 */
function createOrderItems(db, orderId, items) {
  const stmt = db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const it of items) {
      stmt.run(orderId, it.product_id, it.product_name, it.unit_price, it.quantity);
    }
  });
  tx();
}

/**
 * Retorna os itens de um pedido.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {number} orderId - ID do pedido
 * @returns {Object[]} Lista de itens
 */
function getOrderItems(db, orderId) {
  return db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC').all(orderId);
}

// ============================================================================
// CUPONS DE DESCONTO
// ============================================================================

function getCouponByCode(db, code) {
  return db.prepare('SELECT * FROM coupons WHERE code = ?')
    .get(String(code || '').trim().toUpperCase());
}

/**
 * Valida um cupom para uso agora (ativo, dentro da validade, com usos livres).
 * @returns {{ valid: boolean, reason?: string, coupon?: Object }}
 */
function validateCoupon(db, code) {
  const coupon = getCouponByCode(db, code);
  if (!coupon)                       return { valid: false, reason: 'Cupom não encontrado.' };
  if (!coupon.active)                return { valid: false, reason: 'Cupom desativado.' };
  if (coupon.expires_at && new Date(coupon.expires_at).getTime() <= Date.now()) {
    return { valid: false, reason: 'Cupom expirado.' };
  }
  if (coupon.max_uses !== -1 && coupon.uses >= coupon.max_uses) {
    return { valid: false, reason: 'Cupom esgotou o limite de usos.' };
  }
  return { valid: true, coupon };
}

/**
 * Calcula o desconto sobre um subtotal (o total nunca fica abaixo de R$ 1,00).
 * @param {number} subtotal - Subtotal em BRL
 * @param {Object} coupon - Registro do cupom
 * @returns {number} Desconto em BRL (2 casas)
 */
function computeDiscount(subtotal, coupon) {
  let discount;
  if (coupon.type === 'percent') {
    discount = (subtotal * coupon.value) / 100;
  } else {
    discount = coupon.value;
  }
  discount = Math.min(discount, Math.max(subtotal - 1, 0));
  return Math.round(discount * 100) / 100;
}

/**
 * Marca um uso do cupom (chamar somente quando o pagamento aprova).
 */
function incrementCouponUse(db, code) {
  return db.prepare('UPDATE coupons SET uses = uses + 1 WHERE code = ?').run(code);
}

function getAllCoupons(db) {
  return db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all();
}

function createCoupon(db, { code, type, value, maxUses = -1, expiresAt = null }) {
  db.prepare(`
    INSERT INTO coupons (code, type, value, max_uses, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(code).trim().toUpperCase(), type, value, maxUses, expiresAt);
  return getCouponByCode(db, code);
}

function toggleCoupon(db, id) {
  db.prepare('UPDATE coupons SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
  return db.prepare('SELECT * FROM coupons WHERE id = ?').get(id);
}

function deleteCoupon(db, id) {
  return db.prepare('DELETE FROM coupons WHERE id = ?').run(id);
}

// ============================================================================
// VENDAS (contadores reais para a vitrine)
// ============================================================================

/**
 * Unidades vendidas de um produto: pool → keys vendidas; gerado → licenças emitidas.
 * @returns {number}
 */
function getSalesCount(db, product) {
  if (product.key_pool) {
    const row = db.prepare("SELECT COUNT(*) AS n FROM product_keys WHERE product_id = ? AND status = 'sold'")
      .get(product.id);
    return row.n;
  }
  return db.prepare('SELECT COUNT(*) AS n FROM licenses WHERE product_id = ?').get(product.id).n;
}

/**
 * Total de unidades vendidas na loja inteira.
 * @returns {number}
 */
function getTotalSales(db) {
  const lic = db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n;
  const pool = db.prepare("SELECT COUNT(*) AS n FROM product_keys WHERE status = 'sold'").get().n;
  return lic + pool;
}

// ============================================================================
// EXPORTAÇÃO
// ============================================================================

/**
 * Busca um pedido pelo ID, incluindo informações do produto.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {number} id - ID do pedido
 * @returns {Object|undefined} Pedido com dados do produto ou undefined
 */
function getOrderById(db, id) {
  return db.prepare(`
    SELECT o.*, p.name AS product_name, p.price AS product_price
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.id = ?
  `).get(id);
}

/**
 * Busca um pedido pelo ID de pagamento do Mercado Pago.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} paymentId - ID do pagamento no Mercado Pago
 * @returns {Object|undefined} Pedido encontrado ou undefined
 */
function getOrderByPaymentId(db, paymentId) {
  return db.prepare(`
    SELECT o.*, p.name AS product_name, p.price AS product_price
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.payment_id = ?
  `).get(paymentId);
}

/**
 * Lista todos os pedidos de um email, ordenados do mais recente.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} email - Email do comprador
 * @returns {Object[]} Lista de pedidos
 */
function getOrdersByEmail(db, email) {
  return db.prepare(`
    SELECT o.*, p.name AS product_name
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.email = ?
    ORDER BY o.created_at DESC
  `).all(email);
}

/**
 * Lista pedidos com paginação e filtro por status (para painel admin).
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {Object} [options] - Opções de filtragem e paginação
 * @param {number} [options.limit=50] - Quantidade máxima de resultados
 * @param {number} [options.offset=0] - Deslocamento para paginação
 * @param {string} [options.status] - Filtrar por status específico
 * @returns {Object[]} Lista paginada de pedidos
 */
function getAllOrders(db, { limit = 50, offset = 0, status } = {}) {
  let query = `
    SELECT o.*, p.name AS product_name
    FROM orders o
    JOIN products p ON p.id = o.product_id
  `;
  const params = [];

  if (status) {
    query += ' WHERE o.status = ?';
    params.push(status);
  }

  query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(query).all(...params);
}

/**
 * Atualiza o status de um pedido e o campo updated_at.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {number} orderId - ID do pedido
 * @param {string} status - Novo status
 * @returns {import('better-sqlite3').RunResult} Resultado da operação
 */
function updateOrderStatus(db, orderId, status) {
  return db.prepare(`
    UPDATE orders
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, orderId);
}

/**
 * Retorna estatísticas gerais dos pedidos para o dashboard admin.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @returns {Object} Estatísticas: totalOrders, totalRevenue, pendingOrders, approvedOrders
 */
function getOrderStats(db) {
  const stats = db.prepare(`
    SELECT
      COUNT(*)                                          AS totalOrders,
      COALESCE(SUM(CASE WHEN status = 'approved' THEN total ELSE 0 END), 0) AS totalRevenue,
      COALESCE(SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END), 0)     AS pendingOrders,
      COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0)     AS approvedOrders
    FROM orders
  `).get();

  return stats;
}

// ============================================================================
// LICENÇAS
// ============================================================================

/**
 * Gera uma chave de licença no formato RYU-XXXX-XXXX-XXXX-XXXX.
 * Utiliza crypto.randomBytes para geração segura.
 * @returns {string} Chave de licença gerada
 */
function generateLicenseKey() {
  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push(crypto.randomBytes(2).toString('hex').toUpperCase());
  }
  return `RYU-${segments.join('-')}`;
}

/**
 * Cria uma nova licença vinculada a um pedido.
 * Gera automaticamente a chave de licença.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {Object} data - Dados da licença
 * @param {number} data.orderId - ID do pedido
 * @param {string} data.productId - ID do produto
 * @param {string} data.email - Email do comprador
 * @param {string} [data.expiresAt] - Data de expiração (null para lifetime)
 * @returns {Object} Licença criada
 */
function createLicense(db, { orderId, productId, email, expiresAt = null, licenseKey = null }) {
  const key = licenseKey || generateLicenseKey();

  const stmt = db.prepare(`
    INSERT INTO licenses (order_id, product_id, license_key, email, expires_at)
    VALUES (@orderId, @productId, @licenseKey, @email, @expiresAt)
  `);

  const result = stmt.run({ orderId, productId, licenseKey: key, email, expiresAt });
  return db.prepare('SELECT * FROM licenses WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Busca todas as licenças de um pedido.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {number} orderId - ID do pedido
 * @returns {Object[]} Lista de licenças do pedido
 */
function getLicensesByOrderId(db, orderId) {
  return db.prepare('SELECT * FROM licenses WHERE order_id = ? ORDER BY created_at DESC').all(orderId);
}

/**
 * Busca todas as licenças de um email.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} email - Email do comprador
 * @returns {Object[]} Lista de licenças
 */
function getLicensesByEmail(db, email) {
  return db.prepare(`
    SELECT l.*, p.name AS product_name
    FROM licenses l
    JOIN products p ON p.id = l.product_id
    WHERE l.email = ?
    ORDER BY l.created_at DESC
  `).all(email);
}

/**
 * Revoga uma licença (muda status para 'revoked').
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {number} licenseId - ID da licença
 * @returns {import('better-sqlite3').RunResult} Resultado da operação
 */
function revokeLicense(db, licenseId) {
  return db.prepare("UPDATE licenses SET status = 'revoked' WHERE id = ?").run(licenseId);
}

/**
 * Valida uma chave de licença.
 * Verifica se existe, está ativa e não expirou.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} key - Chave de licença (formato RYU-XXXX-XXXX-XXXX-XXXX)
 * @returns {{ valid: boolean, license?: Object, reason?: string }} Resultado da validação
 */
function validateLicense(db, key) {
  const license = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(key);

  if (!license) {
    return { valid: false, reason: 'Licença não encontrada.' };
  }

  if (license.status === 'revoked') {
    return { valid: false, reason: 'Licença revogada.', license };
  }

  if (license.status === 'expired') {
    return { valid: false, reason: 'Licença expirada.', license };
  }

  // Verifica se a licença expirou pelo campo expires_at
  if (license.expires_at) {
    const expiresAt = new Date(license.expires_at);
    if (expiresAt <= new Date()) {
      // Atualiza o status para expirado no banco
      db.prepare("UPDATE licenses SET status = 'expired' WHERE id = ?").run(license.id);
      return { valid: false, reason: 'Licença expirada.', license: { ...license, status: 'expired' } };
    }
  }

  return { valid: true, license };
}

// ============================================================================
// PRODUTOS
// ============================================================================

/**
 * Retorna todos os produtos cadastrados.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @returns {Object[]} Lista de produtos
 */
function getAllProducts(db) {
  return db.prepare('SELECT * FROM products ORDER BY name ASC').all();
}

/**
 * Cria um produto novo.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {Object} data - { id, name, price, stock, key_pool, description, image }
 * @returns {Object} Produto criado
 */
function createProduct(db, { id, name, price, stock = -1, key_pool = 0, description = null, image = null, plan_group = null, plan_label = null }) {
  db.prepare(`
    INSERT INTO products (id, name, price, stock, active, key_pool, description, image, plan_group, plan_label)
    VALUES (@id, @name, @price, @stock, 1, @key_pool, @description, @image, @plan_group, @plan_label)
  `).run({ id, name, price, stock, key_pool, description, image, plan_group, plan_label });

  return getProductById(db, id);
}

/**
 * Atualiza os dados de vitrine de um produto (não mexe em estoque/pool).
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} id - ID do produto
 * @param {Object} data - { name, price, description, image, plan_group, plan_label }
 * @returns {import('better-sqlite3').RunResult} Resultado da operação
 */
function updateProduct(db, id, { name, price, description, image, plan_group, plan_label }) {
  return db.prepare(`
    UPDATE products
    SET name = @name, price = @price, description = @description,
        image = @image, plan_group = @plan_group, plan_label = @plan_label
    WHERE id = @id
  `).run({ id, name, price, description, image, plan_group, plan_label });
}

/**
 * Busca um produto pelo ID.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} id - ID do produto (ex: 'ryu-hub-monthly')
 * @returns {Object|undefined} Produto ou undefined
 */
function getProductById(db, id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

/**
 * Atualiza o estoque de um produto.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} id - ID do produto
 * @param {number} stock - Novo valor de estoque (-1 para ilimitado)
 * @returns {import('better-sqlite3').RunResult} Resultado da operação
 */
function updateProductStock(db, id, stock) {
  return db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(stock, id);
}

/**
 * Alterna o estado ativo/inativo de um produto.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} id - ID do produto
 * @returns {import('better-sqlite3').RunResult} Resultado da operação
 */
function toggleProductActive(db, id) {
  return db.prepare(`
    UPDATE products
    SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END
    WHERE id = ?
  `).run(id);
}

/**
 * Decrementa o estoque de um produto pela quantidade especificada.
 * Só decrementa se o estoque for suficiente (stock >= qty) ou ilimitado (stock == -1).
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} id - ID do produto
 * @param {number} qty - Quantidade a decrementar
 * @returns {{ success: boolean, product?: Object }} Resultado da operação
 */
function decrementStock(db, id, qty) {
  const product = getProductById(db, id);

  if (!product) {
    return { success: false };
  }

  // Estoque ilimitado — não precisa decrementar
  if (product.stock === -1) {
    return { success: true, product };
  }

  // Estoque insuficiente
  if (product.stock < qty) {
    return { success: false, product };
  }

  db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, id);
  return { success: true, product: getProductById(db, id) };
}

/**
 * Devolve unidades ao estoque (rollback de pagamento falho/rejeitado/cancelado).
 * Produtos com estoque ilimitado (-1) são no-op.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} id - ID do produto
 * @param {number} qty - Quantidade a devolver
 * @returns {{ success: boolean, product?: Object }} Resultado da operação
 */
function restoreStock(db, id, qty) {
  const product = getProductById(db, id);

  if (!product) {
    return { success: false };
  }

  // Estoque ilimitado — nada a devolver
  if (product.stock === -1) {
    return { success: true, product };
  }

  db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, id);
  return { success: true, product: getProductById(db, id) };
}

// ============================================================================
// POOL DE KEYS (estoque real do fornecedor — 1 unidade = 1 linha)
// ============================================================================

/**
 * Reserva até `qty` keys disponíveis para um pedido. Atômica via transação.
 * Retorna os IDs reservados ou null quando o pool não fecha a quantidade.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} productId - ID do produto
 * @param {number} qty - Quantidade necessária
 * @param {number} orderId - ID do pedido dono da reserva
 * @returns {number[]|null} IDs das keys reservadas ou null
 */
function reserveKeys(db, productId, qty, orderId) {
  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT id FROM product_keys
      WHERE product_id = ? AND status = 'available'
      ORDER BY id ASC LIMIT ?
    `).all(productId, qty);

    if (rows.length < qty) return null;

    const mark = db.prepare("UPDATE product_keys SET status = 'reserved', order_id = ? WHERE id = ?");
    for (const r of rows) mark.run(orderId, r.id);
    return rows.map(r => r.id);
  });
  return tx();
}

/**
 * Libera as keys reservadas de um pedido (PIX falhou/rejeitado/cancelado).
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {number} orderId - ID do pedido
 * @returns {number} Quantas keys voltaram a ficar disponíveis
 */
function releaseOrderKeys(db, orderId) {
  return db.prepare(`
    UPDATE product_keys
    SET status = 'available', order_id = NULL
    WHERE order_id = ? AND status = 'reserved'
  `).run(orderId).changes;
}

/**
 * Marca as keys reservadas de um pedido como vendidas e devolve o conteúdo.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {number} orderId - ID do pedido
 * @param {string} [productId] - Filtrar por produto (carrinho multi-item)
 * @returns {string[]} Conteúdo das keys (texto bruto do fornecedor)
 */
function finalizeOrderKeys(db, orderId, productId = null) {
  const rows = productId
    ? db.prepare("SELECT id, content FROM product_keys WHERE order_id = ? AND product_id = ? AND status = 'reserved'").all(orderId, productId)
    : db.prepare("SELECT id, content FROM product_keys WHERE order_id = ? AND status = 'reserved'").all(orderId);

  const mark = db.prepare("UPDATE product_keys SET status = 'sold', sold_at = CURRENT_TIMESTAMP WHERE id = ?");
  for (const r of rows) mark.run(r.id);
  return rows.map(r => r.content);
}

/**
 * Adiciona um lote de keys ao pool de um produto (uma por linha).
 * Marcar o produto como key_pool automaticamente.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} productId - ID do produto
 * @param {string[]} contents - Keys em texto puro
 * @returns {number} Quantidade inserida
 */
function addKeys(db, productId, contents) {
  const insert = db.prepare('INSERT INTO product_keys (product_id, content) VALUES (?, ?)');
  db.prepare('UPDATE products SET key_pool = 1, stock = 0 WHERE id = ?').run(productId);

  let added = 0;
  const tx = db.transaction(() => {
    for (const c of contents) {
      const content = String(c).trim();
      if (!content) continue;
      insert.run(productId, content);
      added++;
    }
  });
  tx();
  return added;
}

/**
 * Contadores do pool de um produto.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 * @param {string} productId - ID do produto
 * @returns {{ total: number, available: number, reserved: number, sold: number }}
 */
function getPoolStats(db, productId) {
  const row = db.prepare(`
    SELECT
      COUNT(*)                                          AS total,
      COALESCE(SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END), 0) AS available,
      COALESCE(SUM(CASE WHEN status = 'reserved'  THEN 1 ELSE 0 END), 0) AS reserved,
      COALESCE(SUM(CASE WHEN status = 'sold'      THEN 1 ELSE 0 END), 0) AS sold
    FROM product_keys
    WHERE product_id = ?
  `).get(productId);

  return { total: row.total, available: row.available, reserved: row.reserved, sold: row.sold };
}

// ============================================================================
// CHAT SUPORTE (1 thread por pedido — cliente vs admin)
// ============================================================================

function getThreadByOrderId(db, orderId) {
  return db.prepare('SELECT * FROM chat_threads WHERE order_id = ?').get(orderId);
}

function getThreadById(db, id) {
  return db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(id);
}

/**
 * Pega a thread do pedido, criando se ainda não existir.
 */
function getOrCreateThread(db, orderId) {
  const existing = getThreadByOrderId(db, orderId);
  if (existing) return existing;

  const result = db.prepare('INSERT INTO chat_threads (order_id) VALUES (?)').run(orderId);
  return getThreadById(db, result.lastInsertRowid);
}

/**
 * Adiciona mensagem e sobe o updated_at da thread (ordenação da lista admin).
 */
function addMessage(db, threadId, sender, body) {
  const result = db.prepare(
    'INSERT INTO chat_messages (thread_id, sender, body) VALUES (?, ?, ?)'
  ).run(threadId, sender, body);

  db.prepare('UPDATE chat_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(threadId);

  return db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Mensagens de uma thread a partir de um cursor (id) — polling incremental.
 */
function getMessages(db, threadId, afterId = 0) {
  return db.prepare(`
    SELECT * FROM chat_messages
    WHERE thread_id = ? AND id > ?
    ORDER BY id ASC
    LIMIT 200
  `).all(threadId, afterId);
}

/**
 * Marca mensagens como lidas pelo lado informado ('admin' ou 'customer').
 */
function markThreadRead(db, threadId, reader) {
  if (reader === 'admin') {
    db.prepare("UPDATE chat_messages SET read_admin = 1 WHERE thread_id = ? AND sender = 'customer'").run(threadId);
  } else {
    db.prepare("UPDATE chat_messages SET read_customer = 1 WHERE thread_id = ? AND sender = 'admin'").run(threadId);
  }
}

/**
 * Reabre a thread (admin respondeu um chat encerrado).
 */
function setThreadStatus(db, threadId, status) {
  return db.prepare('UPDATE chat_threads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(status, threadId);
}

/**
 * Lista de threads pro painel admin: dados do pedido + última mensagem + não lidas.
 */
function listThreads(db) {
  return db.prepare(`
    SELECT
      t.*,
      o.email       AS order_email,
      o.quantity    AS order_quantity,
      p.name        AS product_name,
      (SELECT COUNT(*) FROM chat_messages m
         WHERE m.thread_id = t.id AND m.sender = 'customer' AND m.read_admin = 0) AS unread,
      (SELECT body FROM chat_messages m2
         WHERE m2.thread_id = t.id ORDER BY m2.id DESC LIMIT 1) AS last_message
    FROM chat_threads t
    JOIN orders o   ON o.id = t.order_id
    JOIN products p ON p.id = o.product_id
    ORDER BY t.updated_at DESC
  `).all();
}

// ============================================================================
// EXPORTAÇÃO
// ============================================================================

module.exports = {
  // Usuários
  findOrCreateGoogleUser,
  getUserById,
  getUserByEmail,
  getAllUsers,
  setUserRole,

  // Pedidos
  createOrder,
  getOrderById,
  getOrderByPaymentId,
  getOrdersByEmail,
  getAllOrders,
  updateOrderStatus,
  getOrderStats,

  // Itens do pedido
  createOrderItems,
  getOrderItems,

  // Cupons
  getCouponByCode,
  validateCoupon,
  computeDiscount,
  incrementCouponUse,
  getAllCoupons,
  createCoupon,
  toggleCoupon,
  deleteCoupon,

  // Vendas
  getSalesCount,
  getTotalSales,

  // Licenças
  generateLicenseKey,
  createLicense,
  getLicensesByOrderId,
  getLicensesByEmail,
  revokeLicense,
  validateLicense,

  // Produtos
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  updateProductStock,
  toggleProductActive,
  decrementStock,
  restoreStock,

  // Pool de keys
  reserveKeys,
  releaseOrderKeys,
  finalizeOrderKeys,
  addKeys,
  getPoolStats,

  // Chat
  getThreadByOrderId,
  getThreadById,
  getOrCreateThread,
  addMessage,
  getMessages,
  markThreadRead,
  setThreadStatus,
  listThreads,
};
