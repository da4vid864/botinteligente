// auth/authMiddleware.js
const jwt = require('jsonwebtoken');
const { JWT_SECRET, ADMIN_EMAILS, VENDOR_EMAILS } = process.env;

// Middleware para adjuntar el usuario a `req` si existe un token válido
const attachUser = (req, res, next) => {
  const token = req.cookies.auth_token;
  req.user = null;

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Determinar el rol del usuario
      const adminEmailsList = ADMIN_EMAILS ? ADMIN_EMAILS.split(',') : [];
      const vendorEmailsList = VENDOR_EMAILS ? VENDOR_EMAILS.split(',') : [];
      
      if (adminEmailsList.includes(decoded.email)) {
        decoded.role = 'admin';
      } else if (vendorEmailsList.includes(decoded.email)) {
        decoded.role = 'vendor';
      } else {
        decoded.role = 'unauthorized';
      }
      
      req.user = decoded;
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