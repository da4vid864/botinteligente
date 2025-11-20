// services/migrationService.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/**
 * Migra el historial de chat de un bot a la tabla de lead_messages
 */
function migrateHistoryToLeads(botId) {
    const historyDbPath = path.join(__dirname, '..', 'data', `history_${botId}.db`);
    
    if (!fs.existsSync(historyDbPath)) {
        console.log(`No existe historial para bot ${botId}`);
        return;
    }
    
    const historyDb = new Database(historyDbPath);
    const leadsDb = new Database(path.join(__dirname, '..', 'data', 'leads.db'));
    
    // Obtener todos los chats del historial
    const chats = historyDb.prepare('SELECT DISTINCT chatId FROM messages').all();
    
    for (const chat of chats) {
        const whatsappNumber = chat.chatId;
        
        // Obtener o crear el lead
        let lead = leadsDb.prepare('SELECT * FROM leads WHERE botId = ? AND whatsappNumber = ?')
            .get(botId, whatsappNumber);
        
        if (!lead) {
            const result = leadsDb.prepare('INSERT INTO leads (botId, whatsappNumber, status) VALUES (?, ?, ?)')
                .run(botId, whatsappNumber, 'capturing');
            lead = { id: result.lastInsertRowID };
        }
        
        // Obtener mensajes del historial
        const messages = historyDb.prepare(
            'SELECT role, content, timestamp FROM messages WHERE chatId = ? ORDER BY timestamp ASC'
        ).all(whatsappNumber);
        
        // Insertar mensajes en lead_messages si no existen
        for (const msg of messages) {
            const sender = msg.role === 'user' ? 'user' : 'bot';
            
            // Verificar si el mensaje ya existe
            const exists = leadsDb.prepare(
                'SELECT id FROM lead_messages WHERE leadId = ? AND message = ? AND timestamp = ?'
            ).get(lead.id, msg.content, msg.timestamp);
            
            if (!exists) {
                leadsDb.prepare(
                    'INSERT INTO lead_messages (leadId, sender, message, timestamp) VALUES (?, ?, ?, ?)'
                ).run(lead.id, sender, msg.content, msg.timestamp);
            }
        }
        
        console.log(`✅ Migrado historial de ${whatsappNumber} (${messages.length} mensajes)`);
    }
    
    historyDb.close();
    leadsDb.close();
}

module.exports = { migrateHistoryToLeads };