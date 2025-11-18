// botInstance.js
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { getChatReply } = require('./services/deepseekService');
const { extractLeadInfo, generateFollowUpQuestion } = require('./services/leadExtractionService');
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
let chatHistoryDB;

function sendStatusToDashboard(type, data = {}) {
    if (process.send) {
        process.send({ type, ...data, botId: botConfig.id });
    }
}

process.on('message', (msg) => {
    if (msg.type === 'INIT') {
        botConfig = msg.config;
        console.log(`[${botConfig.id}] Inicializando con nombre "${botConfig.name}"...`);
        chatHistoryDB = require('./services/chatHistoryService').init(botConfig.id);
        initializeWhatsApp();
    } else if (msg.type === 'SEND_MESSAGE') {
        // Permite enviar mensajes desde el dashboard
        handleOutgoingMessage(msg.to, msg.message);
    }
});

let whatsappClient;

function initializeWhatsApp() {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: botConfig.id }),
        puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    whatsappClient = client;

    client.on('qr', async (qr) => {
        const qrCodeUrl = await QRCode.toDataURL(qr);
        sendStatusToDashboard('QR_GENERATED', { qr: qrCodeUrl });
    });

    client.on('ready', () => {
        console.log(`[${botConfig.id}] ✅ WhatsApp conectado!`);
        sendStatusToDashboard('CONNECTED');
    });

    client.on('disconnected', (reason) => {
        console.log(`[${botConfig.id}] ❌ Desconectado:`, reason);
        sendStatusToDashboard('DISCONNECTED');
    });

    client.on('message', async (msg) => {
        if (msg.from.endsWith('@g.us')) return; // Ignorar grupos

        const senderId = msg.from;
        const userMessage = msg.body;
        console.log(`[${botConfig.id}] Mensaje de ${senderId}: ${userMessage}`);

        try {
            // Obtener o crear el lead
            let lead = getOrCreateLead(botConfig.id, senderId);
            
            // Registrar el mensaje del usuario
            addLeadMessage(lead.id, 'user', userMessage);

            // Verificar si el lead ya está asignado a ventas
            if (lead.status === 'assigned') {
                // Notificar al dashboard que hay un nuevo mensaje para ventas
                sendStatusToDashboard('NEW_MESSAGE_FOR_SALES', {
                    leadId: lead.id,
                    from: senderId,
                    message: userMessage
                });
                // El bot no responde, solo ventas puede responder
                return;
            }

            // Si está en modo captura, extraer información
            if (lead.status === 'capturing') {
                const extractedInfo = await extractLeadInfo(userMessage);
                
                if (Object.keys(extractedInfo).length > 0) {
                    lead = updateLeadInfo(lead.id, extractedInfo);
                    console.log(`[${botConfig.id}] Información extraída:`, extractedInfo);
                }

                // Verificar si ya tenemos toda la información
                if (isLeadComplete(lead)) {
                    lead = qualifyLead(lead.id);
                    const botReply = "¡Perfecto! Ya tengo toda tu información. Un miembro de nuestro equipo se pondrá en contacto contigo muy pronto. ¡Gracias! 🎉";
                    msg.reply(botReply);
                    addLeadMessage(lead.id, 'bot', botReply);
                    
                    // Notificar al dashboard que hay un nuevo lead calificado
                    sendStatusToDashboard('NEW_QUALIFIED_LEAD', { lead });
                    return;
                }

                // Si falta información, hacer una pregunta
                const followUpQuestion = await generateFollowUpQuestion(lead);
                
                if (followUpQuestion) {
                    // Primero responder al mensaje del usuario usando el prompt del bot
                    const history = chatHistoryDB.getChatHistory(senderId);
                    const contextReply = await getChatReply(userMessage, history, botConfig.prompt);
                    
                    // Combinar respuesta contextual con la pregunta
                    const botReply = `${contextReply}\n\n${followUpQuestion}`;
                    msg.reply(botReply);
                    
                    addLeadMessage(lead.id, 'bot', botReply);
                    chatHistoryDB.addMessageToHistory(senderId, 'user', userMessage);
                    chatHistoryDB.addMessageToHistory(senderId, 'assistant', botReply);
                } else {
                    // Respuesta normal del bot
                    const history = chatHistoryDB.getChatHistory(senderId);
                    const botReply = await getChatReply(userMessage, history, botConfig.prompt);
                    msg.reply(botReply);
                    
                    addLeadMessage(lead.id, 'bot', botReply);
                    chatHistoryDB.addMessageToHistory(senderId, 'user', userMessage);
                    chatHistoryDB.addMessageToHistory(senderId, 'assistant', botReply);
                }
            }

        } catch (error) {
            console.error(`[${botConfig.id}] Error procesando mensaje:`, error);
            msg.reply("Ups, algo salió mal. Intenta de nuevo.");
        }
    });

    client.initialize();
}

async function handleOutgoingMessage(to, message) {
    if (!whatsappClient) {
        console.error('Cliente de WhatsApp no inicializado');
        return;
    }

    try {
        await whatsappClient.sendMessage(to, message);
        console.log(`[${botConfig.id}] Mensaje enviado a ${to}`);
    } catch (error) {
        console.error(`[${botConfig.id}] Error enviando mensaje:`, error);
    }
}