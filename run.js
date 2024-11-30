const axios = require('axios');
const cheerio = require('cheerio');
const colors = require('colors');
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const TelegramBot = require('node-telegram-bot-api');

const BASE_URL = 'https://burungvnix.com';
let pool;
const bot = new TelegramBot(config.telegramToken, { polling: true });

function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    switch (type) {
        case 'success':
            console.log(`[${timestamp}] ✔️  ${message}`.green);
            break;
        case 'error':
            console.log(`[${timestamp}] ❌  ${message}`.red);
            break;
        case 'warning':
            console.log(`[${timestamp}] ⚠️  ${message}`.yellow);
            break;
        default:
            console.log(`[${timestamp}] ℹ️  ${message}`.cyan);
    }
}

async function connectToDatabase() {
    try {
        pool = await mysql.createPool({
            host: config.database.host,
            user: config.database.user,
            password: config.database.password,
            database: config.database.database,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
        log('Terhubung ke pool database', 'success');
    } catch (error) {
        log(`Kesalahan koneksi pool database: ${error.message}`, 'error');
        throw error;
    }
}

async function checkDatabaseConnection() {
    if (!pool) {
        log('Koneksi pool terputus. Mencoba menghubungkan kembali...', 'warning');
        await connectToDatabase();
    }
}

async function checkAndCreateTable() {
    await checkDatabaseConnection();
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS pick_numbers (
            id INT AUTO_INCREMENT PRIMARY KEY,
            uuid CHAR(36) NOT NULL,
            nomor VARCHAR(20) NOT NULL,
            created_at DATETIME NOT NULL,
            updated_at DATETIME
        )
    `;
    const connection = await pool.getConnection();
    try {
        await connection.execute(createTableQuery);
        log('Tabel pick_numbers berhasil diperiksa/dibuat', 'success');
    } catch (error) {
        log(`Kesalahan memeriksa/membuat tabel: ${error.message}`, 'error');
        throw error;
    } finally {
        connection.release();
    }
}

async function saveNumbersToDatabase(numbers) {
    await checkDatabaseConnection();
    const connection = await pool.getConnection();
    const queryCheck = `SELECT nomor FROM pick_numbers WHERE nomor IN (?)`;
    const queryInsert = `
        INSERT INTO pick_numbers (uuid, nomor, created_at)
        VALUES ?
    `;

    try {
        const [existingNumbers] = await connection.query(queryCheck, [numbers]);
        const existingNumbersSet = new Set(existingNumbers.map(row => row.nomor));
        const newNumbers = numbers.filter(number => !existingNumbersSet.has(number));

        const duplicateCount = numbers.length - newNumbers.length;
        const successCount = newNumbers.length;

        if (newNumbers.length > 0) {
            const values = newNumbers.map(number => [
                uuidv4(),
                number,
                new Date().toISOString().slice(0, 19).replace('T', ' ')
            ]);

            await connection.query(queryInsert, [values]);
            log(`Batch ${successCount} nomor baru berhasil disimpan ke database`, 'success');
        }

        return {
            successCount: successCount,
            duplicateCount: duplicateCount
        };

    } catch (error) {
        log(`Kesalahan menyimpan batch ke database: ${error.message}`, 'error');
        throw error;
    } finally {
        connection.release();
    }
}

async function updateCookies(response) {
    if (response.headers['set-cookie']) {
        cookies = response.headers['set-cookie'].map(cookie => cookie.split(';')[0]).join('; ');
    }
}

async function getCSRFToken(html) {
    const $ = cheerio.load(html);
    return $('meta[name="csrf-token"]').attr('content') || $('input[name="authenticity_token"]').val();
}

async function login() {
    try {
        log('Mencoba login...');
        const loginPageResponse = await axios.get(`${BASE_URL}/users/sign_in`);
        updateCookies(loginPageResponse);
        const csrfToken = await getCSRFToken(loginPageResponse.data);

        const loginResponse = await axios.post(`${BASE_URL}/users/sign_in`, 
            `utf8=%E2%9C%93&authenticity_token=${encodeURIComponent(csrfToken)}&user%5Bemail%5D=${encodeURIComponent(config.email)}&user%5Bpassword%5D=${encodeURIComponent(config.password)}&commit=Login`, 
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': cookies
                },
                maxRedirects: 0,
                validateStatus: function (status) {
                    return status >= 200 && status < 303;
                }
            }
        );

        updateCookies(loginResponse);

        if (loginResponse.status === 302) {
            log('Login berhasil', 'success');
            return true;
        } else {
            log('Login gagal', 'error');
            return false;
        }
    } catch (error) {
        log(`Kesalahan login: ${error.message}`, 'error');
        return false;
    }
}

async function getWaNumbers() {
    try {
        const response = await axios.get(`${BASE_URL}/wa_numbers`, {
            headers: { Cookie: cookies }
        });
        updateCookies(response);
        const $ = cheerio.load(response.data);
        const numbers = $('table tbody tr').map((_, row) => {
            const id = $(row).find('td:first-child').text().trim();
            const pickUpUrl = $(row).find('a[onclick^="openAjaxModal"]').attr('data-url');
            return { id, pickUpUrl };
        }).get();
        return numbers;
    } catch (error) {
        log(`Kesalahan mendapatkan nomor WA: ${error.message}`, 'error');
        return [];
    }
}

async function pickUpNumber(number) {
    try {
        const pickUpFormResponse = await axios.get(`${BASE_URL}${number.pickUpUrl}`, {
            headers: { Cookie: cookies }
        });
        updateCookies(pickUpFormResponse);
        const $ = cheerio.load(pickUpFormResponse.data);
        const csrfToken = await getCSRFToken(pickUpFormResponse.data);
        const pickUpUrl = $('form').attr('action');

        const response = await axios.post(`${BASE_URL}${pickUpUrl}`, 
            `utf8=%E2%9C%93&_method=put&authenticity_token=${encodeURIComponent(csrfToken)}`, 
            {
                headers: {
                    Cookie: cookies,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-CSRF-Token': csrfToken,
                    'X-Requested-With': 'XMLHttpRequest'
                }
            }
        );
        updateCookies(response);
        
        if (response.data.newTabOpenUrl) {
            const phoneNumber = response.data.newTabOpenUrl.match(/\d+/)[0];
            return phoneNumber;
        } else {
            log(`Gagal mengambil nomor ${number.id}`, 'warning');
            return null;
        }
    } catch (error) {
        if (error.response && [401, 403].includes(error.response.status)) {
            log('Sesi atau cookie kedaluwarsa. Mencoba login lagi...', 'warning');
            const loggedIn = await login();
            if (loggedIn) {
                return await pickUpNumber(number);
            } else {
                log(`Gagal login setelah sesi kedaluwarsa.`, 'error');
                return null;
            }
        } else if (error.response && error.response.status === 422) {
            log(`Nomor ${number.id} sudah tidak tersedia`, 'warning');
        } else {
            log(`Kesalahan saat mengambil nomor ${number.id}: ${error.message}`, 'error');
        }
        return null;
    }
}

async function assignNewNumber() {
    try {
        log('Mencoba menetapkan nomor baru...');
        const formResponse = await axios.get(`${BASE_URL}/wa_numbers/wa_assignment_form`, {
            headers: { Cookie: cookies }
        });
        updateCookies(formResponse);
        const csrfToken = await getCSRFToken(formResponse.data);

        const response = await axios.post(`${BASE_URL}/wa_numbers/assign_wa`, 
            `utf8=%E2%9C%93&authenticity_token=${encodeURIComponent(csrfToken)}&commit=Submit+Post`, 
            {
                headers: {
                    Cookie: cookies,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-CSRF-Token': csrfToken
                },
                maxRedirects: 0,
                validateStatus: function (status) {
                    return status >= 200 && status < 303;
                }
            }
        );
        updateCookies(response);

        if (response.status === 302) {
            log('Nomor baru berhasil ditetapkan', 'success');
            return true;
        } else {
            log('Gagal menetapkan nomor baru', 'error');
            return false;
        }
    } catch (error) {
        log(`Kesalahan menetapkan nomor baru: ${error.message}`, 'error');
        return false;
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendMessageWithRetry(bot, chatId, text, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
            return;
        } catch (error) {
            if (error.code === 'ETELEGRAM' && error.response.parameters && error.response.parameters.retry_after) {
                const retryAfter = error.response.parameters.retry_after * 1000;
                log(`Rate limit hit. Waiting for ${retryAfter}ms before retrying...`, 'warning');
                await sleep(retryAfter);
            } else if (i === retries - 1) {
                throw error;
            } else {
                await sleep(delay);
            }
        }
    }
}

const formatNumber = (num) => num.toLocaleString('en-US');

const createSummaryMessage = (totalProcessed, totalDuplicate) => {
  const timestamp = new Date().toLocaleString('en-US', { 
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  const totalCount = totalProcessed + totalDuplicate;
  const efficiencyRate = totalCount > 0 ? (totalProcessed / totalCount * 100).toFixed(2) : '0.00';

  return `
          🚀 AUTO PICKUP BRACKET VNIX 🚀

📅 ${timestamp}
🔢 Report ID: #${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}

📊 *Process Summary*
\`\`\`
┌──────────────────┬───────────────┐
│     Category     │     Count     │
├──────────────────┼───────────────┤
│ 🆕 New Numbers   │ ${formatNumber(totalProcessed).padStart(13)}│
│ 🔁 Duplicates    │ ${formatNumber(totalDuplicate).padStart(13)}│
│ 📈 Total         │ ${formatNumber(totalCount).padStart(13)}│
├──────────────────┼───────────────┤
│ 💡 Efficiency    │     ${efficiencyRate.padStart(7)}% │
└──────────────────┴───────────────┘
\`\`\`

_Generated by AUTO PICKUP BRACKET VNIX Bot v1.0_
`;
};

async function processPickCommand(chatId) {
    try {
        if (!await login()) {
            await sendMessageWithRetry(bot, chatId, 'Login gagal. Tidak dapat memproses permintaan.');
            return;
        }
        
        let totalProcessed = 0;
        let totalDuplicate = 0;
        let consecutiveEmptyAttempts = 0;
        const MAX_EMPTY_ATTEMPTS = 2;

        while (true) {
            let numbers = await getWaNumbers();
            
            if (numbers.length === 0) {
                log('Tidak ada nomor ditemukan. Mencoba menetapkan nomor baru...', 'warning');
                const assigned = await assignNewNumber();
                if (assigned) {
                    log('Nomor baru berhasil ditetapkan. Mencoba mendapatkan nomor lagi...', 'success');
                    numbers = await getWaNumbers();
                } else {
                    consecutiveEmptyAttempts++;
                    if (consecutiveEmptyAttempts >= MAX_EMPTY_ATTEMPTS) {
                        log(`Gagal mendapatkan nomor setelah ${MAX_EMPTY_ATTEMPTS} percobaan. Menghentikan proses.`, 'error');
                        break;
                    }
                    continue;
                }
            }

            if (numbers.length === 0) {
                consecutiveEmptyAttempts++;
                if (consecutiveEmptyAttempts >= MAX_EMPTY_ATTEMPTS) {
                    log(`Tidak ada nomor tersedia setelah ${MAX_EMPTY_ATTEMPTS} percobaan. Menghentikan proses.`, 'error');
                    break;
                }
                continue;
            }

            consecutiveEmptyAttempts = 0;

            const promises = numbers.map(number => pickUpNumber(number));
            const results = await Promise.all(promises);
            
            const successfulNumbers = results.filter(Boolean);
            
            if (successfulNumbers.length > 0) {
                const saveResult = await saveNumbersToDatabase(successfulNumbers);
                totalProcessed += saveResult.successCount;
                totalDuplicate += saveResult.duplicateCount;
            }
        }

        const summaryMessage = createSummaryMessage(totalProcessed, totalDuplicate);
        await sendMessageWithRetry(bot, chatId, summaryMessage);
    } catch (error) {
        log(`Kesalahan dalam memproses permintaan: ${error.message}`, 'error');
        await sendMessageWithRetry(bot, chatId, `Terjadi kesalahan: ${error.message}`);
    }
}

async function main() {
    try {
        await connectToDatabase();
        await checkAndCreateTable();

        log('Bot siap. Menunggu perintah /pickfun dari Telegram...', 'success');

        bot.onText(/\/pickfun/, async (msg) => {
            const chatId = msg.chat.id;
            await sendMessageWithRetry(bot, chatId, 'Memulai proses pengambilan nomor. Ini akan berjalan sampai tidak ada nomor tersedia. Mohon tunggu...');
            await processPickCommand(chatId);
        });

    } catch (error) {
        log(`Kesalahan tak terduga: ${error.message}`, 'error');
    }
}

process.on('unhandledRejection', (error) => {
    log(`Unhandled Rejection: ${error.message}`, 'error');
});

main().catch(error => {
    log(`Kesalahan tak terduga di level tertinggi: ${error.message}`, 'error');
    process.exit(1);
});
