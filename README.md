# 🎮 Roblox Supplyz — Storefront

Storefront completo com **Google Sign-In** e **Pagamento PIX via Mercado Pago**.

---

## 📁 Estrutura

```
roblox-supplyz/
├── server.js           ← Servidor Express (auth + PIX)
├── package.json
├── .env.example        ← Template das variáveis de ambiente
├── .gitignore
├── views/
│   └── index.ejs       ← Página principal (template EJS)
└── public/
    ├── css/
    │   └── style.css   ← Design system completo
    └── js/
        └── app.js      ← Lógica do frontend (PIX, planos, qty)
```

---

## 🚀 Como Rodar

### 1. Instalar dependências

```bash
cd roblox-supplyz
npm install
```

### 2. Configurar variáveis de ambiente

```bash
copy .env.example .env
```

Edite o arquivo `.env` e preencha:

### 3. Configurar Google OAuth

1. Acesse [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Crie um projeto (ou use um existente)
3. Vá em **Credenciais** → **Criar Credenciais** → **ID do cliente OAuth**
4. Tipo: **Aplicativo da Web**
5. Em **URIs de redirecionamento autorizados**, adicione:
   ```
   http://localhost:3000/auth/google/callback
   ```
6. Copie o **Client ID** e **Client Secret** para o `.env`

### 4. Configurar Mercado Pago (PIX)

1. Acesse [Mercado Pago Developers](https://www.mercadopago.com.br/developers/panel/app)
2. Crie uma aplicação
3. Em **Credenciais de Teste** (ou Produção), copie:
   - **Access Token** → `MERCADO_PAGO_ACCESS_TOKEN`
   - **Public Key** → `MERCADO_PAGO_PUBLIC_KEY`

### 5. Rodar

```bash
npm start
```

Acesse: **http://localhost:3000**

---

## 🔄 Fluxo do PIX

```
Usuário clica "Pagar com PIX"
        ↓
Modal pede e-mail (pré-preenchido se logado via Google)
        ↓
POST /api/pix/create → Mercado Pago API
        ↓
Retorna QR Code + código copia-e-cola
        ↓
Frontend exibe QR + começa polling a cada 5s
        ↓
GET /api/pix/status/:id → verifica se approved
        ↓
Pagamento aprovado → tela de sucesso
```

---

## 📡 Webhook (Produção)

Em produção, configure o webhook do Mercado Pago para:

```
https://seudominio.com/api/pix/webhook
```

Descomente a linha `notification_url` no `server.js`.

---

## 🛠️ API Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/` | Página principal |
| GET | `/auth/google` | Iniciar login Google |
| GET | `/auth/google/callback` | Callback OAuth |
| GET | `/auth/logout` | Logout |
| GET | `/api/me` | Dados do usuário logado |
| POST | `/api/pix/create` | Criar pagamento PIX |
| GET | `/api/pix/status/:id` | Verificar status |
| POST | `/api/pix/webhook` | Webhook Mercado Pago |
