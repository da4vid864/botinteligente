// dashboardServer.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { fork } = require('child_process');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');

const botDbService = require('./services/botDbService');
const leadDbService = require('./services/leadDbService');
const botConfigService = require('./services/botConfigService');
const schedulerService = require('./services/schedulerService');
const userService = require('./services/userService');
const botImageService = require('./services/botImageService');

const { startSchedulerExecutor } = require('./services/schedulerExecutor');
const authRoutes = require('./routes/authRoutes');
// === NUEVO: Importar rutas y controlador de Stripe ===
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const { handleStripeWebhook } = require('./controllers/webhookController');
// ====================================================

const { attachUser, requireAdmin, requireAuth } = require('./auth/authMiddleware');

require('./auth/passport');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;

// Mapa de procesos de bots activos: { botId: childProcess }
const activeBots = new Map();

// Mapa de clientes WebSocket conectados: Set de WebSocket
const dashboardClients = new Set();

// === CONFIGURACIÓN DE MULTER ===
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// =================================================================
// === 1. WEBHOOK DE STRIPE (Debe ir ANTES de express.json) ===
// =================================================================
// Stripe necesita el body en formato RAW (buffer) para verificar la firma de seguridad
app.post('/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);


// === 2. MIDDLEWARES GLOBALES ===
app.use(express.json()); // Parsea JSON para el resto de la app
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(passport.initialize());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(attachUser);

app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com; " + // Agregado Stripe
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https:; " +
        "connect-src 'self' wss: ws: https://api.stripe.com; " + // Agregado Stripe
        "frame-src 'self' https://js.stripe.com https://hooks.stripe.com; " + // Agregado Stripe
        "font-src 'self'; "
    );
    next();
});

// === RUTAS ===
app.use('/auth', authRoutes);

// === NUEVO: RUTAS DE SUSCRIPCIÓN ===
app.use('/subs', subscriptionRoutes); 
// ===================================

app.get('/login', (req, res) => {
    if (req.user) {
        if (req.user.role === 'admin') return res.redirect('/dashboard');
        if (req.user.role === 'vendor') return res.redirect('/sales');
    }
    res.render('login');
});

// Landing page route - accessible to everyone
app.get('/', (req, res) => {
    if (req.user) {
        if (req.user.role === 'admin') return res.redirect('/dashboard');
        if (req.user.role === 'vendor') return res.redirect('/sales');
    }
    // Verificar si hay errores de pago en la URL para mostrar alerta
    const paymentError = req.query.error === 'payment_init_failed' || req.query.payment === 'cancelled';
    
    res.render('landing', {
        user: req.user,
        pageTitle: 'Casos de éxito que hablan por sí solos - botinteligente.com.mx',
        pageDescription: 'Confía en la inteligencia que vende por ti',
        canonicalUrl: 'https://botinteligente.com.mx/',
        updatedTime: '2025-11-21T17:02:12.086Z',
        publishedTime: '2025-10-12T04:37:04+00:00',
        modifiedTime: '2025-11-21T17:02:12.086Z',
        paymentError // Pasar variable a la vista si quieres mostrar mensaje
    });
});

// Dashboard route - requires admin access
app.get('/dashboard', requireAdmin, (req, res) => {
    // Detectar si viene de un pago exitoso
    const paymentSuccess = req.query.payment === 'success';
    res.render('dashboard', { user: req.user, paymentSuccess });
});

app.get('/sales', requireAuth, (req, res) => {
    res.render('sales', { user: req.user });
});

// === WEBSOCKET (Resto del código original sin cambios) ===
wss.on('connection', async (ws, req) => {
    const cookies = cookie.parse(req.headers.cookie || '');
    const token = cookies.auth_token;
    
    let user = null;
    if (token) {
        try {
            user = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            ws.close(1008, 'Token inválido');
            return;
        }
    } else {
        ws.close(1008, 'No autenticado');
        return;
    }
    
    if (user.role !== 'admin' && user.role !== 'vendor') {
        ws.close(1008, 'No autorizado');
        return;
    }
    
    dashboardClients.add(ws);

    if (user.role === 'admin') {
        try {
            const allBots = await botDbService.getAllBots();
            const userBots = allBots.filter(bot => bot.ownerEmail === user.email);
            
            const botsData = userBots.map(bot => {
                return {
                    ...bot,
                    runtimeStatus: getRuntimeStatus(bot)
                };
            });
            
            ws.send(JSON.stringify({ type: 'INIT', data: botsData }));
        } catch (error) {
            console.error('❌ Error obteniendo bots:', error);
        }
    }

    try {
        const qualifiedLeads = await leadDbService.getQualifiedLeads();
        ws.send(JSON.stringify({ type: 'INIT_LEADS', data: qualifiedLeads }));
    } catch (error) {}

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'ASSIGN_LEAD') await handleAssignLead(data.leadId, user.email);
            if (data.type === 'SEND_MESSAGE') await handleSendMessage(data.leadId, data.message, user.email);
            if (data.type === 'GET_LEAD_MESSAGES') await handleGetLeadMessages(ws, data.leadId);
        } catch (error) {}
    });

    ws.on('close', () => {
        dashboardClients.delete(ws);
    });
});

