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
const multer = require('multer'); // Nuevo
const fs = require('fs'); // Nuevo

const botDbService = require('./services/botDbService');
const leadDbService = require('./services/leadDbService');
const botConfigService = require('./services/botConfigService');
const schedulerService = require('./services/schedulerService');
const userService = require('./services/userService');
const botImageService = require('./services/botImageService'); // Nuevo

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

// === CONFIGURACIÓN DE MULTER (SUBIDA DE ARCHIVOS) ===
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

// Aplicar attachUser a todas las rutas para tener req.user disponible
app.use(attachUser);

// === CONFIGURACIÓN DE CSP ===
app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https:; " + // Agregado blob: y data: para imágenes
        "connect-src 'self' wss: ws:; " +
        "font-src 'self'; "
    );
    next();
});

// === RUTAS DE AUTENTICACIÓN ===
app.use('/auth', authRoutes);

// === RUTA DE LOGIN ===
app.get('/login', (req, res) => {
    if (req.user) {
        // Redirigir según el rol
        if (req.user.role === 'admin') {
            return res.redirect('/');
        } else if (req.user.role === 'vendor') {
            return res.redirect('/sales');
        }
    }
    res.render('login');
});

// === RUTA PRINCIPAL (DASHBOARD) - SOLO ADMINS ===
app.get('/', requireAdmin, (req, res) => {
    res.render('dashboard', { user: req.user });
});

// === RUTA DE VENTAS - ADMINS Y VENDEDORES ===
app.get('/sales', requireAuth, (req, res) => {
    res.render('sales', { user: req.user });
});

// === WEBSOCKET: CONEXIÓN CON AUTENTICACIÓN ===
wss.on('connection', async (ws, req) => {
    // Extraer y validar el token de la cookie
    const cookies = cookie.parse(req.headers.cookie || '');
    const token = cookies.auth_token;
    
    let user = null;
    if (token) {
        try {
            user = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            console.warn('Token WebSocket inválido');
            ws.close(1008, 'Token inválido');
            return;
        }
    } else {
        console.warn('Conexión WebSocket sin token');
        ws.close(1008, 'No autenticado');
        return;
    }
    
    // Verificar rol (admin o vendor)
    if (user.role !== 'admin' && user.role !== 'vendor') {
        console.warn(`Usuario no autorizado intentó conectar: ${user.email}`);
        ws.close(1008, 'No autorizado');
        return;
    }
    
    console.log(`✅ WebSocket conectado: ${user.email} (${user.role})`);
    dashboardClients.add(ws);

    // Si es admin, enviar información de bots
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
            console.error('❌ Error obteniendo/enviando bots:', error);
        }
    }

    // Enviar leads calificados (ambos roles pueden verlos)
    try {
        const qualifiedLeads = await leadDbService.getQualifiedLeads();
        ws.send(JSON.stringify({ type: 'INIT_LEADS', data: qualifiedLeads }));
    } catch (error) {
        console.error('❌ Error enviando leads:', error);
    }

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'ASSIGN_LEAD') {
                await handleAssignLead(data.leadId, user.email);
            }
            
            if (data.type === 'SEND_MESSAGE') {
                await handleSendMessage(data.leadId, data.message, user.email);
            }

            if (data.type === 'GET_LEAD_MESSAGES') {
                await handleGetLeadMessages(ws, data.leadId);
            }

        } catch (error) {
            console.error('Error procesando mensaje WebSocket:', error);
        }
    });

    ws.on('close', () => {
        dashboardClients.delete(ws);
    });
});

// === FUNCIÓN: Obtener estado en tiempo real de un bot ===
function getRuntimeStatus(bot) {
    if (bot.status === 'disabled') return 'DISABLED';
    
    const botProcess = activeBots.get(bot.id);
    if (!botProcess) return 'DISCONNECTED';
    
    return 'STARTING';
}

// === FUNCIÓN: Broadcast a todos los clientes del dashboard ===
function broadcastToDashboard(message) {
    const messageStr = JSON.stringify(message);
    dashboardClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
        }
    });
}

