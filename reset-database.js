// reset-database.js
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'bots.db');
const db = new Database(dbPath);

console.log('🗑️ Eliminando tablas con FOREIGN KEYS...');

try {
    // Desactivar FOREIGN KEYS temporalmente
    db.pragma('foreign_keys = OFF');
    
    // Eliminar la tabla problemática
    db.exec('DROP TABLE IF EXISTS bot_features');
    console.log('✅ Tabla bot_features eliminada');
    
    // Recrear la tabla SIN FOREIGN KEY
    const createBotFeaturesTable = `
    CREATE TABLE IF NOT EXISTS bot_features (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        botId TEXT NOT NULL UNIQUE,
        schedulingEnabled BOOLEAN DEFAULT 0,
        autoResponseEnabled BOOLEAN DEFAULT 1,
        leadCaptureEnabled BOOLEAN DEFAULT 1,
        workingHoursEnabled BOOLEAN DEFAULT 0,
        workingHoursStart TEXT DEFAULT '09:00',
        workingHoursEnd TEXT DEFAULT '18:00',
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    `;
    
    db.exec(createBotFeaturesTable);
    console.log('✅ Tabla bot_features recreada sin FOREIGN KEY');
    
    db.close();
    console.log('✅ Base de datos actualizada correctamente');
} catch (error) {
    console.error('❌ Error:', error.message);
    db.close();
}