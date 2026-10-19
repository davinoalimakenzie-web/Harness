// ================================================================
// Bot Telegram untuk Nox TGCloud — Cloudflare Worker
// 
// Fitur:
// - Login Nox TGCloud (OAuth)
// - Sinkronisasi data real-time dengan Supabase
// - Akses kalkulator service HP & miniapps lain
//
// Environment variables (di Cloudflare Dashboard):
// - BOT_TOKEN: API token bot Telegram
// - SUPABASE_URL: URL Supabase project
// - SUPABASE_ANON_KEY: Anon key Supabase
// - NOX_CLIENT_ID: Client ID Nox TGCloud
// - NOX_CLIENT_SECRET: Client Secret Nox TGCloud
// - REDIRECT_URI: URL callback (https://your-worker.workers.dev/callback)
// ================================================================

const BOT_TOKEN = SUPABASE_URL = SUPABASE_ANON_KEY = NOX_CLIENT_ID = NOX_CLIENT_SECRET = REDIRECT_URI = '';

// ================================================================
// Webhook handler
// ================================================================
addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // Webhook dari Telegram
  if (path === '/webhook' && request.method === 'POST') {
    const update = await request.json();
    await handleUpdate(update);
    return new Response('OK');
  }
  
  // Callback OAuth dari Nox TGCloud
  if (path === '/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code && state) {
      return await handleOAuthCallback(code, state);
    }
    return new Response('Missing code or state', { status: 400 });
  }
  
  // Health check
  if (path === '/health') {
    return new Response(JSON.stringify({ status: 'ok', bot: 'Alima0207_bot' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Root
  if (path === '/') {
    return new Response(`
      <h1>Bot Alima0207</h1>
      <p>Status: Aktif ✅</p>
      <p>Health check: <a href="/health">/health</a></p>
      <p>Webhook: <code>/webhook</code></p>
      <p>OAuth Callback: <code>/callback</code></p>
    `, {
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  return new Response('Not Found', { status: 404 });
}

// ================================================================
// Telegram Update Handler
// ================================================================
async function handleUpdate(update) {
  if (update.message) {
    await handleMessage(update.message);
  } else if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text || '';
  
  if (text.startsWith('/start')) {
    await sendMessage(chatId, `
Hai ${message.from.first_name || 'kamu'}! 👋

Bot Alima0207 siap membantu. Pilih menu:

/login — Login ke Nox TGCloud
/status — Cek status koneksi
/help — Bantuan
    `);
  } else if (text.startsWith('/login')) {
    const state = generateState(chatId);
    const authUrl = `https://nox.tgcloud.com/oauth/authorize?client_id=${NOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&state=${state}`;
    await sendMessage(chatId, `
Untuk login Nox TGCloud, klik link di bawah:

[Login Nox TGCloud](${authUrl})

Setelah login, kamu akan diarahkan kembali ke bot ini.
    `);
  } else if (text.startsWith('/status')) {
    // TODO: Cek status login user
    await sendMessage(chatId, 'Status: Belum terhubung ke Nox TGCloud. Kirim /login untuk mulai.');
  } else if (text.startsWith('/help')) {
    await sendMessage(chatId, `
*Bantuan Bot Alima0207*

/login — Login ke Nox TGCloud
/status — Cek status koneksi
/help — Bantuan ini

Bot ini terhubung dengan miniapps Nava untuk sinkronisasi data real-time.
    `);
  } else {
    await sendMessage(chatId, 'Command tidak dikenal. Kirim /help untuk bantuan.');
  }
}

async function handleCallbackQuery(query) {
  // TODO: Handle inline button callbacks
  await answerCallbackQuery(query.id, 'Coming soon!');
}

// ================================================================
// OAuth Callback Handler
// ================================================================
async function handleOAuthCallback(code, state) {
  try {
    // Exchange code untuk access token
    const tokenResponse = await fetch('https://nox.tgcloud.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: NOX_CLIENT_ID,
        client_secret: NOX_CLIENT_SECRET,
        code: code,
        redirect_uri: REDIRECT_URI
      })
    });
    
    const tokenData = await tokenResponse.json();
    
    if (tokenData.access_token) {
      // Simpan token ke Supabase (atau KV)
      await saveUserToken(state, tokenData.access_token);
      
      // Decode state untuk dapat chatId
      const chatId = decodeState(state);
      if (chatId) {
        await sendMessage(chatId, 'Login berhasil! Kamu sudah terhubung ke Nox TGCloud. ✅');
      }
      
      return new Response('Login berhasil! Kamu bisa kembali ke Telegram.', {
        headers: { 'Content-Type': 'text/html' }
      });
    } else {
      return new Response('Login gagal: ' + JSON.stringify(tokenData), { status: 400 });
    }
  } catch (err) {
    return new Response('Error: ' + err.message, { status: 500 });
  }
}

// ================================================================
// Helper Functions
// ================================================================
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    })
  });
}

async function answerCallbackQuery(queryId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: queryId,
      text: text
    })
  });
}

function generateState(chatId) {
  // Simple base64 encoding (di produksi pakai crypto)
  return btoa(JSON.stringify({ chatId: chatId, nonce: Date.now() }));
}

function decodeState(state) {
  try {
    const data = JSON.parse(atob(state));
    return data.chatId;
  } catch {
    return null;
  }
}

async function saveUserToken(state, accessToken) {
  // TODO: Simpan ke Supabase atau KV
  // Sekarang dulu return true
  return true;
}