// === FUNCIÓN: Obtener estado ===
function getRuntimeStatus(bot) {
    if (bot.status === 'disabled') return 'DISABLED';
    
    const botProcess = activeBots.get(bot.id);
    if (!botProcess) return 'DISCONNECTED';
    
    return 'STARTING'; 
}

function broadcastToDashboard(message) {
    const messageStr = JSON.stringify(message);
    dashboardClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
        }
    });
}

// === MANEJO DE MENSAJES DE BOTS ===
async function handleBotMessage(botId, message) {
    switch (message.type) {
        case 'QR_GENERATED':
            const botWithQR = await botDbService.getBotById(botId);
            broadcastToDashboard({
                type: 'UPDATE_BOT',
                data: { ...botWithQR, runtimeStatus: 'PENDING_QR', qr: message.qr }
            });
            break;
        
        case 'CONNECTED':
            const connectedBot = await botDbService.getBotById(botId);
            broadcastToDashboard({
                type: 'UPDATE_BOT',
                data: { ...connectedBot, runtimeStatus: 'CONNECTED' }
            });
            break;

        case 'UPDATE_BOT':
            broadcastToDashboard({
                type: 'UPDATE_BOT',
                data: message 
            });
            break;
        
        case 'DISCONNECTED':
            const disconnectedBot = await botDbService.getBotById(botId);
            broadcastToDashboard({
                type: 'UPDATE_BOT',
                data: { ...disconnectedBot, runtimeStatus: 'DISCONNECTED' }
            });
            break;

        case 'NEW_QUALIFIED_LEAD':
            broadcastToDashboard({ type: 'NEW_QUALIFIED_LEAD', data: message.lead });
            break;

        case 'NEW_MESSAGE_FOR_SALES':
            broadcastToDashboard({ type: 'NEW_MESSAGE_FOR_SALES', data: message });
            break;
    }
}

// === FUNCIÓN: Lanzar bot ===
function launchBot(botConfig) {
    if (activeBots.has(botConfig.id)) {
        console.log(`⚠️ El bot ${botConfig.id} ya está en ejecución. Solo enviando configuración.`);
        const existingProc = activeBots.get(botConfig.id);
        existingProc.send({ 
            type: 'SET_STATUS', 
            status: botConfig.status 
        });
        return;
    }

    console.log(`🚀 Lanzando proceso para bot: ${botConfig.name} (Estado inicial: ${botConfig.status})`);
    
    const botProcess = fork(path.join(__dirname, 'botInstance.js'), [], {
        env: { ...process.env }
    });

    botProcess.send({ type: 'INIT', config: botConfig });

    botProcess.on('message', (msg) => handleBotMessage(botConfig.id, msg));

    botProcess.on('exit', async (code) => {
        console.log(`❌ Bot ${botConfig.id} terminado con código ${code}`);
        activeBots.delete(botConfig.id);
        const exitedBot = await botDbService.getBotById(botConfig.id);
        if (exitedBot) {
            broadcastToDashboard({
                type: 'UPDATE_BOT',
                data: { ...exitedBot, runtimeStatus: 'DISCONNECTED' }
            });
        }
    });

    activeBots.set(botConfig.id, botProcess);
}

// === FUNCIÓN: Matar bot (Solo para eliminar) ===
function stopBot(botId) {
    const botProcess = activeBots.get(botId);
    if (botProcess) {
        console.log(`☠️ Matando proceso de bot ${botId}`);
        botProcess.kill();
        activeBots.delete(botId);
    }
}

// === API: DESHABILITAR BOT ===
app.post('/disable-bot/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(id, ownerEmail);
    if (!bot) return res.status(404).json({ message: 'Bot no encontrado' });

    await botDbService.updateBotStatus(id, 'disabled');
    
    const botProcess = activeBots.get(id);
    if (botProcess) {
        botProcess.send({ type: 'SET_STATUS', status: 'disabled' });
    } else {
        launchBot({ ...bot, status: 'disabled' });
    }

    res.json({ message: 'Bot deshabilitado (Pausado)' });
});

