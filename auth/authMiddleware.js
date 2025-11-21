// auth/authMiddleware.js
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = process.env;
const userService = require('../services/userService');

// Middleware para adjuntar el usuario a `req` si existe un token válido
const attachUser = async (req, res, next) => {
  const token = req.cookies.auth_token;
  req.user = null;

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Verificar si es admin (de las variables de entorno)
      if (userService.isAdmin(decoded.email)) {
        decoded.role = 'admin';
        req.user = decoded;
        next();
        return;
      }
      
      // Si no es admin, verificar en la base de datos
      const dbUser = await userService.getUserByEmail(decoded.email);
      
      if (dbUser && dbUser.is_active) {
        decoded.role = dbUser.role;
        decoded.addedBy = dbUser.added_by;
        req.user = decoded;
        
        // Actualizar último login
        await userService.updateLastLogin(decoded.email);
      } else {
        decoded.role = 'unauthorized';
        req.user = decoded;
      }
    } catch (err) {
      console.warn("Token JWT inválido, limpiando cookie.");
      res.clearCookie('auth_token');
    }
  }
  next();
};

// Middleware para proteger rutas que requieren ser un administrador
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.redirect('/login');
  }
  
  if (req.user.role !== 'admin') {
    return res.status(403).send(`
      <h1>403 - Acceso Denegado</h1>
      <p>No tienes permiso para acceder a esta sección (requiere rol de administrador).</p>
      <a href="/sales">Ir a Panel de Ventas</a> | 
      <a href="/auth/logout">Cerrar sesión</a>
    `);
  }

  next();
};

// Middleware para proteger rutas que requieren estar autenticado (admin o vendor)
const requireAuth = (req, res, next) => {
  if (!req.user) {
    return res.redirect('/login');
  }
  
  if (req.user.role === 'unauthorized') {
    return res.status(403).send(`
      <h1>403 - No Autorizado</h1>
      <p>Tu cuenta no tiene permisos para acceder a este sistema.</p>
      <p>Contacta al administrador para solicitar acceso.</p>
      <a href="/auth/logout">Cerrar sesión</a>
    `);
  }

  next();
};

module.exports = { attachUser, requireAdmin, requireAuth };