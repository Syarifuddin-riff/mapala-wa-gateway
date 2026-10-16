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
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

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

// ===== CLOUD SESSION SYNC (CADANGAN SESI OTOMATIS KE DATABASE WEB) =====
async function syncSessionFromCloud() {
    try {
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
        }
        const credsFile = path.join(SESSION_DIR, 'creds.json');
        if (!fs.existsSync(credsFile)) {
            console.log('[Baileys] Memeriksa cadangan sesi dari database web...');
            const LOAD_URL = WEBHOOK_URL.replace(/\/webhook\/?$/, '/load_session');
            const res = await axios.get(LOAD_URL, { timeout: 10000 });
            if (res.data?.session_data) {
                const parsed = JSON.parse(Buffer.from(res.data.session_data, 'base64').toString('utf8'));
                for (const [fname, content] of Object.entries(parsed)) {
                    fs.writeFileSync(path.join(SESSION_DIR, fname), content, 'utf8');
                }
                console.log('[Baileys] Sesi berhasil dipulihkan dari database web! Menghubungkan otomatis...');
            }
        }
    } catch (e) {
        console.warn('[Session Sync Warning]', e.message);
    }
}

let syncTimeout = null;
function backupSessionToCloud() {
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async () => {
        try {
            if (!fs.existsSync(SESSION_DIR)) return;
            const files = fs.readdirSync(SESSION_DIR);
            const bundle = {};
            for (const f of files) {
                if (f.endsWith('.json')) {
                    bundle[f] = fs.readFileSync(path.join(SESSION_DIR, f), 'utf8');
                }
            }
            if (Object.keys(bundle).length > 0) {
                const b64 = Buffer.from(JSON.stringify(bundle)).toString('base64');
                const SAVE_URL = WEBHOOK_URL.replace(/\/webhook\/?$/, '/save_session');
                await axios.post(SAVE_URL, { session_data: b64 }, { timeout: 10000 });
                console.log('[Baileys] Cadangan sesi berhasil disinkronkan ke database web!');
            }
        } catch (e) {
            console.warn('[Session Backup Warning]', e.message);
        }
    }, 4000);
}

async function startWhatsApp() {
    connectionStatus = 'connecting';
    qrDataUrl = null;

    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.end();
        } catch (e) {}
        sock = null;
    }

    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    // Pulihkan sesi dari database web jika belum ada di lokal/cloud
    await syncSessionFromCloud();

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Assistant Peregrina', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        backupSessionToCloud();
    });

    sock.ev.on('connection.update', async (update) => {
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
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || String(lastDisconnect?.error);
            lastDisconnectInfo = { statusCode, error: errorMsg, time: new Date().toISOString() };
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[Baileys] Koneksi terputus (status: ${statusCode}, msg: ${errorMsg}). Reconnect: ${shouldReconnect}`);

            connectionStatus = 'disconnected';
            qrDataUrl = null;
            botUser = null;

            if (shouldReconnect) {
                const delay = (statusCode === 515 || statusCode === 428) ? 1500 : 4000;
                setTimeout(() => startWhatsApp(), delay);
            } else {
                console.log('[Baileys] Device logged out. Menghapus sesi lama...');
                try {
                    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                } catch (e) {}
                setTimeout(() => startWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            connectionStatus = 'connected';
            qrDataUrl = null;
            connectedAt = new Date().toISOString();
            botUser = {
                id: sock.user?.id || '',
                name: sock.user?.name || 'Assistant Peregrina'
            };
            console.log(`[Baileys] Terhubung ke WhatsApp! Akun: ${botUser.id} (${botUser.name})`);
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

// ===== DAEMON POLLING OUTBOX: NOTIFIKASI INSTAN DEVELOPER =====
let isPollingOutbox = false;
setInterval(async () => {
    if (isPollingOutbox || connectionStatus !== 'connected' || !sock) return;
    isPollingOutbox = true;

    try {
        const res = await axios.get(OUTBOX_URL, { timeout: 8000 });
        const messages = res.data?.messages || [];

        for (const item of messages) {
            const rawTarget = (item.phone_number || '').trim();
            if (!rawTarget || !item.message) continue;

            let jid = rawTarget;
            if (rawTarget.includes('@g.us') || rawTarget.includes('@lid') || rawTarget.includes('@s.whatsapp.net')) {
                jid = rawTarget;
            } else {
                const clean = rawTarget.replace(/[^0-9]/g, '');
                if (!clean) continue;
                // Jika format menyerupai LID (>=14 digit dan tidak diawali nomor HP lokal 628/08), gunakan @lid
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

    } catch (pollErr) {
        // Silent ignore on network glitch
    } finally {
        isPollingOutbox = false;
    }
}, 3000);

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
                            <p class="small text-muted mb-0"><i class="fas fa-sync fa-spin mr-1 text-primary"></i> Otomatis diperbarui setiap saat</p>
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
        checkStatus();
        setInterval(checkStatus, 3000);
    </script>
</body>
</html>`);
});

app.get('/api/debug', (req, res) => {
    res.json({
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
            await sock.logout();
        }
        try {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        } catch (e) {}
        setTimeout(() => startWhatsApp(), 2000);
        res.json({ status: 'success', message: 'Sesi WhatsApp berhasil diputuskan (logout).' });
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
