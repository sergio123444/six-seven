// ================================================
//  Middleware de Autenticação & Autorização
// ================================================

/**
 * Verifica se o usuário está logado
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Faça login para continuar.' });
    }
    return res.redirect('/auth/google');
  }
  next();
}

/**
 * Verifica se o usuário logado é admin
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    if (req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Faça login para continuar.' });
    }
    return res.redirect('/auth/google');
  }

  if (req.user.role !== 'admin') {
    if (req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
    }
    return res.status(403).send('Acesso negado.');
  }

  next();
}

/**
 * Valida assinatura do webhook do Mercado Pago
 * O MP envia um header x-signature que pode ser validado
 */
function validateWebhookSignature(secret) {
  const crypto = require('crypto');

  return (req, res, next) => {
    // Se não tiver secret configurado, pula validação (dev mode)
    if (!secret) {
      console.warn('⚠️  Webhook sem validação de assinatura (MERCADO_PAGO_WEBHOOK_SECRET não configurado)');
      return next();
    }

    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];

    if (!xSignature || !xRequestId) {
      console.warn('⚠️  Webhook sem headers de assinatura');
      return res.status(401).json({ error: 'Assinatura ausente' });
    }

    try {
      // Extrair ts e v1 do header x-signature
      // Formato: ts=TIMESTAMP,v1=HASH
      const parts = {};
      xSignature.split(',').forEach(part => {
        const [key, value] = part.split('=');
        parts[key.trim()] = value.trim();
      });

      const ts = parts.ts;
      const v1 = parts.v1;

      if (!ts || !v1) {
        return res.status(401).json({ error: 'Formato de assinatura inválido' });
      }

      // Montar o manifest para validação
      // Template: id:[data.id];request-id:[x-request-id];ts:[ts];
      const dataId = req.query['data.id'] || req.body?.data?.id || '';
      const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

      // Gerar HMAC SHA256
      const hmac = crypto
        .createHmac('sha256', secret)
        .update(manifest)
        .digest('hex');

      if (hmac !== v1) {
        console.warn('⚠️  Webhook com assinatura inválida');
        return res.status(401).json({ error: 'Assinatura inválida' });
      }

      // Assinatura válida
      next();

    } catch (err) {
      console.error('Erro ao validar assinatura:', err);
      return res.status(500).json({ error: 'Erro na validação' });
    }
  };
}

module.exports = {
  requireAuth,
  requireAdmin,
  validateWebhookSignature
};
