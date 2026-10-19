# ================================================================
# Panduan Setup Bot Telegram + Cloudflare Workers
# ================================================================

## Langkah 1: Buat Cloudflare Account
1. Buka https://cloudflare.com
2. Daftar gratis (email + password)
3. Masuk ke dashboard

## Langkah 2: Buat Worker
1. Di dashboard Cloudflare, klik **Workers & Pages**
2. Klik **Create application** → **Create Worker**
3. Nama worker: `alima-bot` (atau bebas)
4. Klik **Deploy**

## Langkah 3: Copy Script Bot
1. Buka file `cloudflare-worker/bot.js` di repo ini
2. Copy semua isinya
3. Di Cloudflare dashboard, klik worker yang baru dibuat
4. Klik **Edit code** → paste script → **Save and Deploy**

## Langkah 4: Setup Environment Variables
Di Cloudflare dashboard, klik worker → **Settings** → **Variables** → **Add variable**:

| Variable | Value |
|----------|-------|
| `BOT_TOKEN` | `8842237612:AAHJ_VztCAq0aqRmuXopiS8B3tZRfUiTaBk` |
| `SUPABASE_URL` | `https://tpolunkalvyrrwodvdov.supabase.co` |
| `SUPABASE_ANON_KEY` | (anon key dari Supabase) |
| `NOX_CLIENT_ID` | (dari dashboard Nox TGCloud) |
| `NOX_CLIENT_SECRET` | (dari dashboard Nox TGCloud) |
| `REDIRECT_URI` | `https://alima-bot.your-subdomain.workers.dev/callback` |

## Langkah 5: Setup Webhook Telegram
Setelah deploy, buka URL worker di browser:
```
https://alima-bot.your-subdomain.workers.dev/health
```

Kalau muncul `{"status":"ok"}`, worker sudah aktif.

Lalu setup webhook Telegram:
```
https://api.telegram.org/bot8842237612:AAHJ_VztCAq0aqRmuXopiS8B3tZRfUiTaBk/setWebhook?url=https://alima-bot.your-subdomain.workers.dev/webhook
```

## Langkah 6: Test Bot
1. Buka Telegram
2. Cari **@Alima0207_bot**
3. Kirim `/start`
4. Bot harus membalas dengan menu

## Langkah 7: Setup Nox TGCloud OAuth
1. Buka dashboard Nox TGCloud
2. Buat OAuth application
3. Set redirect URI: `https://alima-bot.your-subdomain.workers.dev/callback`
4. Copy `client_id` dan `client_secret` ke environment variables worker

## Troubleshooting
- **Bot tidak membalas**: Cek webhook sudah di-set dengan benar
- **Login gagal**: Cek `NOX_CLIENT_ID` dan `NOX_CLIENT_SECRET`
- **Worker error**: Cek logs di Cloudflare dashboard → **Logs**
