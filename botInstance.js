// botInstance.js
require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const { getChatReply } = require('./services/deepseekService');
const { extractLeadInfo, generateFollowUpQuestion } = require('./services/leadExtractionService');
const botImageService = require('./services/botImageService');
const { 
    getOrCreateLead, 
    updateLeadInfo, 
    qualifyLead, 
    addLeadMessage,
    getLeadMessages,
    isLeadComplete,
    getLeadById
} = require('./services/leadDbService');

let botConfig;
let isReady = false; 
let isPaused = false; // NUEVO: Controla si el bot responde o no
let whatsappClient;
let availableImages = []; 

// === COMUNICACIÓN CON EL PROCESO PADRE ===
function sendStatusToDashboard(type, data = {}) {
    if (process.send) {
        process.send({ type, ...data, botId: botConfig.id });
    }
}

process.on('message', (msg) => {
    if (msg.type === 'INIT') {
        botConfig = msg.config;
        // Si arranca deshabilitado, lo ponemos en pausa de inmediato
        isPaused = botConfig.status === 'disabled';
        
        console.log(`[${botConfig.id}] Inicializando "${botConfig.name}" | Estado inicial: ${isPaused ? 'PAUSADO' : 'ACTIVO'}`);
        
        loadBotImages().then(() => {
            initializeWhatsApp();
        });

    } else if (msg.type === 'SEND_MESSAGE') {
        handleOutgoingMessage(msg.to, msg.message);
    
    } else if (msg.type === 'REFRESH_IMAGES') {
        console.log(`[${botConfig.id}] 🔄 Solicitud de recarga de imágenes recibida`);
        loadBotImages();

    } else if (msg.type === 'SET_STATUS') {
        // NUEVO: Cambio de estado dinámico sin reiniciar
        if (msg.status === 'disabled') {
            isPaused = true;
            console.log(`[${botConfig.id}] ⏸️ Bot PAUSADO (Silenciado)`);
            sendStatusToDashboard('UPDATE_BOT', { ...botConfig, status: 'disabled', runtimeStatus: 'DISABLED' });
        } else {
            isPaused = false;
            console.log(`[${botConfig.id}] ▶️ Bot REANUDADO (Activo)`);
            // Enviamos CONNECTED para que el dashboard sepa que está listo
            sendStatusToDashboard('UPDATE_BOT', { ...botConfig, status: 'enabled', runtimeStatus: 'CONNECTED' });
        }
    }
});

// === GESTIÓN DE IMÁGENES ===
async function loadBotImages() {
    try {
        availableImages = await botImageService.getImagesByBot(botConfig.id);
        console.log(`[${botConfig.id}] 🖼️ Imágenes cargadas en memoria: ${availableImages.length}`);
    } catch (error) {
        console.error(`[${botConfig.id}] ❌ Error cargando imágenes:`, error);
    }
}

