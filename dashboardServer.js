// dashboardServer.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { fork } = require('child_process');
const cookieParser = require('cookie-parser');
const passport = require('passport');

const botDbService = require('./services/botDbService');
const leadDbService = require('./services/leadDbService');
const botConfigService = require('./services/botConfigService');
const schedulerService = require('./services/schedulerService');
const { startSchedulerExecutor } = require('./services/schedulerExecutor');
const authRoutes = require('./routes/authRoutes');
const { attachUser, requireAdmin } = require('./auth/authMiddleware');

require('./auth/passport');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.DASHBOARD_PORT || 3000;

// Mapa de procesos de bots activos: { botId: childProcess }
const activeBots = new Map();

// Mapa de clientes WebSocket conectados: Set de WebSocket
const dashboardClients = new Set();

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

// === RUTAS DE AUTENTICACIÓN ===
app.use('/auth', authRoutes);

// === RUTA DE LOGIN ===
app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    res.render('login');
});

// === RUTA PRINCIPAL (DASHBOARD) - PROTEGIDA ===
app.get('/', requireAdmin, (req, res) => {
    res.render('dashboard', { user: req.user });
});

// === RUTA DE VENTAS (NUEVO) ===
app.get('/sales', requireAdmin, (req, res) => {
    res.render('sales', { user: req.user });
});

// Iniciar el ejecutor de tareas programadas
startSchedulerExecutor((botId, action) => {
    const bot = botDbService.getBotById(botId);
    if (!bot) {
        console.error(`Bot ${botId} no encontrado para ejecutar acción programada`);
        return;
    }

    if (action === 'enable') {
        botDbService.updateBotStatus(botId, 'enabled');
        launchBot(bot);
        broadcastToDashboard({
            type: 'UPDATE_BOT',
            data: { ...botDbService.getBotById(botId), runtimeStatus: 'STARTING' }
        });
    } else if (action === 'disable') {
        botDbService.updateBotStatus(botId, 'disabled');
        stopBot(botId);
        broadcastToDashboard({
            type: 'UPDATE_BOT',
            data: { ...botDbService.getBotById(botId), runtimeStatus: 'DISABLED' }
        });
    }

    broadcastToDashboard({
        type: 'SCHEDULE_EXECUTED',
        data: { botId, action }
    });
});

