// ================================================
//  Rate Limiting — Proteção contra spam/abuso
// ================================================
const rateLimit = require('express-rate-limit');

/**
 * Rate limiter geral — 100 requests por IP a cada 15 minutos
 */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Muitas requisições. Tente novamente em alguns minutos.'
  }
});

/**
 * Rate limiter para criação de PIX — 5 requests por IP a cada 10 minutos
 * Evita que alguém spamme pagamentos no Mercado Pago
 */
const pixLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Muitas tentativas de pagamento. Aguarde 10 minutos.'
  }
});

/**
 * Rate limiter para login — 10 tentativas por IP a cada 15 minutos
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Muitas tentativas de login. Tente novamente em 15 minutos.'
  }
});

/**
 * Rate limiter para webhook — 50 requests por IP a cada minuto
 * Mercado Pago pode enviar vários webhooks seguidos
 */
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Rate limiter do chat — 15 mensagens por IP a cada 10 minutos
 * Polling de leitura (GET) não passa por aqui, só envio de mensagem
 */
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Calma aí 👋 — muita mensagem seguida. Tenta de novo em alguns minutos.'
  }
});

module.exports = {
  generalLimiter,
  pixLimiter,
  authLimiter,
  webhookLimiter,
  chatLimiter
};
