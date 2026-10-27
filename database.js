/**
 * @module database
 * @description Configuração e inicialização do banco de dados SQLite para o Supplyz.
 * Utiliza better-sqlite3 para operações síncronas e performáticas.
 */

const Database = require('better-sqlite3');
const path = require('path');

/**
 * Cria todas as tabelas necessárias no banco de dados.
 * Utiliza IF NOT EXISTS para ser seguro em reinicializações.
 * @param {import('better-sqlite3').Database} db - Instância do banco de dados
 */
function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id  TEXT UNIQUE,
      name       TEXT,
      email      TEXT,
      avatar     TEXT,
      role       TEXT DEFAULT 'customer' CHECK(role IN ('customer', 'admin')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      price       REAL NOT NULL,
      stock       INTEGER DEFAULT -1,
      active      INTEGER DEFAULT 1,
      key_pool    INTEGER DEFAULT 0,
      description TEXT,
      image       TEXT,
      plan_group  TEXT,
      plan_label  TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER REFERENCES users(id),
      email          TEXT NOT NULL,
      product_id     TEXT NOT NULL REFERENCES products(id),
      quantity       INTEGER DEFAULT 1,
      total          REAL NOT NULL,
      payment_id     TEXT,
      payment_method TEXT DEFAULT 'pix',
      status         TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled', 'refunded')),
      license_token  TEXT,
      description    TEXT,
      coupon_code    TEXT,
      discount       REAL DEFAULT 0,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id     INTEGER NOT NULL REFERENCES orders(id),
      product_id   TEXT NOT NULL REFERENCES products(id),
      product_name TEXT NOT NULL,
      unit_price   REAL NOT NULL,
      quantity     INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT UNIQUE NOT NULL,
      type       TEXT NOT NULL CHECK(type IN ('percent', 'fixed')),
      value      REAL NOT NULL,
      max_uses   INTEGER DEFAULT -1,
      uses       INTEGER DEFAULT 0,
      active     INTEGER DEFAULT 1,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    INTEGER NOT NULL REFERENCES orders(id),
      product_id  TEXT NOT NULL REFERENCES products(id),
      license_key TEXT UNIQUE NOT NULL,
      email       TEXT NOT NULL,
      status      TEXT DEFAULT 'active' CHECK(status IN ('active', 'revoked', 'expired')),
      expires_at  DATETIME,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_keys (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL REFERENCES products(id),
      content    TEXT NOT NULL,
      status     TEXT DEFAULT 'available' CHECK(status IN ('available', 'reserved', 'sold')),
      order_id   INTEGER REFERENCES orders(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sold_at    DATETIME
    );

    CREATE TABLE IF NOT EXISTS chat_threads (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   INTEGER NOT NULL UNIQUE REFERENCES orders(id),
      status     TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id     INTEGER NOT NULL REFERENCES chat_threads(id),
      sender        TEXT NOT NULL CHECK(sender IN ('customer', 'admin')),
      body          TEXT NOT NULL,
      read_admin    INTEGER DEFAULT 0,
      read_customer INTEGER DEFAULT 0,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_orders_payment_id ON orders(payment_id);
    CREATE INDEX IF NOT EXISTS idx_product_keys_avail ON product_keys(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
  `);
}

/**
 * Migrações incrementais — colunas adicionadas depois da criação original.
 * Idempotente: consulta o schema antes de alterar.
 * @param {import('better-sqlite3').Database} db - Instância do banco
 */
function runMigrations(db) {
  const orderCols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);

  // Token por pedido para o endpoint de licenças pós-pagamento (fecha IDOR)
  if (!orderCols.includes('license_token')) {
    db.exec('ALTER TABLE orders ADD COLUMN license_token TEXT');
  }

  const productCols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);

  // Pool de keys: produto consome keys reais do fornecedor (1 unidade = 1 linha)
  if (!productCols.includes('key_pool')) {
    db.exec('ALTER TABLE products ADD COLUMN key_pool INTEGER DEFAULT 0');
  }

  // Ficha do produto: descrição e imagem exibidas na vitrine
  if (!productCols.includes('description')) {
    db.exec('ALTER TABLE products ADD COLUMN description TEXT');
  }
  if (!productCols.includes('image')) {
    db.exec('ALTER TABLE products ADD COLUMN image TEXT');
  }

  // Variantes: produtos do mesmo plan_group aparecem como planos de um card
  if (!productCols.includes('plan_group')) {
    db.exec('ALTER TABLE products ADD COLUMN plan_group TEXT');
  }
  if (!productCols.includes('plan_label')) {
    db.exec('ALTER TABLE products ADD COLUMN plan_label TEXT');
  }

  // Pedido multi-item + cupom
  if (!orderCols.includes('description')) {
    db.exec('ALTER TABLE orders ADD COLUMN description TEXT');
  }
  if (!orderCols.includes('coupon_code')) {
    db.exec('ALTER TABLE orders ADD COLUMN coupon_code TEXT');
  }
  if (!orderCols.includes('discount')) {
    db.exec('ALTER TABLE orders ADD COLUMN discount REAL DEFAULT 0');
  }

  const POOL_IDS = ['wave-executor', 'delta-executor', 'real-executor', 'roblox-account'];
  db.prepare(`UPDATE products SET key_pool = 1, stock = 0 WHERE id IN (${POOL_IDS.map(() => '?').join(',')})`)
    .run(...POOL_IDS);

  // Ryu Hub já nasce como grupo de planos
  db.prepare("UPDATE products SET plan_group = 'ryu-hub', plan_label = 'Mensal'  WHERE id = 'ryu-hub-monthly'").run();
  db.prepare("UPDATE products SET plan_group = 'ryu-hub', plan_label = 'Lifetime' WHERE id = 'ryu-hub-lifetime'").run();
}

/**
 * Popula a tabela de produtos com os itens iniciais caso esteja vazia.
 * @param {import('better-sqlite3').Database} db - Instância do banco de dados
 */
function seedProducts(db) {
  const count = db.prepare('SELECT COUNT(*) AS total FROM products').get();
  if (count.total > 0) return;

  const insert = db.prepare(
    'INSERT INTO products (id, name, price, stock, key_pool, plan_group, plan_label) VALUES (@id, @name, @price, @stock, @key_pool, @plan_group, @plan_label)'
  );

  const produtos = [
    { id: 'ryu-hub-monthly',   name: 'Ryu Hub — Mensal',         price: 49.90,  stock: -1, key_pool: 0, plan_group: 'ryu-hub', plan_label: 'Mensal'  },
    { id: 'ryu-hub-lifetime',  name: 'Ryu Hub — Lifetime',       price: 149.90, stock: -1, key_pool: 0, plan_group: 'ryu-hub', plan_label: 'Lifetime' },
    { id: 'roblox-account',    name: 'Conta Roblox',             price: 24.90,  stock: 0,  key_pool: 1, plan_group: null,      plan_label: null },
    { id: 'wave-executor',     name: 'Wave Executor — Mensal',   price: 39.90,  stock: 0,  key_pool: 1, plan_group: null,      plan_label: null },
    { id: 'delta-executor',    name: 'Delta Executor — Mensal',  price: 29.90,  stock: 0,  key_pool: 1, plan_group: null,      plan_label: null },
    { id: 'real-executor',     name: 'Real Executor — Pro',      price: 19.90,  stock: 0,  key_pool: 1, plan_group: null,      plan_label: null },
  ];

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insert.run(item);
    }
  });

  insertMany(produtos);
  console.log('[DB] Produtos iniciais inseridos com sucesso.');
}

/**
 * Inicializa o banco de dados SQLite.
 * Cria o arquivo em db/supplyz.db, configura WAL mode para melhor
 * performance em concorrência, cria as tabelas e insere os dados iniciais.
 * @returns {import('better-sqlite3').Database} Instância do banco pronta para uso
 */
function initDatabase() {
  // DB_PATH permite apontar pro volume persistente de hosts (Railway, VPS etc.)
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'supplyz.db');
  const db = new Database(dbPath);

  // Habilita WAL para melhor performance em leituras concorrentes
  db.pragma('journal_mode = WAL');
  // Habilita foreign keys para integridade referencial
  db.pragma('foreign_keys = ON');

  createTables(db);
  runMigrations(db);
  seedProducts(db);

  console.log(`[DB] Banco de dados inicializado em: ${dbPath}`);
  return db;
}

module.exports = { initDatabase, createTables, runMigrations };
