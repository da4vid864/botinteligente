// auth/authController.js
const jwt = require('jsonwebtoken');
const { JWT_SECRET, ADMIN_EMAILS, VENDOR_EMAILS } = process.env;

const handleGoogleCallback = (req, res) => {
  const email = req.user.profile.emails[0].value;
  
  // Determinar el rol
  const adminEmailsList = ADMIN_EMAILS ? ADMIN_EMAILS.split(',') : [];
  const vendorEmailsList = VENDOR_EMAILS ? VENDOR_EMAILS.split(',') : [];
  
  let role = 'unauthorized';
  if (adminEmailsList.includes(email)) {
    role = 'admin';
  } else if (vendorEmailsList.includes(email)) {
    role = 'vendor';
  }
  
  const tokenPayload = {
    id: req.user.profile.id,
    displayName: req.user.profile.displayName,
    email: email,
    picture: req.user.profile.photos[0].value,
    role: role
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
    res.redirect('/'); // Dashboard de gestión de bots
  } else if (role === 'vendor') {
    res.redirect('/sales'); // Panel de ventas
  } else {
    res.status(403).send(`
      <h1>Acceso Denegado</h1>
      <p>Tu cuenta (${email}) no está autorizada para acceder a este sistema.</p>
      <p>Contacta al administrador.</p>
      <a href="/auth/logout">Cerrar sesión</a>
    `);
  }
};

const logout = (req, res) => {
  res.clearCookie('auth_token');
  res.redirect('/login');
};

module.exports = { handleGoogleCallback, logout };