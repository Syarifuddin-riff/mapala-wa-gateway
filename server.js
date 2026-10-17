const express = require('express');
const cors = require('cors');
const axios = require('axios');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://mapalaperegrina.gt.tc/whatsapp/webhook';
const OUTBOX_URL = WEBHOOK_URL.replace(/\/webhook\/?$/, '/outbox');
const CONFIRM_URL = WEBHOOK_URL.replace(/\/webhook\/?$/, '/confirm_outbox');
const SESSION_DIR = path.join(__dirname, 'session_auth');
const crypto = require('crypto');

// ===== INFINITYFREE ANTI-BOT BYPASS (AUTOMATIC AES CHALLENGE RESOLVER) =====
let cachedInfinityCookie = null;
let cookieExpiresAt = 0;

function solveInfinityChallenge(html) {
    try {
        const aMatch = html.match(/toNumbers\(["']([0-9a-fA-F]+)["']\)/g);
        if (!aMatch || aMatch.length < 3) return null;

        const hexList = aMatch.map(m => m.match(/["']([0-9a-fA-F]+)["']/)[1]);
        const key = Buffer.from(hexList[0], 'hex');
        const iv  = Buffer.from(hexList[1], 'hex');
        const c   = Buffer.from(hexList[2], 'hex');

        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
        decipher.setAutoPadding(false);
        const decrypted = Buffer.concat([decipher.update(c), decipher.final()]);
        return decrypted.toString('hex');
    } catch (e) {
        return null;
    }
}

async function getInfinityCookie(forceRefresh = false) {
    if (!WEBHOOK_URL.includes('gt.tc') && !WEBHOOK_URL.includes('infinityfree')) {
        return null;
    }
    const now = Date.now();
    if (!forceRefresh && cachedInfinityCookie && now < cookieExpiresAt) {
        return cachedInfinityCookie;
    }

    try {
        const resp = await fetch(WEBHOOK_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const text = await resp.text();
        if (text && text.includes('slowAES.decrypt')) {
            const cookieVal = solveInfinityChallenge(text);
            if (cookieVal) {
                cachedInfinityCookie = `__test=${cookieVal}`;
                cookieExpiresAt = now + (5 * 60 * 60 * 1000);
                console.log('[InfinityFree Shield] Solved __test cookie:', cachedInfinityCookie);
                return cachedInfinityCookie;
            }
        }
    } catch (err) {
        console.warn('[InfinityFree Shield Warning]', err.message);
    }
    return cachedInfinityCookie;
}

axios.interceptors.request.use(async (config) => {
    if (config.url && (config.url.includes('gt.tc') || config.url.includes('infinityfree'))) {
        const cookie = await getInfinityCookie();
        if (cookie) {
            config.headers = config.headers || {};
            config.headers['Cookie'] = cookie;
            config.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        }
    }
    return config;
});

axios.interceptors.response.use(async (response) => {
    if (typeof response.data === 'string' && response.data.includes('slowAES.decrypt')) {
        const cookie = await getInfinityCookie(true);
        if (cookie) {
            const config = response.config;
            config.headers['Cookie'] = cookie;
            return axios(config);
        }
    }
    return response;
});

process.on('uncaughtException', (err) => {
    console.error('[Uncaught Exception]', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[Unhandled Rejection]', reason);
});

let sock = null;
let qrDataUrl = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
let botUser = null;
let connectedAt = null;
let lastDisconnectInfo = null;
let conflictCount = 0;
let stableTimer = null;
let reconnectTimer = null;
let isStarting = false;

// ===== SESSION PERSISTENCE =====
// Railway menggunakan Docker Volume persisten di /app/session_auth.
// Sinkronisasi blob via HTTP ke database gratis InfinityFree tidak lagi diperlukan
// guna mencegah pembekuan koneksi dan korupsi berkas akibat anti-bot challenge.
async function syncSessionFromCloud() {
    return;
}

function backupSessionToCloud() {
    return;
}

function clearSessionFiles() {
    try {
        if (!fs.existsSync(SESSION_DIR)) return;
        const files = fs.readdirSync(SESSION_DIR);
        for (const f of files) {
            try {
                fs.rmSync(path.join(SESSION_DIR, f), { recursive: true, force: true });
            } catch (e) {}
        }
        console.log('[Baileys] Isi folder sesi berhasil dibersihkan.');
    } catch (e) {
        console.warn('[Clear Session Error]', e.message);
    }
}

async function closeSocketGracefully() {
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            if (sock.ws) {
                try { sock.ws.removeAllListeners(); } catch (e) {}
                try { sock.ws.close(); } catch (e) {}
            }
            sock.end(undefined);
        } catch (e) {}
        sock = null;
    }
}

async function startWhatsApp() {
    clearTimeout(reconnectTimer);
    if (isStarting) {
        console.log('[Baileys] Socket sedang diinisialisasi, abaikan panggilan ganda.');
        return;
    }
    isStarting = true;

    connectionStatus = 'connecting';
    qrDataUrl = null;

    await closeSocketGracefully();

    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        printQRInTerminal: false
    });

    const thisSock = sock;

    sock.ev.on('creds.update', async () => {
        if (thisSock !== sock) return;
        await saveCreds();
    });

    sock.ev.on('connection.update', async (update) => {
        if (thisSock !== sock) return;

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            connectionStatus = 'qr_ready';
            try {
                qrDataUrl = await qrcode.toDataURL(qr);
            } catch (err) {
                console.error('[QR Error]', err);
            }
            console.log('[Baileys] QR Code baru siap dipindai');
        }

        if (connection === 'close') {
            isStarting = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || String(lastDisconnect?.error);
            lastDisconnectInfo = { statusCode, error: errorMsg, time: new Date().toISOString() };
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[Baileys] Koneksi terputus (status: ${statusCode}, msg: ${errorMsg}). Reconnect: ${shouldReconnect}`);

            connectionStatus = 'disconnected';
            qrDataUrl = null;
            botUser = null;
            clearTimeout(stableTimer);

            if (statusCode === 440) {
                conflictCount++;
                console.log(`[Baileys] 440 conflict count: ${conflictCount}`);
                if (conflictCount >= 3) {
                    console.log('[Baileys] 3x berturut-turut conflict 440 terdeteksi. Mereset sesi dan menyiapkan QR baru...');
                    clearSessionFiles();
                    conflictCount = 0;
                }
            } else if (statusCode === DisconnectReason.loggedOut) {
                console.log('[Baileys] Device logged out. Menghapus sesi lama...');
                clearSessionFiles();
                conflictCount = 0;
            }

            if (shouldReconnect) {
                clearTimeout(reconnectTimer);
                let delay = 3500;
                if (statusCode === 440) delay = 8000;
                else if (statusCode === 515 || statusCode === 428) delay = 2500;

                reconnectTimer = setTimeout(() => {
                    startWhatsApp();
                }, delay);
            } else {
                clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(() => startWhatsApp(), 2000);
            }
        } else if (connection === 'open') {
            isStarting = false;
            clearTimeout(reconnectTimer);
            connectionStatus = 'connected';
            qrDataUrl = null;
            connectedAt = new Date().toISOString();
            botUser = {
                id: sock.user?.id || '',
                name: sock.user?.name || 'Assistant Peregrina'
            };
            console.log(`[Baileys] Terhubung ke WhatsApp! Akun: ${botUser.id} (${botUser.name})`);

            // Sesi stabil jika berhasil bertahan minimal 45 detik
            clearTimeout(stableTimer);
            stableTimer = setTimeout(() => {
                conflictCount = 0;
                console.log('[Baileys] Koneksi WhatsApp stabil (>45 detik). Reset counter conflict.');
            }, 45000);
        }
    });

    // Cache Metadata Grup agar tidak membebani server WA dan mencegah timeout
    const groupMetaCache = new Map();
    async function getCachedGroupMetadata(sockInstance, groupId) {
        const now = Date.now();
        const cached = groupMetaCache.get(groupId);
        if (cached && (now - cached.time < 300000)) { // Cache 5 menit
            return cached.meta;
        }
        try {
            const meta = await sockInstance.groupMetadata(groupId);
            if (meta) {
                groupMetaCache.set(groupId, { meta, time: now });
                return meta;
            }
        } catch (e) {
            if (cached) return cached.meta;
        }
        return null;
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (thisSock !== sock) return;
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                // Abaikan pesan dari bot sendiri atau status broadcast
                if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') {
                    continue;
                }

                const remoteJid = msg.key.remoteJid;
                const isGroup = remoteJid.endsWith('@g.us');
                const senderJid = isGroup ? (msg.key.participant || msg.participant) : remoteJid;
                const senderName = msg.pushName || 'Kawan Peregrina';

                // Ekstrak pesan teks
                const text = msg.message?.conversation ||
                             msg.message?.extendedTextMessage?.text ||
                             msg.message?.imageMessage?.caption ||
                             msg.message?.videoMessage?.caption ||
                             '';

                if (!text || !text.trim()) continue;

                // Identifikasi Bot
                const botJid = (sock.user?.id || '').replace(/:.*@/, '@');
                const botNum = botJid.split('@')[0];
                const botLid = (sock.user?.lid || '').replace(/:.*@/, '@');
                const botLidNum = botLid.split('@')[0];

                const contextInfo = msg.message?.extendedTextMessage?.contextInfo ||
                                    msg.message?.imageMessage?.contextInfo ||
                                    msg.message?.videoMessage?.contextInfo || {};
                const mentions = contextInfo.mentionedJid || [];

                // 1. Cek mention bot di grup (cocokkan JID, nomor, atau LID)
                let mentionedBot = mentions.some(j => {
                    const cleanJ = j.replace(/:.*@/, '@').split('@')[0];
                    return (botNum && cleanJ === botNum) || (botLidNum && cleanJ === botLidNum);
                });

                // 2. Cek apakah pesan me-reply (quote) pesan bot
                const quotedParticipant = (contextInfo.participant || '').replace(/:.*@/, '@').split('@')[0];
                const isQuotingBot = Boolean(quotedParticipant && (
                    (botNum && quotedParticipant === botNum) ||
                    (botLidNum && quotedParticipant === botLidNum)
                ));

                // 3. Cek kata kunci eksplisit di teks
                const textMatchesBot = /(@?AssistantPeregrina|@?bot\b|@?mapala\b|@?peregrina\b|6281119737920|081119737920|@asisten\b|asisten)/i.test(text) ||
                                       /^[\/!](start|help|menu|info|tanya|bot)\b/i.test(text);

                // 0. Cek apakah ini Tag All / Mass Mention di Grup:
                // Jika ya, BOT WAJIB DIAM SAJA, jangan respon, dan jangan centang biru!
                const isTagAll = isGroup && (
                    mentions.length > 5 || 
                    /@(all|everyone|semua|group|member|semuanya|grup)\b/i.test(text)
                );
                if (isTagAll) {
                    console.log(`[Tag All Diabaikan] Pesan mass mention dari ${senderName} di grup ${remoteJid}`);
                    continue;
                }

                // Cek apakah pesan memanggil bot
                const isCallingAssistant = !isGroup || mentionedBot || isQuotingBot || textMatchesBot;

                // JIKA DI GRUP DAN TIDAK MEMANGGIL AssistantPeregrina:
                // JANGAN BACA PESAN! Biarkan tetap 2 centang abu-abu!
                if (!isCallingAssistant) {
                    continue;
                }

                console.log(`[Pesan ${isGroup ? 'Grup' : 'Japri'}] Dari: ${senderName} (${senderJid}) -> "${text.trim().substring(0, 60)}" | Trigger: ${mentionedBot ? 'Mention' : (isQuotingBot ? 'Quote' : 'Keyword/DM')}`);

                // JIKA DIPANGGIL / JAPRI:
                // 1. Langsung tandai pesan telah dibaca (readMessages) -> Seketika memicu CENTANG DUA BIRU!
                try {
                    await sock.readMessages([msg.key]);
                } catch (readErr) {}

                // 2. Tampilkan status "mengetik..." (typing) agar interaktif dan nyata
                try {
                    await sock.sendPresenceUpdate('composing', remoteJid);
                } catch (presErr) {}

                // Ambil metadata grup jika pesan dari grup (dengan cache agar kilat)
                let groupName = '';
                let groupParticipants = [];
                if (isGroup) {
                    try {
                        const meta = await getCachedGroupMetadata(sock, remoteJid);
                        if (meta) {
                            groupName = meta.subject || '';
                            for (const p of meta.participants || []) {
                                if (p.id) groupParticipants.push(p.id);
                                if (p.lid) groupParticipants.push(p.lid);
                            }
                        }
                    } catch (e) {
                        console.warn('[Group Metadata Warning]', e.message);
                    }
                }

                // Teruskan payload ke webhook CodeIgniter
                const payload = {
                    sender: senderJid,
                    sender_name: senderName,
                    message: text.trim(),
                    is_group: isGroup,
                    group_id: isGroup ? remoteJid : null,
                    group_name: groupName,
                    group_participants: groupParticipants,
                    mentioned_bot: (mentionedBot || isQuotingBot || textMatchesBot)
                };

                const res = await axios.post(WEBHOOK_URL, payload, {
                    timeout: 75000,
                    headers: { 'Content-Type': 'application/json' }
                });

                // Hentikan status mengetik
                try {
                    await sock.sendPresenceUpdate('paused', remoteJid);
                } catch (presErr) {}

                if (res.data && res.data.status === 'success' && res.data.reply) {
                    await sock.sendMessage(remoteJid, { text: res.data.reply }, { quoted: msg });
                }
            } catch (err) {
                console.error('[Message Handler Error]', err.message);
                try {
                    await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
                } catch (e) {}

                try {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: "Salam Lestari! 🌲\n\nMaaf kawan, responku sempat tertunda karena lalu lintas sistem sedang padat. Silakan kirimkan kembali pertanyaanmu ya!"
                    }, { quoted: msg });
                } catch (fallbackErr) {}
            }
        }
    });
}

// ===== DAEMON POLLING OUTBOX: ADAPTIVE SMART POLLING (ANTI-SUSPEND PROTECTION) =====
// Saat antrean kosong: polling santai tiap 15-20 detik (menghemat 80%+ kuota hits harian).
// Saat ada antrean pesan: polling otomatis cepat (3 detik) hingga antrean tuntas terkirim.
let isPollingOutbox = false;
let outboxPollDelay = 15000;

async function runOutboxPoll() {
    if (isPollingOutbox || connectionStatus !== 'connected' || !sock) {
        setTimeout(runOutboxPoll, outboxPollDelay);
        return;
    }
    isPollingOutbox = true;

    try {
        const res = await axios.get(OUTBOX_URL, { timeout: 8000 });
        const messages = res.data?.messages || [];

        if (messages.length > 0) {
            outboxPollDelay = 3000; // Percepat polling saat ada pesan aktif
            for (const item of messages) {
                const rawTarget = (item.phone_number || '').trim();
                if (!rawTarget || !item.message) continue;

                let jid = rawTarget;
                if (rawTarget.includes('@g.us') || rawTarget.includes('@lid') || rawTarget.includes('@s.whatsapp.net')) {
                    jid = rawTarget;
                } else {
                    const clean = rawTarget.replace(/[^0-9]/g, '');
                    if (!clean) continue;
                    if (clean.length > 13 && !clean.startsWith('628') && !clean.startsWith('08')) {
                        jid = `${clean}@lid`;
                    } else {
                        let formatted = clean;
                        if (formatted.startsWith('08')) formatted = '62' + formatted.slice(1);
                        jid = `${formatted}@s.whatsapp.net`;
                    }
                }

                try {
                    console.log(`[Outbox] Mengirim notifikasi ke ${jid}...`);
                    await sock.sendMessage(jid, { text: item.message });
                    await axios.post(CONFIRM_URL, { id: item.id, status: 'sent' }, { timeout: 5000 });
                    console.log(`[Outbox] Notifikasi #${item.id} berhasil terkirim ke ${jid}!`);
                } catch (sendErr) {
                    console.warn(`[Outbox Warning] Gagal kirim #${item.id} ke ${jid}: ${sendErr.message}. Mencoba fallback...`);
                    let altJid = null;
                    if (jid.endsWith('@lid')) {
                        altJid = jid.replace('@lid', '@s.whatsapp.net');
                    } else if (jid.endsWith('@s.whatsapp.net') && !jid.startsWith('628')) {
                        altJid = jid.replace('@s.whatsapp.net', '@lid');
                    }
                    let success = false;
                    if (altJid) {
                        try {
                            console.log(`[Outbox] Mencoba fallback ke ${altJid}...`);
                            await sock.sendMessage(altJid, { text: item.message });
                            await axios.post(CONFIRM_URL, { id: item.id, status: 'sent' }, { timeout: 5000 });
                            console.log(`[Outbox] Fallback #${item.id} berhasil terkirim ke ${altJid}!`);
                            success = true;
                        } catch (altErr) {
                            console.error(`[Outbox Error] Fallback juga gagal: ${altErr.message}`);
                        }
                    }
                    if (!success) {
                        await axios.post(CONFIRM_URL, { id: item.id, status: 'failed', error: sendErr.message }, { timeout: 5000 }).catch(() => {});
                    }
                }
            }
        } else {
            outboxPollDelay = 15000; // Antrean kosong: perlambat untuk hemat kuota hosting
        }

    } catch (pollErr) {
        outboxPollDelay = 25000; // Glitch jaringan / server busy: tunggu 25 detik
    } finally {
        isPollingOutbox = false;
        setTimeout(runOutboxPoll, outboxPollDelay);
    }
}
setTimeout(runOutboxPoll, 5000);

// ===== DAEMON POLLING EMAIL OUTBOX: ADAPTIVE SMART POLLING =====
const EMAIL_OUTBOX_URL = WEBHOOK_URL.replace(/\/webhook\/?$/, '/email_outbox');
const CONFIRM_EMAIL_URL = WEBHOOK_URL.replace(/\/webhook\/?$/, '/confirm_email_outbox');

let isPollingEmailOutbox = false;
let emailPollDelay = 20000;

async function runEmailPoll() {
    if (isPollingEmailOutbox) {
        setTimeout(runEmailPoll, emailPollDelay);
        return;
    }
    isPollingEmailOutbox = true;

    try {
        const res = await axios.get(EMAIL_OUTBOX_URL, { timeout: 8000 });
        const emails = res.data?.emails || [];

        if (emails.length > 0) {
            emailPollDelay = 3000; // Percepat saat ada email menunggu
            for (const item of emails) {
                const to = (item.recipient || '').trim();
                if (!to || !item.subject) continue;

                try {
                    console.log(`[Email Outbox] Mengirim email #${item.id} ke ${to}...`);
                    const gasRes = await axios.post(GAS_DEFAULT_URL, {
                        key: GAS_SECRET,
                        to: to,
                        subject: item.subject,
                        body: item.plain_body || 'Silakan buka email ini menggunakan aplikasi atau browser yang mendukung HTML.',
                        html: item.html_message || '',
                        sender_name: item.sender_name || 'Mapala Peregrina UNISM'
                    }, {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 15000,
                        maxRedirects: 5
                    });

                    await axios.post(CONFIRM_EMAIL_URL, { id: item.id, status: 'sent', response: JSON.stringify(gasRes.data) }, { timeout: 5000 });
                    console.log(`[Email Outbox] Email #${item.id} berhasil terkirim ke ${to}!`);
                } catch (err) {
                    console.error(`[Email Outbox Error] Gagal kirim #${item.id} ke ${to}: ${err.message}`);
                    await axios.post(CONFIRM_EMAIL_URL, { id: item.id, status: 'failed', error: err.message }, { timeout: 5000 });
                }
            }
        } else {
            emailPollDelay = 20000; // Antrean kosong: hemat kuota hosting
        }
    } catch (e) {
        emailPollDelay = 30000; // Glitch jaringan: tunggu 30 detik
    } finally {
        isPollingEmailOutbox = false;
        setTimeout(runEmailPoll, emailPollDelay);
    }
}
setTimeout(runEmailPoll, 8000);

// ===== API REST ENDPOINTS UNTUK PANEL DEVELOPER =====

app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        botUser,
        connectedAt,
        webhookUrl: WEBHOOK_URL
    });
});

