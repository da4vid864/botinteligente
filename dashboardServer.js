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

// === MIDDLEWARES ===
app.use(express.json());
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
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https:; " +
        "connect-src 'self' wss: ws:; " +
        "font-src 'self'; "
    );
    next();
});

// === RUTAS ===
app.use('/auth', authRoutes);

app.get('/login', (req, res) => {
    if (req.user) {
        if (req.user.role === 'admin') return res.redirect('/');
        if (req.user.role === 'vendor') return res.redirect('/sales');
    }
    res.render('login');
});

app.get('/', requireAdmin, (req, res) => {
    res.render('dashboard', { user: req.user });
});

app.get('/sales', requireAuth, (req, res) => {
    res.render('sales', { user: req.user });
});

// === WEBSOCKET ===
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
    // Si la DB dice disabled, para el frontend es DISABLED aunque el proceso corra
    if (bot.status === 'disabled') return 'DISABLED';
    
    const botProcess = activeBots.get(bot.id);
    if (!botProcess) return 'DISCONNECTED';
    
    // Si el proceso existe y bot.status es enabled, asumimos que está conectando o conectado
    // El bot mandará 'CONNECTED' vía websocket cuando esté listo
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
            // Recibimos estado actualizado (ej: PAUSED/DISABLED desde el proceso)
            broadcastToDashboard({
                type: 'UPDATE_BOT',
                data: message // message ya trae los datos del bot y el nuevo status
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
        // Si ya corre, nos aseguramos que tenga la config correcta
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

    // Enviar INIT. El bot decidirá si se pausa o no según config.status
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
        
        // AUTO-RESTART SI FUE ERROR INESPERADO (opcional)
        // if (code !== 0) launchBot(botConfig);
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

// === API: DESHABILITAR BOT (CAMBIADO A PAUSAR) ===
app.post('/disable-bot/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(id, ownerEmail);
    if (!bot) return res.status(404).json({ message: 'Bot no encontrado' });

    // 1. Actualizar DB
    await botDbService.updateBotStatus(id, 'disabled');
    
    // 2. Notificar al proceso para que se pause (NO MATAR)
    const botProcess = activeBots.get(id);
    if (botProcess) {
        botProcess.send({ type: 'SET_STATUS', status: 'disabled' });
    } else {
        // Si no corría, lo lanzamos en modo disabled
        launchBot({ ...bot, status: 'disabled' });
    }

    res.json({ message: 'Bot deshabilitado (Pausado)' });
});

// === API: HABILITAR BOT (CAMBIADO A REANUDAR) ===
app.post('/enable-bot/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(id, ownerEmail);
        if (!bot) return res.status(404).json({ message: 'Bot no encontrado' });

    // 1. Actualizar DB
    await botDbService.updateBotStatus(id, 'enabled');
    
    // 2. Notificar al proceso para que se reanude
    const botProcess = activeBots.get(id);
    if (botProcess) {
        botProcess.send({ type: 'SET_STATUS', status: 'enabled' });
    } else {
        // Si no corría, lo lanzamos en modo enabled
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
        
        // Enviar solo a ese socket, no broadcast
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
        
        // Lanzar inmediatamente
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
    // Si queremos actualizar el prompt en caliente sin reiniciar:
    /* const botProcess = activeBots.get(id);
       if (botProcess) botProcess.send({ type: 'UPDATE_CONFIG', prompt }); */
    
    // Por ahora reiniciamos para aplicar cambios limpios si es necesario, 
    // o simplemente confiamos en que al próximo reinicio se cargue.
    // O mejor: forzamos reinicio suave:
    stopBot(id);
    const bot = await botDbService.getBotById(id);
    if(bot.status !== 'disabled') launchBot(bot);

    res.json({ message: 'Prompt actualizado' });
});

app.delete('/delete-bot/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    stopBot(id); // Aquí sí matamos el proceso
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

// === API SCHEDULE, TEAM, FEATURES (Mismos que antes) ===
// ... (Copiar las rutas de features, schedule y team del archivo anterior si no las tienes, son idénticas)

// === INICIO SERVIDOR ===
async function startServer() {
    try {
        const { initializeDatabase } = require('./services/initDb');
        await initializeDatabase();
        
        startSchedulerExecutor(async (botId, action) => {
            console.log(`⏰ Ejecutando tarea programada: ${action} para ${botId}`);
            
            // Actualizar DB
            await botDbService.updateBotStatus(botId, action === 'enable' ? 'enabled' : 'disabled');
            
            // Enviar señal de PAUSA/REANUDAR en lugar de matar/lanzar
            const botProcess = activeBots.get(botId);
            const status = action === 'enable' ? 'enabled' : 'disabled';
            
            if (botProcess) {
                botProcess.send({ type: 'SET_STATUS', status });
            } else if (action === 'enable') {
                // Si debía habilitarse y no estaba corriendo, lanzarlo
                const bot = await botDbService.getBotById(botId);
                launchBot(bot);
            }
            
            // Notificar dashboard
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
            
            // LANZAR TODOS LOS BOTS (INCLUSO LOS DESHABILITADOS, PERO EN PAUSA)
            const allBots = await botDbService.getAllBots();
            allBots.forEach(bot => launchBot(bot));
        });
        
    } catch (error) {
        console.error('❌ Error fatal:', error);
        process.exit(1);
    }
}

startServer();