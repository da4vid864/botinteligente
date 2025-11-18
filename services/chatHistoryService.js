// services/chatHistoryService.js
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data');

// Esta función devuelve un objeto con métodos para una base de datos específica
function init(botId) {
    const db = new Database(path.join(dbPath, `history_${botId}.db`));
    
    const createTableQuery = `
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );`;
    db.exec(createTableQuery);

    return {
        getChatHistory: (chatId, limit = 10) => {
            const stmt = db.prepare('SELECT role, content FROM messages WHERE chatId = ? ORDER BY timestamp DESC LIMIT ?');
            return stmt.all(chatId, limit).reverse();
        },
        addMessageToHistory: (chatId, role, content) => {
            const stmt = db.prepare('INSERT INTO messages (chatId, role, content) VALUES (?, ?, ?)');
            stmt.run(chatId, role, content);
        }
    };
}

module.exports = { init };