// === INICIALIZACIÓN DE WHATSAPP (OPTIMIZADA) ===
function initializeWhatsApp() {
    console.log(`[${botConfig.id}] 🔍 DEBUG: Inicializando WhatsApp Client (Optimizado)...`);
    
    try {
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: botConfig.id }),
            puppeteer: {
                headless: 'new', // Modo headless moderno (más rápido)
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', // Usa disco en vez de RAM compartida
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process', // Importante para contenedores pequeños
                    '--disable-gpu',
                    '--disable-extensions',
                    '--disable-component-update',
                    '--disable-default-apps',
                    '--mute-audio',
                    '--no-default-browser-check',
                    '--disable-infobars',
                    '--disable-features=IsolateOrigins,site-per-process'
                ],
                timeout: 180000, // Aumentado a 3 minutos
            },
            takeoverOnConflict: false,
            takeoverTimeoutMs: 0,
            restartOnAuthFail: true,
            qrMaxRetries: 5,
            authTimeoutMs: 0, // Sin límite de tiempo para autenticar
            bypassCSP: true
        });

        whatsappClient = client;

        client.on('qr', async (qr) => {
            console.log(`[${botConfig.id}] 🔍 DEBUG: QR Code received`);
            try {
                const qrCodeUrl = await QRCode.toDataURL(qr);
                sendStatusToDashboard('QR_GENERATED', { qr: qrCodeUrl });
            } catch (error) {
                console.error(`[${botConfig.id}] ❌ Error generating QR code:`, error);
            }
        });

        client.on('ready', async () => {
            console.log(`[${botConfig.id}] ✅ WhatsApp conectado!`);
            
            // Si está pausado, reportamos DISABLED para que el UI se vea gris, si no CONNECTED
            const statusReport = isPaused ? 'DISABLED' : 'CONNECTED';
            sendStatusToDashboard(isPaused ? 'UPDATE_BOT' : 'CONNECTED', { 
                ...botConfig, 
                status: isPaused ? 'disabled' : 'enabled',
                runtimeStatus: statusReport 
            });
            
            try {
                // Solo cargar historial si NO estamos pausados inicialmente para ahorrar recursos
                if (!isPaused) {
                    console.log(`[${botConfig.id}] 🔍 DEBUG: Cargando historial existente...`);
                    await loadExistingChats();
                }
                
                isReady = true;
                console.log(`[${botConfig.id}] ✅ Bot listo (Estado: ${isPaused ? 'Pausado' : 'Activo'})`);
            } catch (error) {
                console.error(`[${botConfig.id}] ❌ Error in loadExistingChats:`, error);
                isReady = true; 
            }
        });

        client.on('disconnected', (reason) => {
            console.log(`[${botConfig.id}] ❌ Desconectado:`, reason);
            isReady = false;
            sendStatusToDashboard('DISCONNECTED');
        });

        client.on('message', async (msg) => {
            // === BLOQUEO DE PAUSA ===
            if (!isReady || isPaused) return; 
            
            if (!msg || !msg.from || !msg.body || msg.from.endsWith('@g.us')) return;

            const senderId = msg.from;
            const userMessage = msg.body;
            console.log(`[${botConfig.id}] 📩 Mensaje de ${senderId}: ${userMessage}`);

            try {
                let lead = await getOrCreateLead(botConfig.id, senderId);
                
                if (!lead || !lead.id) return;
                
                // 1. Guardamos el mensaje del usuario en la BD
                await addLeadMessage(lead.id, 'user', userMessage);

                if (lead.status === 'assigned') {
                    sendStatusToDashboard('NEW_MESSAGE_FOR_SALES', {
                        leadId: lead.id,
                        from: senderId,
                        message: userMessage
                    });
                    return;
                }

                if (lead.status === 'capturing') {
                    // Lógica de extracción de datos (sin cambios)
                    const extractedInfo = await extractLeadInfo(userMessage);
                    if (Object.keys(extractedInfo).length > 0) {
                        lead = await updateLeadInfo(lead.id, extractedInfo);
                    }
                    
                    if (isLeadComplete(lead)) {
                        lead = await qualifyLead(lead.id);
                        const finalMsg = "¡Perfecto! Ya tengo toda tu información. Un asesor te contactará pronto. 🎉";
                        await msg.reply(finalMsg);
                        await addLeadMessage(lead.id, 'bot', finalMsg);
                        sendStatusToDashboard('NEW_QUALIFIED_LEAD', { lead });
                        return;
                    }

                    // Generación de respuesta con imágenes
                    const followUpQuestion = await generateFollowUpQuestion(lead);
                    let promptWithImages = botConfig.prompt;
                    
                    if (availableImages.length > 0) {
                        const keywords = availableImages.map(img => img.keyword).join(', ');
                        promptWithImages += `\n\n[INSTRUCCIÓN DEL SISTEMA DE IMÁGENES]:
                        Tienes acceso a imágenes visuales sobre los siguientes temas: [${keywords}].
                        Si el usuario pregunta explícitamente por alguno de estos temas o si crees que una imagen ayudaría a vender mejor,
                        DEBES incluir la etiqueta [ENVIAR_IMAGEN: palabra_clave] al final de tu respuesta.`;
                    }

                    // === CORRECCIÓN 1: CONTEXTO ===
                    // Obtenemos los mensajes de la BD (esto incluye el que acabamos de guardar)
                    const messages = await getLeadMessages(lead.id, 20);
                    
                    // Eliminamos el último mensaje (pop o slice) porque deepseekService.js 
                    // ya agrega el 'userMessage' actual al final del array. 
                    // Si no hacemos esto, la IA ve el mensaje duplicado.
                    const historyMessages = messages.slice(0, -1);

                    const history = historyMessages.map(m => ({
                        role: m.sender === 'user' ? 'user' : 'assistant', // Mapeamos 'bot' a 'assistant'
                        content: m.message
                    }));
                    
                    let botReply;
                    const aiResponse = await getChatReply(userMessage, history, promptWithImages);
                    
                    if (followUpQuestion) {
                        botReply = `${aiResponse}\n\n${followUpQuestion}`;
                    } else {
                        botReply = aiResponse;
                    }
                    
                    // === CORRECCIÓN 2: IMÁGENES ===
                    // Cambiamos el Regex para buscar [ ] en lugar de $$ $$
                    // Esto coincide con la instrucción del prompt: [ENVIAR_IMAGEN: palabra_clave]
                    const imageTagRegex = /\$\$\s*ENVIAR_IMAGEN:\s*([\s\S]+?)\s*\$\$/i;
                    
                    const match = botReply.match(imageTagRegex);
                    let imageToSend = null;

                    if (match) {
                        const keyword = match[1].trim().toLowerCase();
                        console.log(`[${botConfig.id}] 🖼️ IA solicitó imagen con keyword: "${keyword}"`);
                        
                        imageToSend = availableImages.find(img => img.keyword === keyword);
                        
                        // Limpiamos la etiqueta del texto que se envía al usuario
                        botReply = botReply.replace(match[0], '').trim();
                    }

                    if (botReply) {
                        await msg.reply(botReply);
                        await addLeadMessage(lead.id, 'bot', botReply);
                    }

                    if (imageToSend) {
                        try {
                            const imagePath = path.join(__dirname, 'public', 'uploads', imageToSend.filename);
                            const media = MessageMedia.fromFilePath(imagePath);
                            await client.sendMessage(msg.from, media, { caption: imageToSend.original_name });
                            await addLeadMessage(lead.id, 'bot', `[Imagen enviada: ${imageToSend.original_name}]`);
                        } catch (imgError) {
                            console.error(`[${botConfig.id}] ❌ Error enviando imagen:`, imgError);
                        }
                    }
                }

            } catch (error) {
                console.error(`[${botConfig.id}] ❌ Error procesando mensaje:`, error);
            }
        });

        // Reintentos automáticos si puppeteer falla al inicio
        let retryCount = 0;
        const attemptInitialization = async () => {
            try {
                await client.initialize();
            } catch (error) {
                if (retryCount < 3) {
                    retryCount++;
                    console.log(`[${botConfig.id}] 🔄 Reintento de inicio ${retryCount}/3`);
                    setTimeout(attemptInitialization, 5000);
                }
            }
        };
        attemptInitialization();
        
    } catch (error) {
        console.error(`[${botConfig.id}] ❌ Error en initializeWhatsApp:`, error);
    }
}