// === MANEJO DE MENSAJES DE PROCESOS HIJOS (BOTS) ===
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
        
        case 'DISCONNECTED':
            const disconnectedBot = await botDbService.getBotById(botId);
            broadcastToDashboard({
                type: 'UPDATE_BOT',
                data: { ...disconnectedBot, runtimeStatus: 'DISCONNECTED' }
            });
            break;

        case 'NEW_QUALIFIED_LEAD':
            broadcastToDashboard({
                type: 'NEW_QUALIFIED_LEAD',
                data: message.lead
            });
            break;

        case 'NEW_MESSAGE_FOR_SALES':
            broadcastToDashboard({
                type: 'NEW_MESSAGE_FOR_SALES',
                data: {
                    leadId: message.leadId,
                    from: message.from,
                    message: message.message
                }
            });
            break;
    }
}

// === FUNCIÓN: Lanzar un proceso de bot ===
function launchBot(botConfig) {
    if (activeBots.has(botConfig.id)) {
        console.log(`⚠️ El bot ${botConfig.id} ya está ejecutándose.`);
        return;
    }

    console.log(`🚀 Lanzando bot: ${botConfig.name} (${botConfig.id})`);
    
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

// === FUNCIÓN: Detener un bot ===
function stopBot(botId) {
    const botProcess = activeBots.get(botId);
    if (botProcess) {
        botProcess.kill();
        activeBots.delete(botId);
        console.log(`🛑 Bot ${botId} detenido.`);
    }
}

// === MANEJO DE ASIGNACIÓN DE LEADS ===
async function handleAssignLead(leadId, vendorEmail) {
    try {
        const lead = await leadDbService.assignLead(leadId, vendorEmail);
        
        broadcastToDashboard({
            type: 'LEAD_ASSIGNED',
            data: lead
        });

        console.log(`✅ Lead ${leadId} asignado a ${vendorEmail}`);
    } catch (error) {
        console.error('Error asignando lead:', error);
    }
}

// === MANEJO DE ENVÍO DE MENSAJES DESDE VENTAS ===
async function handleSendMessage(leadId, message, vendorEmail) {
    try {
        const lead = await leadDbService.getLeadById(leadId);
        if (!lead) {
            console.error(`Lead ${leadId} no encontrado`);
            return;
        }

        await leadDbService.addLeadMessage(leadId, vendorEmail, message);

        const botProcess = activeBots.get(lead.bot_id);
        if (botProcess) {
            botProcess.send({
                type: 'SEND_MESSAGE',
                to: lead.whatsapp_number,
                message: message
            });
        }

        broadcastToDashboard({
            type: 'MESSAGE_SENT',
            data: {
                leadId: leadId,
                sender: vendorEmail,
                message: message,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Error enviando mensaje:', error);
    }
}

// === OBTENER HISTORIAL DE MENSAJES DE UN LEAD ===
async function handleGetLeadMessages(ws, leadId) {
    try {
        const messages = await leadDbService.getLeadMessages(leadId, 1000);
        const lead = await leadDbService.getLeadById(leadId);
        
        broadcastToDashboard({
            type: 'LEAD_MESSAGES',
            data: {
                leadId: leadId,
                lead: lead,
                messages: messages,
                totalMessages: messages.length
            }
        });
    } catch (error) {
        console.error('Error obteniendo mensajes del lead:', error);
    }
}

// === API: CREAR BOT (SOLO ADMIN) ===
app.post('/create-bot', requireAdmin, async (req, res) => {
    const { name, id, prompt } = req.body;
    const ownerEmail = req.user.email;

    if (!name || !id || !prompt) {
        return res.status(400).json({ message: 'Faltan campos requeridos' });
    }

    const existingBot = await botDbService.getBotById(id);
    if (existingBot) {
        return res.status(400).json({ message: 'Ya existe un bot con ese ID' });
    }

    const lastPort = await botDbService.getLastPort();
    const newPort = lastPort + 1;

    const botConfig = { id, name, port: newPort, prompt, status: 'enabled', ownerEmail };
    
    try {
        await botDbService.addBot(botConfig);
        await botConfigService.createBotFeatures(id);
        launchBot(botConfig);

        broadcastToDashboard({
            type: 'NEW_BOT',
            data: { ...botConfig, runtimeStatus: 'STARTING' }
        });

        res.json({ message: 'Bot creado exitosamente', bot: botConfig });
    } catch (error) {
        console.error('Error creando bot:', error);
        res.status(500).json({ message: 'Error al crear el bot' });
    }
});

// === API: EDITAR PROMPT DE BOT (SOLO ADMIN) ===
app.patch('/edit-bot/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { prompt } = req.body;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(id, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    if (!prompt) {
        return res.status(400).json({ message: 'El prompt es requerido' });
    }

    await botDbService.updateBotPrompt(id, prompt);

    if (activeBots.has(id)) {
        stopBot(id);
        setTimeout(async () => {
            const updatedBot = await botDbService.getBotById(id);
            if (updatedBot.status === 'enabled') {
                launchBot(updatedBot);
            }
        }, 2000);
    }

    res.json({ message: 'Prompt actualizado exitosamente' });
});

// === API: DESHABILITAR BOT (SOLO ADMIN) ===
app.post('/disable-bot/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(id, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    await botDbService.updateBotStatus(id, 'disabled');
    stopBot(id);

    const disabledBot = await botDbService.getBotById(id);
    broadcastToDashboard({
        type: 'UPDATE_BOT',
        data: { ...disabledBot, runtimeStatus: 'DISABLED' }
    });

    res.json({ message: 'Bot deshabilitado' });
});

// === API: HABILITAR BOT (SOLO ADMIN) ===
app.post('/enable-bot/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(id, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    await botDbService.updateBotStatus(id, 'enabled');
    const enabledBot = await botDbService.getBotById(id);
    launchBot(enabledBot);

    broadcastToDashboard({
        type: 'UPDATE_BOT',
        data: { ...enabledBot, runtimeStatus: 'STARTING' }
    });

    res.json({ message: 'Bot habilitado' });
});

