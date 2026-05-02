const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN = process.env.TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = 'Opendeck';
const CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 минуты
// ──────────────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(TOKEN, { polling: true });
const subscribers = new Set();

// driver name -> Date (когда впервые стал READY)
const readySince = new Map();

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────

function getAuth() {
	return new google.auth.GoogleAuth({
		credentials: CREDENTIALS,
		scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
	});
}

async function fetchSheetData() {
	const sheets = google.sheets({ version: 'v4', auth: getAuth() });
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
				result.push({
					driver: row[2] || '—',
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

/**
 * Считает сколько минут/часов прошло с since
 * "5 mins" | "1 hr 30 mins" | "2 hrs"
 */
function getDuration(since) {
	const diff = Math.floor((Date.now() - since.getTime()) / 60000);
	if (diff < 60) return `${diff} mins`;
	const hrs = Math.floor(diff / 60);
	const mins = diff % 60;
	return mins > 0 ? `${hrs} hr ${mins} mins` : `${hrs} hr`;
}

/**
 * Форматирует сообщение:
 * 🚛 Ahmet # 315216 is ready for 30 mins
 * 🏢 Company: DTL
 * 👤 Dispatcher: Alan
 * 📞 Phone: 813-416-0293
 * 📅 Date: 27 апр.
 */
function buildMessage(entry, since) {
	const duration = since ? getDuration(since) : '0 mins';
	return (
		`🚛 ${entry.driver} _*is ready for ${duration}*_\n` +
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

	// Убираем тех кто вышел из READY
	for (const name of readySince.keys()) {
		if (!currentNames.has(name)) {
			readySince.delete(name);
			console.log(`➖ Left READY: ${name}`);
		}
	}

	// Только новые
	const newReady = current.filter((e) => !readySince.has(e.driver));
	for (const e of newReady) {
		readySince.set(e.driver, now);
		console.log(`➕ New READY: ${e.driver}`);
	}

	if (newReady.length === 0) {
		console.log('✅ No new READY drivers.');
		return;
	}

	// Отправляем только новых
	for (const entry of newReady) {
		const since = readySince.get(entry.driver);
		const message = buildMessage(entry, since);

		for (const chatId of subscribers) {
			try {
				await bot.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
			} catch (err) {
				console.error(`❌ Send error ${chatId}:`, err.message);
				if (err.response?.body?.error_code === 403) subscribers.delete(chatId);
			}
		}
	}

	console.log(`✅ Notified: ${newReady.length} driver(s).`);
}

// ─── КОМАНДЫ ──────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
	const chatId = msg.chat.id;
	subscribers.add(chatId);
	console.log(`➕ Subscribed: ${msg.from.first_name} (${chatId})`);
	bot.sendMessage(
		chatId,
		`👋 Hi *${msg.from.first_name || 'friend'}*\\!\n\n` +
			`✅ Subscribed to *READY* alerts\\.\n` +
			`Checks every *2 minutes*\\.\n\n` +
			`/check \\— check right now\n` +
			`/ready \\— who is READY now\n` +
			`/stop \\— unsubscribe`,
		{ parse_mode: 'MarkdownV2' },
	);
});

bot.onText(/\/stop/, (msg) => {
	subscribers.delete(msg.chat.id);
	bot.sendMessage(
		msg.chat.id,
		'🔕 Unsubscribed\\. Send /start to subscribe again\\.',
		{ parse_mode: 'MarkdownV2' },
	);
});

bot.onText(/\/check/, async (msg) => {
	const chatId = msg.chat.id;
	await bot.sendMessage(chatId, '🔍 Checking\\.\\.\\.', {
		parse_mode: 'MarkdownV2',
	});
	try {
		const entries = await findReadyDrivers();
		if (entries.length === 0) {
			await bot.sendMessage(chatId, '✅ No READY drivers right now\\.', {
				parse_mode: 'MarkdownV2',
			});
			return;
		}
		for (const e of entries) {
			const since = readySince.get(e.driver) || new Date();
			await bot.sendMessage(chatId, buildMessage(e, since), {
				parse_mode: 'MarkdownV2',
			});
		}
	} catch (err) {
		await bot.sendMessage(chatId, `⚠️ Error: ${err.message}`);
	}
});

bot.onText(/\/ready/, (msg) => {
	const chatId = msg.chat.id;
	if (readySince.size === 0) {
		bot.sendMessage(chatId, '✅ No drivers currently READY\\.', {
			parse_mode: 'MarkdownV2',
		});
		return;
	}
	let text = `🚛 *Currently READY \\(${readySince.size}\\):*\n\n`;
	for (const [driver, since] of readySince.entries()) {
		text += `• *${driver}* \\— ${getDuration(since)}\n`;
	}
	bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
});

// ─── HTTP (чтобы Render не засыпал) ──────────────────────────────────────────
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

// ─── ЗАПУСК ───────────────────────────────────────────────────────────────────
console.log('🚀 Bot started');
console.log(`📋 Sheet: ${SHEET_NAME} | ⏱ Every 2 min\n`);

checkAndNotify();
setInterval(checkAndNotify, CHECK_INTERVAL_MS);