// === API: HABILITAR BOT ===
app.post('/enable-bot/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(id, ownerEmail);
        if (!bot) return res.status(404).json({ message: 'Bot no encontrado' });

    await botDbService.updateBotStatus(id, 'enabled');
    
    const botProcess = activeBots.get(id);
    if (botProcess) {
        botProcess.send({ type: 'SET_STATUS', status: 'enabled' });
    } else {
        launchBot({ ...bot, status: 'enabled' });
    }

    res.json({ message: 'Bot habilitado (Reanudado)' });
});

// === MANEJO DE LEADS Y MENSAJES ===
async function handleAssignLead(leadId, vendorEmail) {
    try {
        const lead = await leadDbService.assignLead(leadId, vendorEmail);
        broadcastToDashboard({ type: 'LEAD_ASSIGNED', data: lead });
    } catch (error) { console.error('Error asignando lead:', error); }
}

async function handleSendMessage(leadId, message, vendorEmail) {
    try {
        const lead = await leadDbService.getLeadById(leadId);
        if (!lead) return;

        await leadDbService.addLeadMessage(leadId, vendorEmail, message);
        const botProcess = activeBots.get(lead.bot_id);
        if (botProcess) {
            botProcess.send({ type: 'SEND_MESSAGE', to: lead.whatsapp_number, message });
        }
        broadcastToDashboard({
            type: 'MESSAGE_SENT',
            data: { leadId, sender: vendorEmail, message, timestamp: new Date().toISOString() }
        });
    } catch (error) { console.error('Error enviando mensaje:', error); }
}

async function handleGetLeadMessages(ws, leadId) {
    try {
        const messages = await leadDbService.getLeadMessages(leadId, 1000);
        const lead = await leadDbService.getLeadById(leadId);
        
        ws.send(JSON.stringify({
            type: 'LEAD_MESSAGES',
            data: { leadId, lead, messages, totalMessages: messages.length }
        }));
    } catch (error) {}
}

// === RESTO DE RUTAS API (CRUD BOTS, ETC) ===

app.post('/create-bot', requireAdmin, async (req, res) => {
    const { name, id, prompt } = req.body;
    const ownerEmail = req.user.email;

    if (!name || !id || !prompt) return res.status(400).json({ message: 'Datos incompletos' });

    try {
        const lastPort = await botDbService.getLastPort();
        const botConfig = { id, name, port: lastPort + 1, prompt, status: 'enabled', ownerEmail };
        
        await botDbService.addBot(botConfig);
        await botConfigService.createBotFeatures(id);
        
        launchBot(botConfig);

        broadcastToDashboard({ type: 'NEW_BOT', data: { ...botConfig, runtimeStatus: 'STARTING' } });
        res.json({ message: 'Bot creado', bot: botConfig });
    } catch (error) {
        res.status(500).json({ message: 'Error creando bot' });
    }
});

app.patch('/edit-bot/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { prompt } = req.body;
    
    await botDbService.updateBotPrompt(id, prompt);
    stopBot(id);
    const bot = await botDbService.getBotById(id);
    if(bot.status !== 'disabled') launchBot(bot);

    res.json({ message: 'Prompt actualizado' });
});

app.delete('/delete-bot/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    stopBot(id);
    await schedulerService.deleteSchedulesByBot(id);
    await botConfigService.deleteBotFeatures(id);
    await botDbService.deleteBotById(id);
    
    broadcastToDashboard({ type: 'BOT_DELETED', data: { id } });
    res.json({ message: 'Bot eliminado' });
});

// === RUTAS IMÁGENES ===
app.post('/api/bot/:botId/images', requireAdmin, upload.single('image'), async (req, res) => {
    const { botId } = req.params;
    const { keyword } = req.body;
    const file = req.file;

    if (!file || !keyword) return res.status(400).json({ message: 'Faltan datos' });

    try {
        const image = await botImageService.addImage(botId, file.filename, file.originalname, keyword);
        const botProcess = activeBots.get(botId);
        if (botProcess) botProcess.send({ type: 'REFRESH_IMAGES' });
        res.json(image);
    } catch (error) {
        res.status(500).json({ message: 'Error guardando imagen' });
    }
});

app.get('/api/bot/:botId/images', requireAdmin, async (req, res) => {
    try {
        const images = await botImageService.getImagesByBot(req.params.botId);
        res.json(images);
    } catch (error) { res.status(500).json({ message: 'Error' }); }
});

app.delete('/api/images/:imageId', requireAdmin, async (req, res) => {
    try {
        const deleted = await botImageService.deleteImage(req.params.imageId);
        if (deleted) {
            const p = path.join(__dirname, 'public', 'uploads', deleted.filename);
            if (fs.existsSync(p)) fs.unlinkSync(p);
            
            const botProcess = activeBots.get(deleted.bot_id);
            if (botProcess) botProcess.send({ type: 'REFRESH_IMAGES' });
        }
        res.json({ message: 'Eliminada' });
    } catch (error) { res.status(500).json({ message: 'Error' }); }
});

