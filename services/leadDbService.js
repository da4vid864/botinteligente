// services/leadDbService.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
}

const db = new Database(path.join(dbPath, 'leads.db'));

// Tabla de leads capturados
const createLeadsTable = `
CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    botId TEXT NOT NULL,
    whatsappNumber TEXT NOT NULL,
    name TEXT,
    email TEXT,
    location TEXT,
    phone TEXT,
    status TEXT NOT NULL DEFAULT 'capturing',
    assignedTo TEXT,
    capturedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    qualifiedAt DATETIME,
    lastMessageAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(botId, whatsappNumber)
);
`;

// Tabla de mensajes de conversaciones
const createMessagesTable = `
CREATE TABLE IF NOT EXISTS lead_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    leadId INTEGER NOT NULL,
    sender TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (leadId) REFERENCES leads(id)
);
`;

db.exec(createLeadsTable);
db.exec(createMessagesTable);

/**
 * Obtiene o crea un lead por botId y número de WhatsApp
 */
function getOrCreateLead(botId, whatsappNumber) {
    let lead = db.prepare('SELECT * FROM leads WHERE botId = ? AND whatsappNumber = ?').get(botId, whatsappNumber);
    
    if (!lead) {
        const stmt = db.prepare('INSERT INTO leads (botId, whatsappNumber, status) VALUES (?, ?, ?)');
        const result = stmt.run(botId, whatsappNumber, 'capturing');
        lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowID);
    }
    
    return lead;
}

/**
 * Actualiza los campos de información de un lead
 */
function updateLeadInfo(leadId, data) {
    const fields = [];
    const values = [];
    
    if (data.name) { fields.push('name = ?'); values.push(data.name); }
    if (data.email) { fields.push('email = ?'); values.push(data.email); }
    if (data.location) { fields.push('location = ?'); values.push(data.location); }
    if (data.phone) { fields.push('phone = ?'); values.push(data.phone); }
    
    if (fields.length > 0) {
        fields.push('lastMessageAt = CURRENT_TIMESTAMP');
        values.push(leadId);
        const query = `UPDATE leads SET ${fields.join(', ')} WHERE id = ?`;
        db.prepare(query).run(...values);
    }
    
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
}

/**
 * Marca un lead como calificado (información completa)
 */
function qualifyLead(leadId) {
    const stmt = db.prepare('UPDATE leads SET status = ?, qualifiedAt = CURRENT_TIMESTAMP WHERE id = ?');
    stmt.run('qualified', leadId);
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
}

/**
 * Asigna un lead a un vendedor
 */
function assignLead(leadId, vendorEmail) {
    const stmt = db.prepare('UPDATE leads SET status = ?, assignedTo = ? WHERE id = ?');
    stmt.run('assigned', vendorEmail, leadId);
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
}

/**
 * Obtiene un lead por ID
 */
function getLeadById(leadId) {
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
}

/**
 * Obtiene todos los leads de un bot específico
 */
function getLeadsByBot(botId) {
    return db.prepare('SELECT * FROM leads WHERE botId = ? ORDER BY lastMessageAt DESC').all(botId);
}

/**
 * Obtiene leads calificados (pendientes de asignar)
 */
function getQualifiedLeads(botId = null) {
    if (botId) {
        return db.prepare('SELECT * FROM leads WHERE botId = ? AND status = ? ORDER BY qualifiedAt DESC').all(botId, 'qualified');
    }
    return db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY qualifiedAt DESC').all('qualified');
}

/**
 * Obtiene leads asignados a un vendedor
 */
function getLeadsByVendor(vendorEmail) {
    return db.prepare('SELECT * FROM leads WHERE assignedTo = ? ORDER BY lastMessageAt DESC').all(vendorEmail);
}

/**
 * Añade un mensaje a la conversación de un lead
 */
function addLeadMessage(leadId, sender, message) {
    const stmt = db.prepare('INSERT INTO lead_messages (leadId, sender, message) VALUES (?, ?, ?)');
    stmt.run(leadId, sender, message);
    
    // Actualizar lastMessageAt del lead
    db.prepare('UPDATE leads SET lastMessageAt = CURRENT_TIMESTAMP WHERE id = ?').run(leadId);
}

/**
 * Obtiene el historial de mensajes de un lead
 */
function getLeadMessages(leadId, limit = 50) {
    return db.prepare('SELECT * FROM lead_messages WHERE leadId = ? ORDER BY timestamp ASC LIMIT ?').all(leadId, limit);
}

/**
 * Verifica si un lead tiene toda la información requerida
 */
function isLeadComplete(lead) {
    return !!(lead.name && lead.email && lead.location && lead.phone);
}

module.exports = {
    getOrCreateLead,
    updateLeadInfo,
    qualifyLead,
    assignLead,
    getLeadById,
    getLeadsByBot,
    getQualifiedLeads,
    getLeadsByVendor,
    addLeadMessage,
    getLeadMessages,
    isLeadComplete
};