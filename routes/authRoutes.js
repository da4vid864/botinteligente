// routes/authRoutes.js
const express = require('express');
const passport = require('passport');
const { handleGoogleCallback, logout } = require('../auth/authController');
const router = express.Router();

// Redirige al usuario a Google para iniciar sesión
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  session: false
}));

// Google redirige aquí después del inicio de sesión
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/login', session: false }),
  handleGoogleCallback
);

// Cierra la sesión del usuario
router.get('/logout', logout);

module.exports = router;