// === APIs TEAM, FEATURES, SCHEDULES (Se asume que ya existen en tu archivo original, mantenlas) ===
// Si faltaban las rutas de team/features que estaban en versiones anteriores, agrégalas aquí.
// Por ahora mantengo el flujo de bots que es lo crítico.
// ==========================================
// === RUTAS API FALTANTES (Features, Team, Schedules) ===
// ==========================================

// 1. API FEATURES (Configuración del Bot)
app.get('/api/bot/:id/features', requireAuth, async (req, res) => {
    try {
        const features = await botConfigService.getBotFeatures(req.params.id);
        res.json(features);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error obteniendo features' });
    }
});

app.patch('/api/bot/:id/features', requireAuth, async (req, res) => {
    try {
        const updated = await botConfigService.updateBotFeatures(req.params.id, req.body);
        // Notificar al bot en tiempo real que su configuración cambió
        const botProcess = activeBots.get(req.params.id);
        if (botProcess) {
            botProcess.send({ type: 'UPDATE_FEATURES', features: updated });
        }
        res.json(updated);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error actualizando features' });
    }
});

// 2. API TEAM (Gestión de Equipo)
app.get('/api/team', requireAdmin, async (req, res) => {
    try {
        const members = await userService.getTeamMembers(req.user.email);
        res.json(members);
    } catch (error) {
        res.status(500).json({ message: 'Error obteniendo equipo' });
    }
});

app.post('/api/team', requireAdmin, async (req, res) => {
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ message: 'Email requerido' });
    
    try {
        const newMember = await userService.addTeamMember(email, role, req.user.email);
        res.json(newMember);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

app.patch('/api/team/:id/toggle', requireAdmin, async (req, res) => {
    try {
        await userService.toggleUserStatus(req.params.id, req.user.email);
        res.json({ message: 'Estado actualizado' });
    } catch (error) {
        res.status(500).json({ message: 'Error actualizando estado' });
    }
});

app.delete('/api/team/:id', requireAdmin, async (req, res) => {
    try {
        await userService.removeTeamMember(req.params.id, req.user.email);
        res.json({ message: 'Miembro eliminado' });
    } catch (error) {
        res.status(500).json({ message: 'Error eliminando miembro' });
    }
});

// 3. API SCHEDULES (Horarios)
app.get('/api/bot/:id/schedules', requireAdmin, async (req, res) => {
    try {
        const schedules = await schedulerService.getSchedulesByBot(req.params.id);
        res.json(schedules);
    } catch (error) {
        res.status(500).json({ message: 'Error obteniendo horarios' });
    }
});

app.post('/api/schedules', requireAdmin, async (req, res) => {
    const { botId, action, scheduledAt } = req.body;
    try {
        const schedule = await schedulerService.createSchedule(botId, action, scheduledAt, req.user.email);
        res.json(schedule);
    } catch (error) {
        res.status(500).json({ message: 'Error creando horario' });
    }
});

app.delete('/api/schedules/:id', requireAdmin, async (req, res) => {
    try {
        await schedulerService.cancelSchedule(req.params.id);
        res.json({ message: 'Horario cancelado' });
    } catch (error) {
        res.status(500).json({ message: 'Error cancelando horario' });
    }
});

// ==========================================
// === FIN RUTAS FALTANTES ===
// ==========================================
// === INICIO SERVIDOR ===
async function startServer() {
    try {
        const { initializeDatabase } = require('./services/initDb');
        await initializeDatabase();
        
        startSchedulerExecutor(async (botId, action) => {
            console.log(`⏰ Ejecutando tarea programada: ${action} para ${botId}`);
            
            await botDbService.updateBotStatus(botId, action === 'enable' ? 'enabled' : 'disabled');
            
            const botProcess = activeBots.get(botId);
            const status = action === 'enable' ? 'enabled' : 'disabled';
            
            if (botProcess) {
                botProcess.send({ type: 'SET_STATUS', status });
            } else if (action === 'enable') {
                const bot = await botDbService.getBotById(botId);
                launchBot(bot);
            }
            
            broadcastToDashboard({
                type: 'UPDATE_BOT',
                data: { ...(await botDbService.getBotById(botId)), 
                        status, 
                        runtimeStatus: status === 'enabled' ? 'CONNECTED' : 'DISABLED' 
                      }
            });
        });
        
        server.listen(PORT, '0.0.0.0', async () => {
            console.log(`🚀 Dashboard corriendo en puerto ${PORT}`);
            
            const allBots = await botDbService.getAllBots();
            allBots.forEach(bot => launchBot(bot));
        });
        
    } catch (error) {
        console.error('❌ Error fatal:', error);
        process.exit(1);
    }
}

startServer();