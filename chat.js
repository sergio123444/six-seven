// ================================================
//  ROBLOX SUPPLYZ — Chat suporte (cliente)
//  Polling incremental a cada 4s enquanto o drawer está aberto.
//  Convite sem login: prova de compra via token da criação do PIX.
// ================================================

const chatState = { orderId: null, token: '', lastId: 0, timer: null };

function chatQuery() {
  return 'token=' + encodeURIComponent(chatState.token);
}

async function openChat(orderId, token) {
  chatState.orderId = orderId;
  chatState.token   = token || '';
  chatState.lastId  = 0;

  const box = document.getElementById('chat-messages');
  box.innerHTML = '';
  document.getElementById('chat-input').disabled = false;
  document.getElementById('chat-drawer').style.display = 'flex';

  await chatFetch();

  if (chatState.timer) clearInterval(chatState.timer);
  chatState.timer = setInterval(chatFetch, 4000);
}

function closeChat() {
  document.getElementById('chat-drawer').style.display = 'none';
  if (chatState.timer) {
    clearInterval(chatState.timer);
    chatState.timer = null;
  }
}

function chatAppend(m) {
  const box = document.getElementById('chat-messages');

  const row = document.createElement('div');
  row.className = 'chat-msg ' + (m.sender === 'customer' ? 'chat-msg-me' : 'chat-msg-admin');

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';

  const body = document.createElement('div');
  body.className = 'chat-body';
  body.textContent = m.body;

  const time = document.createElement('div');
  time.className = 'chat-time';
  time.textContent = String(m.created_at).slice(11, 16); // HH:MM (UTC)

  bubble.appendChild(body);
  bubble.appendChild(time);
  row.appendChild(bubble);
  box.appendChild(row);

  if (m.id > chatState.lastId) chatState.lastId = m.id;
  box.scrollTop = box.scrollHeight;
}

async function chatFetch() {
  if (!chatState.orderId) return;

  try {
    const res = await fetch(`/api/orders/${chatState.orderId}/chat?${chatQuery()}&after=${chatState.lastId}`);
    if (!res.ok) return;

    const data = await res.json();

    const sub = document.getElementById('chat-sub');
    if (sub && data.productName) {
      sub.textContent = `Pedido #${data.orderId} — ${data.productName}`;
    }
    if (data.status === 'closed') {
      document.getElementById('chat-input').disabled = true;
      if (sub) sub.textContent += ' (encerrado pelo suporte)';
    }

    for (const m of data.messages) chatAppend(m);
  } catch (err) {
    // polling silencioso — próximo ciclo tenta de novo
  }
}

async function chatSend() {
  const input = document.getElementById('chat-input');
  const body  = input.value.trim();
  if (!body || !chatState.orderId) return;

  const btn = document.getElementById('chat-send');
  btn.disabled = true;

  try {
    const res = await fetch(`/api/orders/${chatState.orderId}/chat?${chatQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });
    const data = await res.json();

    if (res.ok && data.message) {
      chatAppend(data.message);
      input.value = '';
    }
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

// Enter dentro do input envia
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement === document.getElementById('chat-input')) {
    chatSend();
  }
});

// Copiar o Discord do suporte
function copyDiscord(btn) {
  navigator.clipboard.writeText('freefitelalao').then(() => {
    const original = btn.textContent;
    btn.textContent = 'copiado!';
    setTimeout(() => { btn.textContent = original; }, 2000);
  });
}
