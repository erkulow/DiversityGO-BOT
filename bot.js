const { google } = require('googleapis');
const axios = require('axios');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN = process.env.TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = 'Opendeck';
const CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 минут
const TG = `https://api.telegram.org/bot${TOKEN}`;
// ──────────────────────────────────────────────────────────────────────────────

const subscribers = new Set();
const readySince = new Map();
let offset = 0;

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────

async function tgRequest(method, data) {
	try {
		const res = await axios.post(`${TG}/${method}`, data, { timeout: 10000 });
		return res.data;
	} catch (err) {
		console.error(
			`❌ TG ${method}:`,
			err.response?.data?.description || err.message,
		);
		return null;
	}
}

// Кнопки которые всегда показываются в чате (ReplyKeyboardMarkup)
const MAIN_KEYBOARD = {
	keyboard: [[{ text: '🔍 Check now' }, { text: '🚛 Who is READY?' }]],
	resize_keyboard: true,
	persistent: true,
};

async function sendMessage(chatId, text, extra = {}) {
	return tgRequest('sendMessage', {
		chat_id: chatId,
		text,
		reply_markup: MAIN_KEYBOARD,
		...extra,
	});
}

async function getUpdates() {
	const res = await tgRequest('getUpdates', {
		offset,
		timeout: 30,
		allowed_updates: ['message', 'callback_query'],
	});
	return res?.result || [];
}

// ─── POLLING LOOP ─────────────────────────────────────────────────────────────

async function poll() {
	const updates = await getUpdates();

	for (const update of updates) {
		offset = update.update_id + 1;
		const msg = update.message;
		if (!msg) continue;

		const chatId = msg.chat.id;
		const text = (msg.text || '').trim();
		const name = msg.from?.first_name || 'friend';

		if (text === '/start') {
			subscribers.add(chatId);
			console.log(`➕ Subscribed: ${name} (${chatId})`);
			await sendMessage(
				chatId,
				`👋 Hi ${name}!\n\n` +
					`✅ Subscribed to READY alerts.\n` +
					`Bot sends updates every 5 minutes.\n\n` +
					`Use the buttons below 👇`,
			);
		} else if (text === '🔕 Unsubscribe' || text === '/stop') {
			subscribers.delete(chatId);
			await tgRequest('sendMessage', {
				chat_id: chatId,
				text: '🔕 Unsubscribed. Send /start to subscribe again.',
				reply_markup: { remove_keyboard: true },
			});
		} else if (text === '🔍 Check now' || text === '/check') {
			await sendMessage(chatId, '🔍 Checking...');
			try {
				const entries = await findReadyDrivers();
				if (entries.length === 0) {
					await sendMessage(chatId, '✅ No READY drivers right now.');
				} else {
					for (const e of entries) {
						const since = readySince.get(e.driver) || new Date();
						await sendMessage(chatId, buildMessage(e, since));
					}
				}
			} catch (err) {
				await sendMessage(chatId, `⚠️ Error: ${err.message}`);
			}
		} else if (text === '🚛 Who is READY?' || text === '/ready') {
			if (readySince.size === 0) {
				await sendMessage(chatId, '✅ No drivers currently READY.');
			} else {
				let t = `🚛 Currently READY (${readySince.size}):\n\n`;
				for (const [driver, since] of readySince.entries()) {
					t += `• ${driver} — ${getDuration(since)}\n`;
				}
				await sendMessage(chatId, t);
			}
		}
	}

	setImmediate(poll);
}

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────

async function fetchSheetData() {
	const auth = new google.auth.GoogleAuth({
		credentials: CREDENTIALS,
		scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
	});
	const sheets = google.sheets({ version: 'v4', auth });
	const res = await sheets.spreadsheets.values.get({
		spreadsheetId: SHEET_ID,
		range: SHEET_NAME,
	});
	return res.data.values || [];
}

async function findReadyDrivers() {
	const rows = await fetchSheetData();
	const result = [];
	const header = rows[0] || [];

	rows.forEach((row, ri) => {
		if (ri === 0) return;
		row.forEach((cell, ci) => {
			if (String(cell).trim().toLowerCase() === 'ready') {
				const driver = row[2] ? row[2].trim() : '';
				if (!driver || driver === '—') return;
				result.push({
					driver,
					company: row[0] || '—',
					dispatcher: row[1] || '—',
					phone: row[3] || '—',
					date: header[ci] || `Col ${ci + 1}`,
				});
			}
		});
	});

	return result;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getDuration(since) {
	const diff = Math.floor((Date.now() - since.getTime()) / 60000);
	if (diff < 60) return `${diff} mins`;
	const hrs = Math.floor(diff / 60);
	const mins = diff % 60;
	return mins > 0 ? `${hrs} hr ${mins} mins` : `${hrs} hr`;
}

function buildMessage(entry, since) {
	const duration = since ? getDuration(since) : '0 mins';
	return (
		`🚛 ${entry.driver} is ready for ${duration}\n` +
		`🏢 Company: ${entry.company}\n` +
		`👤 Dispatcher: ${entry.dispatcher}\n` +
		`📞 Phone: ${entry.phone}\n` +
		`📅 Date: ${entry.date}`
	);
}

// ─── CORE LOGIC ───────────────────────────────────────────────────────────────

async function checkAndNotify() {
	if (subscribers.size === 0) {
		console.log(
			`[${new Date().toLocaleTimeString()}] No subscribers, skipping.`,
		);
		return;
	}

	console.log(`[${new Date().toLocaleTimeString()}] Checking...`);

	let current;
	try {
		current = await findReadyDrivers();
	} catch (err) {
		console.error('❌ Sheet error:', err.message);
		return;
	}

	const now = new Date();
	const currentNames = new Set(current.map((e) => e.driver));

	for (const name of readySince.keys()) {
		if (!currentNames.has(name)) {
			readySince.delete(name);
			console.log(`➖ Left READY: ${name}`);
		}
	}

	for (const e of current) {
		if (!readySince.has(e.driver)) {
			readySince.set(e.driver, now);
			console.log(`➕ New READY: ${e.driver}`);
		}
	}

	if (current.length === 0) {
		console.log('✅ No READY drivers.');
		return;
	}

	for (const entry of current) {
		const since = readySince.get(entry.driver);
		const message = buildMessage(entry, since);
		for (const chatId of subscribers) {
			await sendMessage(chatId, message);
		}
	}

	console.log(
		`✅ Sent ${current.length} driver(s) to ${subscribers.size} subscriber(s).`,
	);
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

// ─── ЗАПУСК ───────────────────────────────────────────────────────────────────
console.log('🚀 Bot started');
console.log(`📋 Sheet: ${SHEET_NAME} | ⏱ Every 5 min\n`);

axios.post(`${TG}/deleteWebhook`).then(() => poll());

checkAndNotify();
setInterval(checkAndNotify, CHECK_INTERVAL_MS);