// === WEBSOCKET: CONEXIÓN ===
wss.on('connection', (ws) => {
    console.log('✅ Cliente WebSocket conectado al dashboard');
    dashboardClients.add(ws);

    const allBots = botDbService.getAllBots();
    const botsData = allBots.map(bot => ({
        ...bot,
        runtimeStatus: getRuntimeStatus(bot)
    }));
    
    ws.send(JSON.stringify({ type: 'INIT', data: botsData }));

    const qualifiedLeads = leadDbService.getQualifiedLeads();
    ws.send(JSON.stringify({ type: 'INIT_LEADS', data: qualifiedLeads }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'ASSIGN_LEAD') {
                handleAssignLead(data.leadId, data.vendorEmail);
            }
            
            if (data.type === 'SEND_MESSAGE') {
                handleSendMessage(data.leadId, data.message, data.vendorEmail);
            }

            if (data.type === 'GET_LEAD_MESSAGES') {
                handleGetLeadMessages(ws, data.leadId);
            }

        } catch (error) {
            console.error('Error procesando mensaje WebSocket:', error);
        }
    });

    ws.on('close', () => {
        console.log('❌ Cliente WebSocket desconectado');
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
function handleBotMessage(botId, message) {
    switch (message.type) {
        case 'QR_GENERATED':
            broadcastToDashboard({
                type: 'UPDATE_BOT',
                data: { ...botDbService.getBotById(botId), runtimeStatus: 'PENDING_QR', qr: message.qr }
            });
            break;
        
        case 'CONNECTED':
            broadcastToDashboard({
                type: 'UPDATE_BOT',
                data: { ...botDbService.getBotById(botId), runtimeStatus: 'CONNECTED' }
            });
            break;
        
        case 'DISCONNECTED':
            broadcastToDashboard({
                type: 'UPDATE_BOT',
                data: { ...botDbService.getBotById(botId), runtimeStatus: 'DISCONNECTED' }
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

    botProcess.on('exit', (code) => {
        console.log(`❌ Bot ${botConfig.id} terminado con código ${code}`);
        activeBots.delete(botConfig.id);
        broadcastToDashboard({
            type: 'UPDATE_BOT',
            data: { ...botConfig, runtimeStatus: 'DISCONNECTED' }
        });
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
function handleAssignLead(leadId, vendorEmail) {
    try {
        const lead = leadDbService.assignLead(leadId, vendorEmail);
        
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
function handleSendMessage(leadId, message, vendorEmail) {
    try {
        const lead = leadDbService.getLeadById(leadId);
        if (!lead) {
            console.error(`Lead ${leadId} no encontrado`);
            return;
        }

        leadDbService.addLeadMessage(leadId, vendorEmail, message);

        const botProcess = activeBots.get(lead.botId);
        if (botProcess) {
            botProcess.send({
                type: 'SEND_MESSAGE',
                to: lead.whatsappNumber,
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

        console.log(`📤 Mensaje enviado desde ${vendorEmail} a lead ${leadId}`);
    } catch (error) {
        console.error('Error enviando mensaje:', error);
    }
}

// === OBTENER HISTORIAL DE MENSAJES DE UN LEAD ===
function handleGetLeadMessages(ws, leadId) {
    try {
        const messages = leadDbService.getLeadMessages(leadId);
        const lead = leadDbService.getLeadById(leadId);
        
        ws.send(JSON.stringify({
            type: 'LEAD_MESSAGES',
            data: {
                leadId: leadId,
                lead: lead,
                messages: messages
            }
        }));
    } catch (error) {
        console.error('Error obteniendo mensajes del lead:', error);
    }
}

// === API: CREAR BOT ===
app.post('/create-bot', requireAdmin, (req, res) => {
    const { name, id, prompt } = req.body;
    const ownerEmail = req.user.email;

    if (!name || !id || !prompt) {
        return res.status(400).json({ message: 'Faltan campos requeridos' });
    }

    const existingBot = botDbService.getBotById(id);
    if (existingBot) {
        return res.status(400).json({ message: 'Ya existe un bot con ese ID' });
    }

    const lastPort = botDbService.getLastPort();
    const newPort = lastPort + 1;

    const botConfig = { id, name, port: newPort, prompt, status: 'enabled', ownerEmail };
    
    try {
        // Crear el bot en la base de datos
        botDbService.addBot(botConfig);
        
        // Crear las features del bot
        botConfigService.createBotFeatures(id);
        
        // Lanzar el bot
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

// === API: EDITAR PROMPT DE BOT ===
app.patch('/edit-bot/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { prompt } = req.body;
    const ownerEmail = req.user.email;

    const bot = botDbService.getBotByIdAndOwner(id, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    if (!prompt) {
        return res.status(400).json({ message: 'El prompt es requerido' });
    }

    botDbService.updateBotPrompt(id, prompt);

    if (activeBots.has(id)) {
        stopBot(id);
        setTimeout(() => {
            const updatedBot = botDbService.getBotById(id);
            if (updatedBot.status === 'enabled') {
                launchBot(updatedBot);
            }
        }, 2000);
    }

    res.json({ message: 'Prompt actualizado exitosamente' });
});

// === API: DESHABILITAR BOT ===
app.post('/disable-bot/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const ownerEmail = req.user.email;

    const bot = botDbService.getBotByIdAndOwner(id, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    botDbService.updateBotStatus(id, 'disabled');
    stopBot(id);

    broadcastToDashboard({
        type: 'UPDATE_BOT',
        data: { ...botDbService.getBotById(id), runtimeStatus: 'DISABLED' }
    });

    res.json({ message: 'Bot deshabilitado' });
});

// === API: HABILITAR BOT ===
app.post('/enable-bot/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const ownerEmail = req.user.email;

    const bot = botDbService.getBotByIdAndOwner(id, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    botDbService.updateBotStatus(id, 'enabled');
    launchBot(botDbService.getBotById(id));

    broadcastToDashboard({
        type: 'UPDATE_BOT',
        data: { ...botDbService.getBotById(id), runtimeStatus: 'STARTING' }
    });

    res.json({ message: 'Bot habilitado' });
});

// === API: ELIMINAR BOT ===
app.delete('/delete-bot/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const ownerEmail = req.user.email;

    const bot = botDbService.getBotByIdAndOwner(id, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    stopBot(id);
    schedulerService.deleteSchedulesByBot(id);
    botConfigService.deleteBotFeatures(id);
    botDbService.deleteBotById(id);

    broadcastToDashboard({
        type: 'BOT_DELETED',
        data: { id }
    });

    res.json({ message: 'Bot eliminado exitosamente' });
});

// === API: OBTENER LEADS CALIFICADOS ===
app.get('/api/leads/qualified', requireAdmin, (req, res) => {
    const leads = leadDbService.getQualifiedLeads();
    res.json(leads);
});

// === API: OBTENER LEADS ASIGNADOS AL USUARIO ===
app.get('/api/leads/assigned', requireAdmin, (req, res) => {
    const leads = leadDbService.getLeadsByVendor(req.user.email);
    res.json(leads);
});

// === API: OBTENER HISTORIAL DE MENSAJES DE UN LEAD ===
app.get('/api/leads/:id/messages', requireAdmin, (req, res) => {
    const { id } = req.params;
    const messages = leadDbService.getLeadMessages(id);
    const lead = leadDbService.getLeadById(id);
    
    res.json({ lead, messages });
});

// === API: OBTENER CONFIGURACIÓN DE FUNCIONALIDADES DE UN BOT ===
app.get('/api/bot/:botId/features', requireAdmin, (req, res) => {
    const { botId } = req.params;
    const ownerEmail = req.user.email;

    const bot = botDbService.getBotByIdAndOwner(botId, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    const features = botConfigService.getBotFeatures(botId);
    res.json(features);
});

// === API: ACTUALIZAR FUNCIONALIDADES DE UN BOT ===
app.patch('/api/bot/:botId/features', requireAdmin, (req, res) => {
    const { botId } = req.params;
    const ownerEmail = req.user.email;

    const bot = botDbService.getBotByIdAndOwner(botId, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    try {
        const updatedFeatures = botConfigService.updateBotFeatures(botId, req.body);
        
        broadcastToDashboard({
            type: 'BOT_FEATURES_UPDATED',
            data: { botId, features: updatedFeatures }
        });

        res.json({ message: 'Funcionalidades actualizadas', features: updatedFeatures });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// === API: CREAR TAREA PROGRAMADA ===
app.post('/api/schedule', requireAdmin, (req, res) => {
    const { botId, action, scheduledAt } = req.body;
    const ownerEmail = req.user.email;

    const bot = botDbService.getBotByIdAndOwner(botId, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    if (!schedulerService.isSchedulingEnabled(botId)) {
        return res.status(403).json({ message: 'La función de agendamiento no está habilitada para este bot' });
    }

    if (!['enable', 'disable'].includes(action)) {
        return res.status(400).json({ message: 'Acción inválida. Usa "enable" o "disable"' });
    }

    const schedule = schedulerService.createSchedule(botId, action, scheduledAt, ownerEmail);
    
    broadcastToDashboard({
        type: 'SCHEDULE_CREATED',
        data: schedule
    });

    res.json({ message: 'Tarea programada creada exitosamente', schedule });
});

// === API: OBTENER TAREAS PROGRAMADAS DE UN BOT ===
app.get('/api/schedules/:botId', requireAdmin, (req, res) => {
    const { botId } = req.params;
    const ownerEmail = req.user.email;

    const bot = botDbService.getBotByIdAndOwner(botId, ownerEmail);
    if (!bot) {
        return res.status(404).json({ message: 'Bot no encontrado o no tienes permiso' });
    }

    const schedules = schedulerService.getSchedulesByBot(botId);
    res.json(schedules);
});

// === API: CANCELAR TAREA PROGRAMADA ===
app.delete('/api/schedule/:scheduleId', requireAdmin, (req, res) => {
    const { scheduleId } = req.params;
    
    schedulerService.cancelSchedule(scheduleId);
    
    broadcastToDashboard({
        type: 'SCHEDULE_CANCELLED',
        data: { scheduleId: parseInt(scheduleId) }
    });

    res.json({ message: 'Tarea cancelada exitosamente' });
});

// === INICIAR SERVIDOR ===
server.listen(PORT, () => {
    console.log(`🚀 Dashboard corriendo en http://localhost:${PORT}`);
    
    const enabledBots = botDbService.getAllBots().filter(bot => bot.status === 'enabled');
    enabledBots.forEach(bot => launchBot(bot));
});