// === API: ELIMINAR BOT (SOLO ADMIN) ===
app.delete('/delete-bot/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(id, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    stopBot(id);
    await schedulerService.deleteSchedulesByBot(id);
    await botConfigService.deleteBotFeatures(id);
    // También se deberían borrar las imágenes de la BD y disco aquí, pero lo dejaremos simple
    await botDbService.deleteBotById(id);

    broadcastToDashboard({
        type: 'BOT_DELETED',
        data: { id }
    });

    res.json({ message: 'Bot eliminado exitosamente' });
});

// === NUEVAS RUTAS PARA GESTIÓN DE IMÁGENES ===

// API: SUBIR IMAGEN (SOLO ADMIN)
app.post('/api/bot/:botId/images', requireAdmin, upload.single('image'), async (req, res) => {
    const { botId } = req.params;
    const { keyword } = req.body;
    const file = req.file;

    const ownerEmail = req.user.email;
    const bot = await botDbService.getBotByIdAndOwner(botId, ownerEmail);
    
    if (!bot) {
        // Si hubo archivo subido pero no hay permiso, borrarlo
        if (file && file.path) fs.unlinkSync(file.path);
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    if (!file || !keyword) {
        return res.status(400).json({ message: 'Imagen y palabra clave son requeridas' });
    }

    try {
        const image = await botImageService.addImage(botId, file.filename, file.originalname, keyword);
        
        // Notificar al proceso del bot para actualizar contexto
        const botProcess = activeBots.get(botId);
        if (botProcess) {
            botProcess.send({ type: 'REFRESH_IMAGES' });
        }

        res.json(image);
    } catch (error) {
        console.error('Error subiendo imagen:', error);
        res.status(500).json({ message: 'Error al guardar la imagen' });
    }
});

// API: OBTENER IMÁGENES (SOLO ADMIN)
app.get('/api/bot/:botId/images', requireAdmin, async (req, res) => {
    const { botId } = req.params;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(botId, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    try {
        const images = await botImageService.getImagesByBot(botId);
        res.json(images);
    } catch (error) {
        res.status(500).json({ message: 'Error obteniendo imágenes' });
    }
});

// API: ELIMINAR IMAGEN (SOLO ADMIN)
app.delete('/api/images/:imageId', requireAdmin, async (req, res) => {
    try {
        // Nota: Idealmente deberíamos verificar que la imagen pertenece a un bot del usuario
        // Pero asumimos que si es admin tiene acceso por ahora.
        const deletedImage = await botImageService.deleteImage(req.params.imageId);
        
        if (deletedImage) {
            // Borrar archivo físico
            const filePath = path.join(__dirname, 'public', 'uploads', deletedImage.filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            
            // Notificar al bot
            const botProcess = activeBots.get(deletedImage.bot_id);
            if (botProcess) {
                botProcess.send({ type: 'REFRESH_IMAGES' });
            }
        }
        res.json({ message: 'Imagen eliminada' });
    } catch (error) {
        console.error('Error borrando imagen:', error);
        res.status(500).json({ message: 'Error eliminando imagen' });
    }
});

// === RESTO DE APIS ===

// API: OBTENER LEADS CALIFICADOS
app.get('/api/leads/qualified', requireAuth, async (req, res) => {
    const leads = await leadDbService.getQualifiedLeads();
    res.json(leads);
});

// API: OBTENER LEADS ASIGNADOS
app.get('/api/leads/assigned', requireAuth, async (req, res) => {
    const leads = await leadDbService.getLeadsByVendor(req.user.email);
    res.json(leads);
});

// API: OBTENER HISTORIAL MENSAJES
app.get('/api/leads/:id/messages', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { limit = 1000 } = req.query;
    
    const messages = await leadDbService.getLeadMessages(id, parseInt(limit));
    const lead = await leadDbService.getLeadById(id);
    
    res.json({ 
        lead, 
        messages,
        totalMessages: messages.length 
    });
});

// API: OBTENER CONFIG
app.get('/api/bot/:botId/features', requireAdmin, async (req, res) => {
    const { botId } = req.params;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(botId, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    const features = await botConfigService.getBotFeatures(botId);
    res.json(features);
});

// API: ACTUALIZAR CONFIG
app.patch('/api/bot/:botId/features', requireAdmin, async (req, res) => {
    const { botId } = req.params;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(botId, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    try {
        const updatedFeatures = await botConfigService.updateBotFeatures(botId, req.body);
        
        broadcastToDashboard({
            type: 'BOT_FEATURES_UPDATED',
            data: { botId, features: updatedFeatures }
        });

        res.json({ message:'Funcionalidades actualizadas', features: updatedFeatures });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// === API: CREAR TAREA PROGRAMADA (SOLO ADMIN) ===
app.post('/api/schedule', requireAdmin, async (req, res) => {
    const { botId, action, scheduledAt } = req.body;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(botId, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    const isEnabled = await schedulerService.isSchedulingEnabled(botId);
    if (!isEnabled) {
        return res.status(403).json({ message: 'La función de agendamiento no está habilitada para este bot' });
    }

    if (!['enable', 'disable'].includes(action)) {
        return res.status(400).json({ message: 'Acción inválida. Usa "enable" o "disable"' });
    }

    const schedule = await schedulerService.createSchedule(botId, action, scheduledAt, ownerEmail);
    
    broadcastToDashboard({
        type: 'SCHEDULE_CREATED',
        data: schedule    });

    res.json({ message: 'Tarea programada creada exitosamente', schedule });
});

// === API: OBTENER TAREAS PROGRAMADAS DE UN BOT (SOLO ADMIN) ===
app.get('/api/schedules/:botId', requireAdmin, async (req, res) => {
    const { botId } = req.params;
    const ownerEmail = req.user.email;

    const bot = await botDbService.getBotByIdAndOwner(botId, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    const schedules = await schedulerService.getSchedulesByBot(botId);
    res.json(schedules);
});

// === API: CANCELAR TAREA PROGRAMADA (SOLO ADMIN) ===
app.delete('/api/schedule/:scheduleId', requireAdmin, async (req, res) => {
    const { scheduleId } = req.params;
    
    await schedulerService.cancelSchedule(scheduleId);
    
    broadcastToDashboard({
        type: 'SCHEDULE_CANCELLED',
        data: { scheduleId: parseInt(scheduleId) }
    });

    res.json({ message: 'Tarea cancelada exitosamente' });
});

// === API: OBTENER MIEMBROS DEL EQUIPO (SOLO ADMIN) ===
app.get('/api/team', requireAdmin, async (req, res) => {
    try {
        const members = await userService.getTeamMembers(req.user.email);
        res.json(members);
    } catch (error) {
        console.error('Error obteniendo equipo:', error);
        res.status(500).json({ message: 'Error obteniendo equipo' });
    }
});

// === API: AGREGAR MIEMBRO AL EQUIPO (SOLO ADMIN) ===
app.post('/api/team', requireAdmin, async (req, res) => {
    try {
        const { email, role } = req.body;
        
        if (!email || !role) {
            return res.status(400).json({ message: 'Email y rol son requeridos' });
        }
        
        if (!['vendor', 'admin'].includes(role)) {
            return res.status(400).json({ message: 'Rol inválido' });
        }
        
        const newMember = await userService.addTeamMember(email, role, req.user.email);
        res.json({ 
            message: 'Miembro agregado exitosamente', 
            user: newMember 
        });
    } catch (error) {
        console.error('Error agregando miembro:', error);
        res.status(400).json({ message: error.message });
    }
});

// === API: CAMBIAR ESTADO DE USUARIO (SOLO ADMIN) ===
app.patch('/api/team/:userId/toggle', requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const updatedUser = await userService.toggleUserStatus(userId, req.user.email);
        
        if (!updatedUser) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }
        
        res.json({ 
            message: updatedUser.is_active ? 'Usuario activado' : 'Usuario desactivado',
            user: updatedUser 
        });
    } catch (error) {
        console.error('Error cambiando estado:', error);
        res.status(500).json({ message: 'Error cambiando estado del usuario' });
    }
});

// === API: ELIMINAR MIEMBRO DEL EQUIPO (SOLO ADMIN) ===
app.delete('/api/team/:userId', requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        await userService.removeTeamMember(userId, req.user.email);
        res.json({ message: 'Usuario eliminado exitosamente' });
    } catch (error) {
        console.error('Error eliminando usuario:', error);
        res.status(500).json({ message: 'Error eliminando usuario' });
    }
});

// === INICIAR SERVIDOR CON INICIALIZACIÓN DE DB ===
async function startServer() {
    try {
        // 1. Inicializar base de datos PRIMERO
        const { initializeDatabase } = require('./services/initDb');
        await initializeDatabase();
        
        // 2. Iniciar ejecutor de tareas programadas
        startSchedulerExecutor(async (botId, action) => {
            const bot = await botDbService.getBotById(botId);
            if (!bot) {
                console.error(`Bot ${botId} no encontrado para ejecutar acción programada`);
                return;
            }

            if (action === 'enable') {
                await botDbService.updateBotStatus(botId, 'enabled');
                launchBot(bot);
                broadcastToDashboard({
                    type: 'UPDATE_BOT',
                    data: { ...(await botDbService.getBotById(botId)), runtimeStatus: 'STARTING' }
                });
            } else if (action === 'disable') {
                await botDbService.updateBotStatus(botId, 'disabled');
                stopBot(botId);
                broadcastToDashboard({
                    type: 'UPDATE_BOT',
                    data: { ...(await botDbService.getBotById(botId)), runtimeStatus: 'DISABLED' }
                });
            }

            broadcastToDashboard({
                type: 'SCHEDULE_EXECUTED',
                data: { botId, action }
            });
        });
        
        // 3. Iniciar servidor HTTP
        server.listen(PORT, '0.0.0.0', async () => {
            console.log(`🚀 Dashboard corriendo en puerto ${PORT}`);
            
            // 4. Lanzar bots habilitados
            const enabledBots = (await botDbService.getAllBots()).filter(bot => bot.status === 'enabled');
            enabledBots.forEach(bot => launchBot(bot));
        });
        
    } catch (error) {
        console.error('❌ Error fatal al iniciar servidor:', error);
        process.exit(1);
    }
}

// Iniciar la aplicación
startServer();