// ===== WEB UI UNTUK SCAN QR DI CLOUD (MOBILE-FRIENDLY) =====
app.get('/', (req, res) => res.redirect('/qr'));

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        wa_status: connectionStatus,
        bot: botUser
    });
});

app.get('/qr', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bot Gateway - Mapala Peregrina</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@4.6.2/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.4/css/all.min.css">
    <style>
        body { background: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
        .card-qr { background: #fff; border-radius: 18px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); max-width: 440px; width: 100%; border: 1px solid #e2e8f0; overflow: hidden; }
        .header-banner { background: linear-gradient(135deg, #16a34a, #059669); color: white; padding: 24px; text-align: center; }
    </style>
</head>
<body>
    <div class="card-qr">
        <div class="header-banner">
            <i class="fab fa-whatsapp fa-3x mb-2"></i>
            <h4 class="font-weight-bold mb-1">Mapala Peregrina</h4>
            <p class="small mb-0 opacity-80">WhatsApp Cloud Gateway (24/7 Online)</p>
        </div>
        <div class="p-4 text-center" id="content-box">
            <div class="spinner-border text-success my-4" role="status"></div>
            <p class="text-muted small">Memeriksa status koneksi WhatsApp...</p>
        </div>
    </div>
    <script>
        async function checkStatus() {
            try {
                const r = await fetch('/api/status');
                const data = await r.json();
                const box = document.getElementById('content-box');
                if (data.status === 'connected') {
                    box.innerHTML = \`
                        <div class="py-3">
                            <div style="width:68px; height:68px; border-radius:50%; background:#dcfce7; color:#16a34a; display:inline-flex; align-items:center; justify-content:center; font-size:30px; margin-bottom:14px;">
                                <i class="fas fa-check"></i>
                            </div>
                            <h5 class="font-weight-bold text-success mb-1">\${data.botUser?.name || 'Bot Terhubung'}</h5>
                            <p class="text-muted font-weight-bold small mb-3">\${data.botUser?.id ? '+' + data.botUser.id.replace(/[^0-9]/g, '') : 'Aktif'}</p>
                            <span class="badge badge-success px-3 py-2 font-weight-bold">Status: Online 24/7 di Cloud</span>
                            <p class="small text-muted mt-3 mb-0">Bot WhatsApp siap melayani pesan pribadi & grup tanpa perlu laptop menyala!</p>
                            <div class="mt-4 pt-3 border-top">
                                <button class="btn btn-sm btn-outline-danger" onclick="resetSession()">
                                    <i class="fas fa-power-off mr-1"></i> Putuskan Sesi &amp; Buat QR Baru
                                </button>
                            </div>
                        </div>
                    \`;
                } else if (data.status === 'qr_ready') {
                    const qrR = await fetch('/api/qr');
                    const qrData = await qrR.json();
                    if (qrData.qr) {
                        box.innerHTML = \`
                            <h6 class="font-weight-bold text-dark mb-1">Pindai QR Code untuk Menautkan</h6>
                            <p class="small text-muted mb-3">Buka WhatsApp &gt; Perangkat Tertaut &gt; Tautkan Perangkat</p>
                            <div class="p-2 border rounded bg-light d-inline-block mb-3 shadow-sm">
                                <img src="\${qrData.qr}" style="width:220px; height:220px;" alt="QR Code">
                            </div>
                            <p class="small text-muted mb-3"><i class="fas fa-sync fa-spin mr-1 text-primary"></i> Otomatis diperbarui setiap saat</p>
                            <div class="pt-2 border-top">
                                <button class="btn btn-sm btn-outline-secondary" onclick="resetSession()">
                                    <i class="fas fa-redo-alt mr-1"></i> Refresh / Bersihkan Sesi
                                </button>
                            </div>
                        \`;
                    }
                } else {
                    box.innerHTML = \`
                        <div class="py-4">
                            <div class="spinner-border text-primary mb-3"></div>
                            <h6 class="font-weight-bold text-dark">Menyiapkan Koneksi Gateway...</h6>
                            <p class="small text-muted mb-0">Sedang menginisialisasi modul Baileys di cloud.</p>
                        </div>
                    \`;
                }
            } catch(e) {}
        }

        async function resetSession() {
            if (!confirm('Apakah Anda yakin ingin mengatur ulang sesi WhatsApp dan membuat QR Code baru?')) return;
            try {
                const box = document.getElementById('content-box');
                box.innerHTML = '<div class="py-4"><div class="spinner-border text-warning mb-3"></div><p class="text-muted small">Mereset sesi & menyiapkan QR baru...</p></div>';
                await fetch('/api/clean', { method: 'POST' });
                setTimeout(checkStatus, 2000);
            } catch(e) {
                alert('Gagal reset: ' + e.message);
            }
        }

        checkStatus();
        setInterval(checkStatus, 3000);
    </script>
</body>
</html>`);
});

app.get('/api/debug', (req, res) => {
    res.json({
        hostname: require('os').hostname(),
        pid: process.pid,
        connectionStatus,
        botUser,
        connectedAt,
        lastDisconnectInfo,
        uptime: process.uptime()
    });
});

app.get('/api/qr', (req, res) => {

    if (connectionStatus === 'connected') {
        return res.json({
            status: 'connected',
            message: 'Bot WhatsApp sudah terhubung.',
            botUser
        });
    }

    if (qrDataUrl) {
        return res.json({
            status: 'qr_ready',
            qr: qrDataUrl
        });
    }

    return res.json({
        status: connectionStatus,
        message: 'QR Code sedang disiapkan...'
    });
});

app.post('/api/send', async (req, res) => {
    const { to, message } = req.body;
    if (!sock || connectionStatus !== 'connected') {
        return res.status(400).json({ status: 'error', message: 'Bot WhatsApp belum terhubung.' });
    }
    if (!to || !message) {
        return res.status(400).json({ status: 'error', message: 'Nomor tujuan (to) dan pesan (message) wajib diisi.' });
    }

    try {
        let jid = to;
        if (!jid.includes('@')) {
            const clean = to.replace(/[^0-9]/g, '');
            jid = `${clean}@s.whatsapp.net`;
        }
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'success', message: 'Pesan berhasil dikirim.' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ===== TELEGRAM WEBHOOK RELAY (BYPASS INFINITYFREE AES SHIELD) =====
const TG_TARGET_WEBHOOK = WEBHOOK_URL.replace(/\/whatsapp\/webhook\/?$/, '/telegram/webhook');

app.post('/telegram/webhook', async (req, res) => {
    // Balas 200 OK langsung ke Telegram
    res.status(200).send('OK');

    // Teruskan payload ke CodeIgniter di InfinityFree dengan Cookie Bypass otomatis
    try {
        console.log('[Telegram Relay] Menerima update dari Telegram, meneruskan ke CI3...');
        await axios.post(TG_TARGET_WEBHOOK, req.body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });
        console.log('[Telegram Relay] Sukses diteruskan ke CI3.');
    } catch (err) {
        console.error('[Telegram Relay Error] Gagal meneruskan ke CI3:', err.message);
    }
});

// ===== TELEGRAM API CALL RELAY (BYPASS INFINITYFREE DNS/OUTGOING FIREWALL) =====
app.post('/api/telegram-call/:method', async (req, res) => {
    const { method } = req.params;
    const token = req.body.token || '8675881429:AAFGlRIx0rVKO7dOuHvLgCEy27zZh4iPPMI';
    const params = req.body.params || {};

    try {
        console.log(`[Telegram API Relay] Calling api.telegram.org -> ${method}`);
        const tgRes = await axios.post(`https://api.telegram.org/bot${token}/${method}`, params, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 20000
        });
        return res.json(tgRes.data);
    } catch (err) {
        console.error(`[Telegram API Relay Error] ${method}:`, err.response?.data || err.message);
        const status = err.response && err.response.status ? err.response.status : 500;
        return res.status(status).json(err.response && err.response.data ? err.response.data : { ok: false, description: err.message });
    }
});

// ===== TELEGRAM SEND DOCUMENT RELAY (SUPPORT BASE64 FILE UPLOAD) =====
app.post('/api/telegram-send-document', async (req, res) => {
    const token = req.body.token || '8675881429:AAFGlRIx0rVKO7dOuHvLgCEy27zZh4iPPMI';
    const { chat_id, caption, file_name, file_base64 } = req.body;

    if (!chat_id || !file_base64 || !file_name) {
        return res.status(400).json({ ok: false, description: 'chat_id, file_name, and file_base64 are required.' });
    }

    try {
        console.log(`[Telegram Document Relay] Mengirim file ${file_name} ke chat ID ${chat_id}...`);
        const fileBuffer = Buffer.from(file_base64, 'base64');
        const formData = new FormData();
        formData.append('chat_id', String(chat_id));
        if (caption) formData.append('caption', caption);
        formData.append('parse_mode', 'HTML');
        formData.append('document', new Blob([fileBuffer]), file_name);

        const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
            method: 'POST',
            body: formData
        });

        const tgData = await tgRes.json();
        console.log(`[Telegram Document Relay] Hasil kirim berkas:`, tgData.ok ? 'Sukses' : tgData.description);
        return res.json(tgData);
    } catch (err) {
        console.error('[Telegram Document Relay Error]', err.message);
        return res.status(500).json({ ok: false, description: err.message });
    }
});

// ===== DAILY DATABASE BACKUP SCHEDULER: 05:00 WITA (04:00 WIB / 21:00 UTC) =====
const AUTO_BACKUP_URL = WEBHOOK_URL.replace(/\/whatsapp\/webhook\/?$/, '/developer/cron_auto_backup');
let lastAutoBackupDay = '';

async function triggerAutoDatabaseBackup(triggerSource = 'Jadwal Otomatis 05:00 WITA') {
    try {
        console.log(`[Backup Scheduler] Menjalankan pencadangan database: ${triggerSource}...`);
        const cookie = await getInfinityCookie();
        const headers = { 'User-Agent': 'Mapala-Cron-Worker/1.0', 'Content-Type': 'application/x-www-form-urlencoded' };
        if (cookie) headers['Cookie'] = cookie;

        const postData = new URLSearchParams({
            secret: 'MAPALA_BACKUP_SECRET_2026',
            trigger: triggerSource
        }).toString();

        const res = await axios.post(AUTO_BACKUP_URL, postData, { headers, timeout: 90000 });
        console.log('[Backup Scheduler] Hasil pencadangan database:', res.data);
        return res.data;
    } catch (err) {
        console.error('[Backup Scheduler Error]', err.message);
        return { error: err.message };
    }
}

function checkDailyBackupSchedule() {
    const now = new Date();
    // Hitung waktu tepat di zona WITA (UTC+8)
    const witaTime = new Date(now.getTime() + (8 * 3600 * 1000));
    const witaHours = witaTime.getUTCHours();
    const witaMinutes = witaTime.getUTCMinutes();
    const todayWita = `${witaTime.getUTCFullYear()}-${witaTime.getUTCMonth() + 1}-${witaTime.getUTCDate()}`;

    // Jalankan setiap jam 05:00 WITA (antara 05:00 s.d 05:03) dan hanya 1x per hari
    if (witaHours === 5 && witaMinutes < 4 && lastAutoBackupDay !== todayWita) {
        lastAutoBackupDay = todayWita;
        console.log(`[Backup Scheduler] Waktu 05:00 WITA tiba (${todayWita}). Mengeksekusi backup database...`);
        triggerAutoDatabaseBackup('Jadwal Otomatis Harian 05:00 WITA');
    }
}

// Periksa setiap 30 detik
setInterval(checkDailyBackupSchedule, 30000);

// Endpoint manual trigger pencadangan database via Railway
app.all('/api/trigger-backup', async (req, res) => {
    const key = req.query.key || (req.body && req.body.key);
    if (key !== 'MAPALA_BACKUP_SECRET_2026') {
        return res.status(403).json({ ok: false, error: 'Unauthorized secret key' });
    }
    const source = req.query.source || (req.body && req.body.source) || 'Manual API Trigger';
    const result = await triggerAutoDatabaseBackup(source);
    return res.json({ ok: true, result });
});

// ===== EMAIL CLOUD RELAY (HTTPS GATEWAY FOR GOOGLE APPS SCRIPT) =====
const GAS_DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbx0ODR1jVy2lf-klShJ29SY2QEfLylM7MWhBM-u-xX8bqpK4t0WOD37_y3ctxVaeqk2/exec';
const GAS_SECRET = 'MAPALA_PEREGRINA_SECRET_2026';

app.post('/api/send-email', async (req, res) => {
    const { to, subject, html, body, sender_name, gas_url } = req.body;
    if (!to || !subject) {
        return res.status(400).json({ status: 'error', message: 'Tujuan (to) dan perihal (subject) email wajib diisi.' });
    }

    try {
        const targetUrl = gas_url || GAS_DEFAULT_URL;
        console.log(`[Email Relay] Mengirim email ke ${to} via Google Apps Script...`);
        const response = await axios.post(targetUrl, {
            key: GAS_SECRET,
            to: to,
            subject: subject,
            body: body || 'Silakan buka email ini menggunakan aplikasi atau browser yang mendukung tampilan HTML.',
            html: html || '',
            sender_name: sender_name || 'Mapala Peregrina UNISM'
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
            maxRedirects: 5
        });

        console.log(`[Email Relay] Respon GAS:`, response.status, response.data);
        return res.json({
            status: 'success',
            message: 'Email berhasil dikirim via Railway Cloud Relay',
            data: response.data
        });
    } catch (err) {
        console.error(`[Email Relay Error]`, err.message);
        return res.status(500).json({
            status: 'error',
            message: 'Gagal mengirim email: ' + err.message,
            detail: err.response ? err.response.data : null
        });
    }
});

// ===== GOOGLE DRIVE CLOUD STORAGE RELAY =====
app.post('/api/gdrive-upload', async (req, res) => {
    const { file_name, file_base64, folder, mime_type, overwrite, gas_url } = req.body;
    if (!file_name || !file_base64) {
        return res.status(400).json({ status: 'error', message: 'file_name dan file_base64 wajib disertakan.' });
    }

    try {
        const targetUrl = gas_url || GAS_DEFAULT_URL;
        console.log(`[GDrive Relay] Mengunggah file ${file_name} ke Google Drive (${folder || 'Umum'})...`);
        const payload = {
            key: GAS_SECRET,
            action: 'upload_file',
            file_name,
            file_base64,
            folder: folder || 'Umum',
            mime_type: mime_type || '',
            overwrite: overwrite !== false
        };

        const response = await axios.post(targetUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000,
            maxRedirects: 5
        });

        console.log(`[GDrive Relay] Respon GAS:`, response.status, response.data);
        return res.json(response.data);
    } catch (err) {
        console.error(`[GDrive Relay Error]`, err.message);
        return res.status(500).json({
            status: 'error',
            message: 'Gagal mengunggah ke Google Drive: ' + err.message,
            detail: err.response ? err.response.data : null
        });
    }
});

app.post('/api/gdrive-status', async (req, res) => {
    try {
        const targetUrl = (req.body && req.body.gas_url) || GAS_DEFAULT_URL;
        const response = await axios.post(targetUrl, {
            key: GAS_SECRET,
            action: 'status'
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
            maxRedirects: 5
        });
        return res.json(response.data);
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

app.post('/api/restart', async (req, res) => {
    try {
        if (sock) {
            sock.end(new Error('Manual Restart'));
        }
        setTimeout(() => startWhatsApp(), 1500);
        res.json({ status: 'success', message: 'Gateway sedang di-restart...' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        if (sock) {
            try {
                await sock.logout();
            } catch (e) {}
            try {
                sock.ev.removeAllListeners();
                sock.end();
            } catch (e) {}
            sock = null;
        }
        clearSessionFiles();

        // Bersihkan cadangan sesi di database web
        try {
            const DEL_URL = WEBHOOK_URL.replace(/\/webhook\/?$/, '/save_session');
            await axios.post(DEL_URL, { session_data: '' }, { timeout: 10000 });
        } catch (e) {}

        isStarting = false;
        clearTimeout(reconnectTimer);
        setTimeout(() => startWhatsApp(), 2000);
        res.json({ status: 'success', message: 'Sesi WhatsApp berhasil diputuskan (logout).' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.all('/api/clean', async (req, res) => {
    try {
        if (sock) {
            try { sock.ev.removeAllListeners(); sock.end(undefined); } catch (e) {}
            sock = null;
        }
        clearSessionFiles();

        // Bersihkan cadangan sesi di database web agar sesi lama tidak ditarik kembali
        try {
            const DEL_URL = WEBHOOK_URL.replace(/\/webhook\/?$/, '/save_session');
            await axios.post(DEL_URL, { session_data: '' }, { timeout: 8000 });
        } catch (e) {}

        isStarting = false;
        clearTimeout(reconnectTimer);
        setTimeout(() => startWhatsApp(), 1500);
        res.json({ status: 'success', message: 'Folder sesi dibersihkan. Memulai QR baru...' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`[Assistant Peregrina WA Gateway] Berjalan di port ${PORT}`);
    console.log(`[Assistant Peregrina WA Gateway] Target Webhook: ${WEBHOOK_URL}`);
    console.log(`[Assistant Peregrina WA Gateway] Outbox Queue Polling: Aktif`);
    startWhatsApp();
});
