// services/botConfigService.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
}

const db = new Database(path.join(dbPath, 'bots.db'));

// Tabla de configuraciones de funcionalidades de bots (SIN FOREIGN KEY)
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

/**
 * Obtener las funcionalidades de un bot (crea registro si no existe)
 */
function getBotFeatures(botId) {
    let features = db.prepare('SELECT * FROM bot_features WHERE botId = ?').get(botId);
    
    if (!features) {
        try {
            const stmt = db.prepare('INSERT INTO bot_features (botId) VALUES (?)');
            stmt.run(botId);
            features = db.prepare('SELECT * FROM bot_features WHERE botId = ?').get(botId);
        } catch (error) {
            console.warn(`No se pudo crear features para bot ${botId}, usando valores por defecto`);
            return {
                botId: botId,
                schedulingEnabled: 0,
                autoResponseEnabled: 1,
                leadCaptureEnabled: 1,
                workingHoursEnabled: 0,
                workingHoursStart: '09:00',
                workingHoursEnd: '18:00'
            };
        }
    }
    
    return features;
}

/**
 * Actualizar una funcionalidad específica de un bot
 */
function updateBotFeature(botId, featureName, value) {
    const validFeatures = [
        'schedulingEnabled',
        'autoResponseEnabled', 
        'leadCaptureEnabled',
        'workingHoursEnabled',
        'workingHoursStart',
        'workingHoursEnd'
    ];
    
    if (!validFeatures.includes(featureName)) {
        throw new Error(`Funcionalidad inválida: ${featureName}`);
    }

    // Asegurarse de que exista el registro
    let features = db.prepare('SELECT * FROM bot_features WHERE botId = ?').get(botId);
    
    if (!features) {
        try {
            const stmt = db.prepare('INSERT INTO bot_features (botId) VALUES (?)');
            stmt.run(botId);
        } catch (error) {
            console.error(`Error creando features para bot ${botId}:`, error.message);
            throw error;
        }
    }
    
    const query = `UPDATE bot_features SET ${featureName} = ?, updatedAt = CURRENT_TIMESTAMP WHERE botId = ?`;
    const stmt = db.prepare(query);
    stmt.run(value, botId);
    
    return getBotFeatures(botId);
}

/**
 * Actualizar múltiples funcionalidades a la vez
 */
function updateBotFeatures(botId, features) {
    // Asegurarse de que exista el registro
    let existingFeatures = db.prepare('SELECT * FROM bot_features WHERE botId = ?').get(botId);
    
    if (!existingFeatures) {
        try {
            const stmt = db.prepare('INSERT INTO bot_features (botId) VALUES (?)');
            stmt.run(botId);
        } catch (error) {
            console.error(`Error creando features para bot ${botId}:`, error.message);
            throw error;
        }
    }
    
    const updates = [];
    const values = [];
    
    const validFeatures = {
        schedulingEnabled: 'BOOLEAN',
        autoResponseEnabled: 'BOOLEAN',
        leadCaptureEnabled: 'BOOLEAN',
        workingHoursEnabled: 'BOOLEAN',
        workingHoursStart: 'TEXT',
        workingHoursEnd: 'TEXT'
    };
    
    for (const [key, value] of Object.entries(features)) {
        if (validFeatures[key]) {
            updates.push(`${key} = ?`);
            values.push(value);
        }
    }
    
    if (updates.length > 0) {
        updates.push('updatedAt = CURRENT_TIMESTAMP');
        values.push(botId);
        const query = `UPDATE bot_features SET ${updates.join(', ')} WHERE botId = ?`;
        db.prepare(query).run(...values);
    }
    
    return getBotFeatures(botId);
}

/**
 * Crear registro de features cuando se crea un bot
 */
function createBotFeatures(botId) {
    try {
        const stmt = db.prepare('INSERT INTO bot_features (botId) VALUES (?)');
        stmt.run(botId);
        return getBotFeatures(botId);
    } catch (error) {
        console.error(`Error creando features iniciales para bot ${botId}:`, error.message);
        return getBotFeatures(botId);
    }
}

/**
 * Eliminar funcionalidades de un bot
 */
function deleteBotFeatures(botId) {
    try {
        const stmt = db.prepare('DELETE FROM bot_features WHERE botId = ?');
        stmt.run(botId);
        console.log(`✅ Features del bot ${botId} eliminadas`);
    } catch (error) {
        console.error(`Error eliminando features del bot ${botId}:`, error.message);
    }
}

module.exports = {
    getBotFeatures,
    updateBotFeature,
    updateBotFeatures,
    createBotFeatures,
    deleteBotFeatures
};