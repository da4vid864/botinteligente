// auth/passport.js
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } = process.env;

passport.use(
  new GoogleStrategy(
    {
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: GOOGLE_CALLBACK_URL,
    },
    (accessToken, refreshToken, profile, done) => {
      // No necesitamos guardar el usuario, solo pasarlo a la siguiente etapa.
      // El perfil contiene toda la info necesaria (id, displayName, email, etc.)
      console.log(`Usuario autenticado a través de Google: ${profile.emails[0].value}`);
      return done(null, { profile, accessToken });
    }
  )
);