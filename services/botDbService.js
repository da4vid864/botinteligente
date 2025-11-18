const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data');
if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
}

const db = new Database(path.join(dbPath, 'bots.db'));

// Define la estructura de la tabla, con la nueva columna 'ownerEmail'.
const createTableQuery = `
CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    port INTEGER UNIQUE NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'enabled',
    ownerEmail TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;
db.exec(createTableQuery);

// Bloque de migración: Añade la columna 'ownerEmail' si no existe.
// Esto es para actualizar tu base de datos existente sin perder datos.
// Se ejecutará solo una vez si la columna falta.
try {
    db.prepare('SELECT ownerEmail FROM bots LIMIT 1').get();
} catch (e) {
    console.log("Migración: Añadiendo la columna 'ownerEmail' a la tabla de bots...");
    const adminEmail = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',')[0] : 'default@admin.com';
    db.exec(`ALTER TABLE bots ADD COLUMN ownerEmail TEXT NOT NULL DEFAULT "${adminEmail}"`);
    console.log(`Migración completada. Los bots existentes han sido asignados a '${adminEmail}'.`);
}


/**
 * Añade la configuración de un nuevo bot a la base de datos.
 * @param {object} botConfig - { id, name, port, prompt, ownerEmail }
 */
function addBot(botConfig) {
  const { id, name, port, prompt, ownerEmail } = botConfig;
  const stmt = db.prepare('INSERT INTO bots (id, name, port, prompt, status, ownerEmail) VALUES (?, ?, ?, ?, ?, ?)');
  stmt.run(id, name, port, prompt, 'enabled', ownerEmail);
}

/**
 * Actualiza el estado de un bot ('enabled' o 'disabled').
 * @param {string} id - El ID del bot.
 * @param {string} status - El nuevo estado.
 */
function updateBotStatus(id, status) {
    const stmt = db.prepare('UPDATE bots SET status = ? WHERE id = ?');
    stmt.run(status, id);
}

/**
 * Actualiza únicamente el prompt de un bot específico.
 * @param {string} id - El ID del bot.
 * @param {string} prompt - El nuevo contenido del prompt.
 */
function updateBotPrompt(id, prompt) {
    const stmt = db.prepare('UPDATE bots SET prompt = ? WHERE id = ?');
    stmt.run(prompt, id);
}

/**
 * Obtiene la configuración de un bot por su ID.
 * @param {string} id - El ID del bot.
 * @returns {object|undefined}
 */
function getBotById(id) {
  return db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
}

/**
 * Obtiene la configuración de un bot solo si pertenece al usuario especificado.
 * ¡Función clave para la seguridad!
 * @param {string} id - El ID del bot.
 * @param {string} ownerEmail - El email del usuario.
 * @returns {object|undefined}
 */
function getBotByIdAndOwner(id, ownerEmail) {
    return db.prepare('SELECT * FROM bots WHERE id = ? AND ownerEmail = ?').get(id, ownerEmail);
}

/**
 * Obtiene la configuración de todos los bots (para uso interno o de super-admin).
 * @returns {Array<object>}
 */
function getAllBots() {
  return db.prepare('SELECT * FROM bots').all();
}

/**
 * Obtiene todos los bots que pertenecen a un usuario específico.
 * @param {string} ownerEmail - El email del dueño.
 * @returns {Array<object>}
 */
function getBotsByOwner(ownerEmail) {
    return db.prepare('SELECT * FROM bots WHERE ownerEmail = ?').all(ownerEmail);
}

/**
 * Encuentra el último puerto utilizado para asignar el siguiente.
 * @returns {number}
 */
function getLastPort() {
    const row = db.prepare('SELECT MAX(port) as maxPort FROM bots').get();
    return row.maxPort || 3000; // Puerto base si no hay bots.
}

/**
 * Elimina un bot de la base de datos por su ID.
 * @param {string} id - El ID del bot a eliminar.
 */
function deleteBotById(id) {
    const stmt = db.prepare('DELETE FROM bots WHERE id = ?');
    stmt.run(id);
}

module.exports = {
  addBot,
  getBotById,
  getAllBots,
  getBotsByOwner,       // Exportar nueva función
  getBotByIdAndOwner,   // Exportar nueva función de seguridad
  getLastPort,
  updateBotStatus,
  deleteBotById,
  updateBotPrompt
};