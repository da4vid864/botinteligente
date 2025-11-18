// services/schedulerService.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const botConfigService = require('./botConfigService');

const dbPath = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
}

const db = new Database(path.join(dbPath, 'scheduler.db'));

// Tabla de tareas programadas
const createSchedulesTable = `
CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    botId TEXT NOT NULL,
    action TEXT NOT NULL,
    scheduledAt DATETIME NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    executed BOOLEAN DEFAULT 0,
    executedAt DATETIME,
    createdBy TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

db.exec(createSchedulesTable);

/**
 * Crear una nueva tarea programada
 */
function createSchedule(botId, action, scheduledAt, createdBy) {
    const stmt = db.prepare('INSERT INTO schedules (botId, action, scheduledAt, createdBy, status) VALUES (?, ?, ?, ?, ?)');
    const result = stmt.run(botId, action, scheduledAt, createdBy, 'pending');
    return db.prepare('SELECT * FROM schedules WHERE id = ?').get(result.lastInsertRowID);
}

/**
 * Obtener todas las tareas pendientes que deben ejecutarse
 */
function getPendingSchedules() {
    return db.prepare(`
        SELECT * FROM schedules 
        WHERE status = 'pending' 
        AND executed = 0 
        AND datetime(scheduledAt) <= datetime('now')
        ORDER BY scheduledAt ASC
    `).all();
}

/**
 * Marcar una tarea como ejecutada
 */
function markScheduleAsExecuted(scheduleId) {
    const stmt = db.prepare('UPDATE schedules SET executed = 1, executedAt = CURRENT_TIMESTAMP, status = ? WHERE id = ?');
    stmt.run('completed', scheduleId);
}

/**
 * Cancelar una tarea programada
 */
function cancelSchedule(scheduleId) {
    const stmt = db.prepare('UPDATE schedules SET status = ? WHERE id = ?');
    stmt.run('cancelled', scheduleId);
}

/**
 * Obtener todas las tareas de un bot específico
 */
function getSchedulesByBot(botId) {
    return db.prepare('SELECT * FROM schedules WHERE botId = ? ORDER BY scheduledAt DESC').all(botId);
}

/**
 * Obtener tareas pendientes de un bot específico
 */
function getPendingSchedulesByBot(botId) {
    return db.prepare(`
        SELECT * FROM schedules 
        WHERE botId = ? 
        AND status = 'pending' 
        AND executed = 0 
        ORDER BY scheduledAt ASC
    `).all(botId);
}

/**
 * Eliminar tareas de un bot eliminado
 */
function deleteSchedulesByBot(botId) {
    const stmt = db.prepare('DELETE FROM schedules WHERE botId = ?');
    stmt.run(botId);
}

/**
 * Verificar si el agendamiento está habilitado para un bot
 */
function isSchedulingEnabled(botId) {
    const features = botConfigService.getBotFeatures(botId);
    return features.schedulingEnabled === 1;
}

module.exports = {
    createSchedule,
    getPendingSchedules,
    markScheduleAsExecuted,
    cancelSchedule,
    getSchedulesByBot,
    getPendingSchedulesByBot,
    deleteSchedulesByBot,
    isSchedulingEnabled
};