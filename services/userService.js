// services/userService.js
const pool = require('./db');

/**
 * Agregar un nuevo usuario al equipo
 */
async function addTeamMember(email, role, addedBy) {
    try {
        const result = await pool.query(
            'INSERT INTO users (email, role, added_by) VALUES ($1, $2, $3) RETURNING *',
            [email.toLowerCase().trim(), role, addedBy]
        );
        return result.rows[0];
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            throw new Error('Este email ya está registrado');
        }
        throw error;
    }
}

/**
 * Obtener todos los miembros del equipo agregados por un admin
 */
async function getTeamMembers(adminEmail) {
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE added_by = $1 ORDER BY created_at DESC',
            [adminEmail]
        );
        return result.rows;
    } catch (error) {
        console.error('Error obteniendo miembros del equipo:', error);
        return [];
    }
}

/**
 * Obtener usuario por email
 */
async function getUserByEmail(email) {
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email.toLowerCase().trim()]
        );
        return result.rows[0];
    } catch (error) {
        console.error('Error obteniendo usuario:', error);
        return null;
    }
}

/**
 * Actualizar último login
 */
async function updateLastLogin(email) {
    try {
        await pool.query(
            'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE email = $1',
            [email.toLowerCase().trim()]
        );
    } catch (error) {
        console.error('Error actualizando último login:', error);
    }
}

/**
 * Desactivar/activar usuario
 */
async function toggleUserStatus(userId, adminEmail) {
    try {
        const result = await pool.query(
            'UPDATE users SET is_active = NOT is_active WHERE id = $1 AND added_by = $2 RETURNING *',
            [userId, adminEmail]
        );
        return result.rows[0];
    } catch (error) {
        console.error('Error cambiando estado de usuario:', error);
        throw error;
    }
}

/**
 * Eliminar usuario del equipo
 */
async function removeTeamMember(userId, adminEmail) {
    try {
        await pool.query(
            'DELETE FROM users WHERE id = $1 AND added_by = $2',
            [userId, adminEmail]
        );
    } catch (error) {
        console.error('Error eliminando usuario:', error);
        throw error;
    }
}

/**
 * Verificar si un email es admin
 */
function isAdmin(email) {
    const adminEmails = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',') : [];
    return adminEmails.includes(email.toLowerCase().trim());
}

module.exports = {
    addTeamMember,
    getTeamMembers,
    getUserByEmail,
    updateLastLogin,
    toggleUserStatus,
    removeTeamMember,
    isAdmin
};