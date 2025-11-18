// auth/authController.js
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = process.env;

const handleGoogleCallback = (req, res) => {
  const tokenPayload = {
    id: req.user.profile.id,
    displayName: req.user.profile.displayName,
    email: req.user.profile.emails[0].value,
    picture: req.user.profile.photos[0].value,
  };

  const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // true en producción
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 días
  });

  res.redirect('/'); // Redirige al panel principal
};

const logout = (req, res) => {
  res.clearCookie('auth_token');
  res.redirect('/login'); // Redirige a la página de login
};

module.exports = { handleGoogleCallback, logout };