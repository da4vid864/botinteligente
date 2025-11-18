// migrate.js
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'bots.db');
const db = new Database(dbPath);

console.log('🔄 Iniciando migración de features para bots existentes...');

// Obtener todos los bots
const allBots = db.prepare('SELECT * FROM bots').all();

console.log(`📋 Encontrados ${allBots.length} bots`);

allBots.forEach(bot => {
    try {
        // Verificar si ya existe el registro
        const existing = db.prepare('SELECT * FROM bot_features WHERE botId = ?').get(bot.id);
        
        if (!existing) {
            console.log(`⚙️ Creando features para bot: ${bot.id}`);
            const stmt = db.prepare('INSERT INTO bot_features (botId) VALUES (?)');
            stmt.run(bot.id);
            console.log(`✅ Features creadas para bot: ${bot.id}`);
        } else {
            console.log(`⏭️ Bot ${bot.id} ya tiene features configuradas`);
        }
    } catch (error) {
        console.error(`❌ Error con bot ${bot.id}:`, error.message);
    }
});

db.close();
console.log('✅ Migración completada');
process.exit(0);