// === FUNCIONES AUXILIARES ===

async function getAllChats() {
    if (!whatsappClient) return [];
    try {
        const chats = await whatsappClient.getChats();
        return chats.filter(chat => !chat.isGroup);
    } catch (error) { return []; }
}

async function loadHistory(chat, limit = 100) {
    if (!whatsappClient) return [];
    try { return await chat.fetchMessages({ limit }); } catch (error) { return []; }
}

async function loadMessages(chat, limit = 50) {
    try {
        if (!chat || !chat.id || !chat.id._serialized) return null;
        const senderId = chat.id._serialized;
        const messages = await loadHistory(chat, limit);
        let lead = await getOrCreateLead(botConfig.id, senderId);
        if (!lead) return null;
        
        for (const message of messages) {
            if (!message || message.fromMe) continue;
            const userMessage = message.body;
            if (!userMessage || userMessage.trim() === '') continue;
            
            const storedMessages = await getLeadMessages(lead.id, 1000);
            const isAlreadyStored = storedMessages.some(storedMsg =>
                storedMsg.message === userMessage && storedMsg.sender === 'user'
            );
            
            if (!isAlreadyStored) {
                await addLeadMessage(lead.id, 'user', userMessage);
                try {
                    const extractedInfo = await extractLeadInfo(userMessage);
                    if (Object.keys(extractedInfo).length > 0) {
                        lead = await updateLeadInfo(lead.id, extractedInfo);
                    }
                } catch (e) {}
            }
        }
        if (isLeadComplete(lead) && lead.status === 'capturing') {
            lead = await qualifyLead(lead.id);
        }
        return lead;
    } catch (error) { return null; }
}

async function loadExistingChats() {
    try {
        const chats = await getAllChats();
        for (const chat of chats) { await loadMessages(chat, 20); }
    } catch (error) {}
}

async function handleOutgoingMessage(to, message) {
    if (!whatsappClient) return;
    try {
        await whatsappClient.sendMessage(to, message);
        console.log(`[${botConfig.id}] ✅ Mensaje saliente enviado a ${to}`);
    } catch (error) {
        console.error(`[${botConfig.id}] ❌ Error enviando mensaje saliente:`, error);
    }
}