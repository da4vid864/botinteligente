// auth/authMiddleware.js
const jwt = require('jsonwebtoken');
const { JWT_SECRET, ADMIN_EMAILS } = process.env;

// Middleware para adjuntar el usuario a `req` si existe un token válido
const attachUser = (req, res, next) => {
  const token = req.cookies.auth_token;
  req.user = null;

  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
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
    // Si no hay usuario, redirigir a la página de login
    return res.redirect('/login');
  }
  
  const adminEmailsList = ADMIN_EMAILS.split(',');
  if (!adminEmailsList.includes(req.user.email)) {
    // Si el usuario no es admin, mostrar un error de acceso denegado
    return res.status(403).send('<h1>403 - Acceso Denegado</h1><p>No tienes permiso para ver esta página.</p><a href="/auth/logout">Cerrar sesión</a>');
  }

  // Si es admin, continuar
  next();
};

module.exports = { attachUser, requireAdmin };