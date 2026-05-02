const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN = process.env.TOKEN; // Telegram bot token
const SHEET_ID = process.env.SHEET_ID; // Google Sheets ID из ссылки
const SHEET_NAME = 'Opendesk'; // Имя листа
const CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS); // JSON сервисного аккаунта
const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 минуты
// ──────────────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(TOKEN, { polling: true });
const subscribers = new Set();

// Храним водителей в READY: driver -> время когда впервые увидели
const readySince = new Map();

/**
 * Авторизация через сервисный аккаунт
 */
function getAuthClient() {
	return new google.auth.GoogleAuth({
		credentials: CREDENTIALS,
		scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
	});
}

/**
 * Читает данные из Google Sheets
 */
async function fetchSheetData() {
	const auth = getAuthClient();
	const sheets = google.sheets({ version: 'v4', auth });

	const response = await sheets.spreadsheets.values.get({
		spreadsheetId: SHEET_ID,
		range: SHEET_NAME,
	});

	return response.data.values || [];
}

/**
 * Ищет водителей со статусом READY
 */
async function findReadyDrivers() {
	const rows = await fetchSheetData();
	const readyEntries = [];
	const headerRow = rows[0] || [];

	rows.forEach((row, rowIndex) => {
		if (rowIndex === 0) return;

		row.forEach((cell, colIndex) => {
			if (String(cell).trim().toLowerCase() === 'ready') {
				readyEntries.push({
					driver: row[2] || '—',
					company: row[0] || '—',
					dispatcher: row[1] || '—',
					phone: row[3] || '—',
					date: headerRow[colIndex] || `Col ${colIndex + 1}`,
				});
			}
		});
	});

	return readyEntries;
}

/**
 * Форматирует время: "2:00 PM"
 */
function formatTime(date) {
	return date.toLocaleTimeString('en-US', {
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	});
}

/**
 * Основная проверка — уведомляет только о НОВЫХ водителях в READY
 */
async function checkAndNotify() {
	if (subscribers.size === 0) {
		console.log(
			`[${new Date().toLocaleTimeString()}] No subscribers, skipping.`,
		);
		return;
	}

	console.log(`[${new Date().toLocaleTimeString()}] Checking Google Sheets...`);

	let currentReady;
	try {
		currentReady = await findReadyDrivers();
	} catch (err) {
		console.error('❌ Sheet read error:', err.message);
		return;
	}

	const now = new Date();
	const currentNames = new Set(currentReady.map((e) => e.driver));

	// Убираем тех кто вышел из READY
	for (const name of readySince.keys()) {
		if (!currentNames.has(name)) {
			readySince.delete(name);
			console.log(`➖ No longer READY: ${name}`);
		}
	}

	// Новые водители в READY (которых ещё не было)
	const newReady = currentReady.filter((e) => !readySince.has(e.driver));

	for (const entry of newReady) {
		readySince.set(entry.driver, now);
		console.log(`➕ New READY: ${entry.driver} at ${formatTime(now)}`);
	}

	if (newReady.length === 0) {
		console.log('✅ No new READY drivers.');
		return;
	}

	// Отправляем уведомление
	for (const entry of newReady) {
		const since = readySince.get(entry.driver);
		const message = `🚛 *${entry.driver}* is READY since *${formatTime(since)}*`;

		for (const chatId of subscribers) {
			try {
				await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
			} catch (err) {
				console.error(`❌ Send error to ${chatId}:`, err.message);
				if (err.response?.body?.error_code === 403) {
					subscribers.delete(chatId);
				}
			}
		}
	}

	console.log(`✅ Notified: ${newReady.length} new READY driver(s).`);
}

// ─── КОМАНДЫ ──────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
	const chatId = msg.chat.id;
	subscribers.add(chatId);
	console.log(`➕ Subscribed: ${msg.from.first_name} (${chatId})`);

	bot.sendMessage(
		chatId,
		`👋 Hi *${msg.from.first_name || 'friend'}*!\n\n` +
			`✅ Subscribed to *READY* alerts.\n` +
			`Checks every *2 minutes*, notifies only when driver becomes READY.\n\n` +
			`/check — check right now\n` +
			`/ready — who is currently READY\n` +
			`/stop — unsubscribe`,
		{ parse_mode: 'Markdown' },
	);
});

bot.onText(/\/stop/, (msg) => {
	subscribers.delete(msg.chat.id);
	bot.sendMessage(
		msg.chat.id,
		'🔕 Unsubscribed. Send /start to subscribe again.',
	);
});

bot.onText(/\/check/, async (msg) => {
	const chatId = msg.chat.id;
	await bot.sendMessage(chatId, '🔍 Checking...');
	try {
		const entries = await findReadyDrivers();
		if (entries.length === 0) {
			await bot.sendMessage(chatId, '✅ No READY drivers right now.');
			return;
		}
		for (const e of entries) {
			const since = readySince.get(e.driver);
			const sinceText = since ? ` since *${formatTime(since)}*` : '';
			await bot.sendMessage(chatId, `🚛 *${e.driver}* is READY${sinceText}`, {
				parse_mode: 'Markdown',
			});
		}
	} catch (err) {
		await bot.sendMessage(chatId, `⚠️ Error: ${err.message}`);
	}
});

bot.onText(/\/ready/, (msg) => {
	const chatId = msg.chat.id;
	if (readySince.size === 0) {
		bot.sendMessage(chatId, '✅ No drivers currently READY.');
		return;
	}
	let text = `🚛 *Currently READY (${readySince.size}):*\n\n`;
	for (const [driver, since] of readySince.entries()) {
		text += `• *${driver}* — since ${formatTime(since)}\n`;
	}
	bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// ─── HTTP чтобы Render не засыпал ─────────────────────────────────────────────
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

// ─── ЗАПУСК ───────────────────────────────────────────────────────────────────
console.log('🚀 Bot started');
console.log(`📋 Sheet: ${SHEET_NAME} | ⏱ Every 2 min\n`);

checkAndNotify();
setInterval(checkAndNotify, CHECK_INTERVAL_MS);
