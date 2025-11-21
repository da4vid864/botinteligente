// auth/authController.js
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = process.env;
const userService = require('../services/userService');

const handleGoogleCallback = async (req, res) => {
  const email = req.user.profile.emails[0].value;
  
  // Verificar si es admin
  let role = 'unauthorized';
  let addedBy = null;
  
  if (userService.isAdmin(email)) {
    role = 'admin';
  } else {
    // Verificar en la base de datos
    const dbUser = await userService.getUserByEmail(email);
    
    if (dbUser && dbUser.is_active) {
      role = dbUser.role;
      addedBy = dbUser.added_by;
      
      // Actualizar último login
      await userService.updateLastLogin(email);
    }
  }
  
  const tokenPayload = {
    id: req.user.profile.id,
    displayName: req.user.profile.displayName,
    email: email,
    picture: req.user.profile.photos[0].value,
    role: role,
    addedBy: addedBy
  };

  const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  // Redirigir según el rol
  if (role === 'admin') {
    res.redirect('/');
  } else if (role === 'vendor') {
    res.redirect('/sales');
  } else {
    res.status(403).send(`
      <h1>Acceso Denegado</h1>
      <p>Tu cuenta (${email}) no está autorizada para acceder a este sistema.</p>
      <p>Contacta al administrador para solicitar acceso.</p>
      <a href="/auth/logout">Cerrar sesión</a>
    `);
  }
};

const logout = (req, res) => {
  res.clearCookie('auth_token');
  res.redirect('/login');
};

module.exports = { handleGoogleCallback, logout };