// services/initDb.js
const pool = require('./db');

/**
 * Inicializar TODAS las tablas en el orden correcto
 */
async function initializeDatabase() {
    console.log('🔄 Inicializando base de datos...');
    
    try {
        // 1. Tabla de usuarios y equipos
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                role TEXT NOT NULL DEFAULT 'vendor',
                added_by TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE
            );
        `);
        console.log('✅ Tabla users inicializada');

        // 2. Tabla de bots
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bots (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                port INTEGER UNIQUE NOT NULL,
                prompt TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'enabled',
                owner_email TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Tabla bots inicializada');

        // 3. Tabla de leads
        await pool.query(`
            CREATE TABLE IF NOT EXISTS leads (
                id SERIAL PRIMARY KEY,
                bot_id TEXT NOT NULL,
                whatsapp_number TEXT NOT NULL,
                name TEXT,
                email TEXT,
                location TEXT,
                phone TEXT,
                status TEXT NOT NULL DEFAULT 'capturing',
                assigned_to TEXT,
                captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                qualified_at TIMESTAMP,
                last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(bot_id, whatsapp_number)
            );
        `);
        console.log('✅ Tabla leads inicializada');

        // 4. Tabla de mensajes de leads
        await pool.query(`
            CREATE TABLE IF NOT EXISTS lead_messages (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
                sender TEXT NOT NULL,
                message TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Tabla lead_messages inicializada');

        // 5. Tabla de features
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bot_features (
                id SERIAL PRIMARY KEY,
                bot_id TEXT NOT NULL UNIQUE,
                scheduling_enabled BOOLEAN DEFAULT FALSE,
                auto_response_enabled BOOLEAN DEFAULT TRUE,
                lead_capture_enabled BOOLEAN DEFAULT TRUE,
                working_hours_enabled BOOLEAN DEFAULT FALSE,
                working_hours_start TEXT DEFAULT '09:00',
                working_hours_end TEXT DEFAULT '18:00',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Tabla bot_features inicializada');

        // 6. Tabla de schedules
        await pool.query(`
            CREATE TABLE IF NOT EXISTS schedules (
                id SERIAL PRIMARY KEY,
                bot_id TEXT NOT NULL,
                action TEXT NOT NULL,
                scheduled_at TIMESTAMP NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                executed BOOLEAN DEFAULT FALSE,
                executed_at TIMESTAMP,
                created_by TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Tabla schedules inicializada');

        console.log('✅ Base de datos inicializada correctamente');
        return true;
    } catch (error) {
        console.error('❌ Error inicializando base de datos:', error);
        console.error('Stack trace:', error.stack);
        throw error;
    }
}

module.exports = { initializeDatabase };