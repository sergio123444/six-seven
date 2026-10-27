# ROBLOX SUPPLYZ — Guia de deploy

## ⚠️ Leia antes de subir

Este projeto usa **SQLite em arquivo** (`db/supplyz.db`) e **uploads em disco**
(`public/uploads`). Isso muda ONDE ele pode ser hospedado:

| Host | Funciona? | Por quê |
|---|---|---|
| **Railway** (recomendado) | ✅ Sim | Processo Node vivo + volume persistente |
| VPS (Windows/Linux) | ✅ Sim | Disco é seu |
| **Render** | ⚠️ Sim, com volume pago | Sem volume, banco zera |
| **Vercel / Netlify** | ⚠️ Sobe, mas com perdas | Roda com `/tmp`, **dados não persistem entre instâncias/deploys** → só pra teste |

### 🛰️ Suplemento Vercel (modo teste)

O projeto agora inclui `api/index.js` + `vercel.json` para rodar no Vercel.
**Obrigatório no painel (Settings → Environment Variables):**

| Variável | Valor |
|---|---|
| `DB_PATH` | `/tmp/supplyz.db` |
| `UPLOAD_DIR` | `/tmp/uploads` |
| `NODE_ENV` | *(a Vercel já marca `production` sozinha)* |

Limites que você **vai notar** no Vercel:
- Banco reinicia quando a função troca de instância ou redeploya → produtos/keys/pedidos somem.
- Sessão (login) cai no mesmo evento.
- A varredura de PIX expirado só roda enquanto a instância tá quente.
Em resumo: **Vercel = demonstração**. Pra vender de verdade → Railway.

### Variáveis obrigatórias em QUALQUER host
Copie do `.env.example`: `MERCADO_PAGO_ACCESS_TOKEN`, `MERCADO_PAGO_PUBLIC_KEY`,
`MERCADO_PAGO_WEBHOOK_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`ADMIN_EMAIL`, `SESSION_SECRET`, `DISCORD_WEBHOOK_URL`.
No Google Cloud, cadastre o callback do NOVO domínio:
`https://SEU-DOMINIO/auth/google/callback`.

---

## 🚀 Deploy no Railway (recomendado)

1. **Suba o código pro GitHub** (no seu PC, dentro da pasta do projeto):
   ```bash
   git init
   git add .
   git commit -m "roblox-supplyz"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/roblox-supplyz.git
   git push -u origin main
   ```
   > Crie o repositório vazio em github.com/new antes. O `.gitignore` já protege
   > `.env`, banco e `node_modules`.

2. **Crie o app no Railway**:
   - railway.app → Login com GitHub → **New Project → Deploy from GitHub repo**
   - Escolha `roblox-supplyz`. O Railway detecta Node e roda `npm start` sozinho.

3. **Anexe um volume** (é o que impede o banco de sumir):
   - No serviço: **Settings → Volumes → Add Volume**
   - Mount path: `/data`

4. **Configure as variáveis** (aba **Variables**):
   - Copie tudo do `.env.example` e preencha (MP, Google, SESSION_SECRET etc.)
   - **E mais estas duas**:
     - `DB_PATH=/data/supplyz.db`
     - `UPLOAD_DIR=/data/uploads`

5. **Domínio**: **Settings → Networking → Generate Domain** (ou aponte o seu).

6. **Confirme no Google Cloud Console** que existe o redirect
   `https://SEU-DOMINIO/auth/google/callback` — sem ele o login dá erro.

7. **Webhook do Mercado Pago** (opcional mas recomendado):
   - Painel do MP → Webhooks → cadastre `https://SEU-DOMINIO/api/pix/webhook`
   - Preencha `MERCADO_PAGO_WEBHOOK_SECRET` na Vercel/Railway com a assinatura.

---

## ✅ Checklist pós-deploy

1. Abra `https://SEU-DOMINIO` — vitrine deve aparecer com seus produtos.
2. Logue com o Google do `ADMIN_EMAIL` → `/admin` deve abrir.
3. Cole as keys do fornecedor no Admin → **POOL DE KEYS**.
4. **Teste de fogo**: faça uma compra PIX real de R$ 1 (crie um produto-teste
   de R$ 1, pague, confirme: aprovação automática, key na tela, chat abre,
   ping no Discord).
5. Confirme que um PIX abandonado é cancelado sozinho pela varredura
   (log `[SWEEP]` no Railway). Depois apague o produto-teste.

---

## 🖥️ Rodar local

```bash
npm install
cp .env.example .env   # preencha
npm start              # http://localhost:3000
npm run dev            # com auto-reload
```

---

## 🧰 Notas rápidas

- **Usar outro banco/arquivo**: `DB_PATH` muda onde o SQLite vive.
- **Backup**: baixe `supplyz.db` do volume de tempos em tempos (Railway tem
  opção de snapshot; em VPS, copie o arquivo — com WAL, copie também `-wal`/`-shm`).
- **Imagens de produto** sobem via Admin → ficam em `public/uploads`
  (ou `UPLOAD_DIR`). Sem volume persistente, somem no próximo deploy.
