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
        console.log(`[${botConfig.id}] 🔍 DEBUG: Inicializando WhatsApp Client...`);
        
        try {
            console.log(`[${botConfig.id}] 🔍 DEBUG: Creating WhatsApp Client with config:`, {
                clientId: botConfig.id,
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });
            
            const client = new Client({
                authStrategy: new LocalAuth({ clientId: botConfig.id }),
                puppeteer: {
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu',
                        '--disable-web-security',
                        '--disable-features=VizDisplayCompositor'
                    ],
                    headless: true,
                    timeout: 120000, // Increased timeout to 2 minutes
                    ignoreHTTPSErrors: true,
                    handleSIGINT: false,
                    handleSIGTERM: false,
                    handleSIGHUP: false
                },
                takeoverOnConflict: false,
                takeoverTimeoutMs: 0,
                restartOnAuthFail: true,
                qrMaxRetries: 5, // Add QR retry limit
                authTimeoutMs: 120000 // Increase auth timeout
            });

            whatsappClient = client;

            // Enhanced error handling for client events
            client.on('qr', async (qr) => {
                console.log(`[${botConfig.id}] 🔍 DEBUG: QR Code received`);
                try {
                    const qrCodeUrl = await QRCode.toDataURL(qr);
                    sendStatusToDashboard('QR_GENERATED', { qr: qrCodeUrl });
                } catch (error) {
                    console.error(`[${botConfig.id}] ❌ Error generating QR code:`, error);
                }
            });

            // Add page event listeners to track navigation
            client.on('loading_screen', (percent, message) => {
                console.log(`[${botConfig.id}] 🔍 DEBUG: Loading screen - ${percent}%: ${message}`);
            });

            // Add authentication state change listener
            client.on('authenticated', () => {
                console.log(`[${botConfig.id}] 🔍 DEBUG: Client authenticated successfully`);
            });

            // Add auth failure listener
            client.on('auth_failure', (message) => {
                console.error(`[${botConfig.id}] 🔍 DEBUG: Authentication failure:`, message);
            });

            client.on('ready', async () => {
                console.log(`[${botConfig.id}] ✅ WhatsApp conectado!`);
                sendStatusToDashboard('CONNECTED');
                
                try {
                    // Cargar chats y mensajes existentes al conectar
                    console.log(`[${botConfig.id}] 🔍 DEBUG: Starting loadExistingChats...`);
                    await loadExistingChats();
                    console.log(`[${botConfig.id}] 🔍 DEBUG: loadExistingChats completed successfully`);
                } catch (error) {
                    console.error(`[${botConfig.id}] ❌ Error in loadExistingChats:`, error);
                    console.error(`[${botConfig.id}] 🔍 DEBUG: Stack trace in ready:`, error.stack);
                }
            });

            client.on('disconnected', (reason) => {
                console.log(`[${botConfig.id}] ❌ Desconectado:`, reason);
                sendStatusToDashboard('DISCONNECTED');
            });

            // Add error event listener
            client.on('error', (error) => {
                console.error(`[${botConfig.id}] ❌ WhatsApp Client Error:`, error);
                console.error(`[${botConfig.id}] 🔍 DEBUG: Stack trace in client error:`, error.stack);
            });
        
            client.on('message', async (msg) => {
                console.log(`[${botConfig.id}] 🔍 DEBUG: Message event triggered`);
                
                // Validate message object structure
                if (!msg || !msg.from || !msg.body) {
                    console.log(`[${botConfig.id}] 🔍 DEBUG: Mensaje inválido omitido:`, {
                        hasMsg: !!msg,
                        hasFrom: !!msg?.from,
                        hasBody: !!msg?.body,
                        msgType: msg?.type,
                        from: msg?.from
                    });
                    return;
                }
                
                if (msg.from.endsWith('@g.us')) return; // Ignorar grupos

                const senderId = msg.from;
                const userMessage = msg.body;
                console.log(`[${botConfig.id}] Mensaje de ${senderId}: ${userMessage}`);

                try {
                    console.log(`[${botConfig.id}] 🔍 DEBUG: Iniciando procesamiento de mensaje para ${senderId}`);
                    
                    // Obtener o crear el lead
                    let lead = getOrCreateLead(botConfig.id, senderId);
                    console.log(`[${botConfig.id}] 🔍 DEBUG: Lead obtenido en mensaje:`, {
                        leadId: lead?.id,
                        hasId: !!lead?.id,
                        leadStatus: lead?.status
                    });
                    
                    if (!lead) {
                        console.error(`[${botConfig.id}] ❌ DEBUG: lead es undefined en mensaje para ${senderId}`);
                        throw new Error(`Lead no válido para sender: ${senderId}`);
                    }
                    
                    if (!lead.id) {
                        console.error(`[${botConfig.id}] ❌ DEBUG: lead no tiene id en mensaje:`, lead);
                        throw new Error(`Lead sin ID para sender: ${senderId}`);
                    }
                    
                    // IMPORTANTE: Guardar SIEMPRE el mensaje, sin importar el estado
                    console.log(`[${botConfig.id}] 🔍 DEBUG: Guardando mensaje para lead ${lead.id}`);
                    addLeadMessage(lead.id, 'user', userMessage);
                    
                    // Guardar también en el historial del bot para mantener compatibilidad
                    chatHistoryDB.addMessageToHistory(senderId, 'user', userMessage);

                    // Verificar si el lead ya está asignado a ventas
                    if (lead.status === 'assigned') {
                        console.log(`[${botConfig.id}] 🔍 DEBUG: Lead ${lead.id} ya asignado, notificando dashboard`);
                        // Notificar al dashboard que hay un nuevo mensaje para ventas
                        sendStatusToDashboard('NEW_MESSAGE_FOR_SALES', {
                            leadId: lead.id,
                            from: senderId,
                            message: userMessage
                        });
                        // El bot no responde automáticamente
                        return;
                    }

                    // Sistema de captura inteligente
                    if (lead.status === 'capturing') {
                        console.log(`[${botConfig.id}] 🔍 DEBUG: Procesando lead en estado 'capturing'`);
                        const extractedInfo = await extractLeadInfo(userMessage);
                        
                        if (Object.keys(extractedInfo).length > 0) {
                            lead = updateLeadInfo(lead.id, extractedInfo);
                            console.log(`[${botConfig.id}] Información extraída:`, extractedInfo);
                        }

                        // Verificar si ya tenemos toda la información
                        console.log(`[${botConfig.id}] 🔍 DEBUG: Verificando si lead está completo:`, {
                            name: lead.name,
                            email: lead.email,
                            location: lead.location,
                            phone: lead.phone
                        });
                        if (isLeadComplete(lead)) {
                            console.log(`[${botConfig.id}] 🔍 DEBUG: Lead ${lead.id} está completo, calificando...`);
                            lead = qualifyLead(lead.id);
                            const botReply = "¡Perfecto! Ya tengo toda tu información. Un miembro de nuestro equipo se pondrá en contacto contigo muy pronto. ¡Gracias! 🎉";
                            console.log(`[${botConfig.id}] 🔍 DEBUG: About to reply to message`);
                            await msg.reply(botReply);
                            
                            // GUARDAR respuesta del bot en lead_messages
                            addLeadMessage(lead.id, 'bot', botReply);
                            chatHistoryDB.addMessageToHistory(senderId, 'assistant', botReply);
                            
                            // Notificar al dashboard
                            sendStatusToDashboard('NEW_QUALIFIED_LEAD', { lead });
                            return;
                        }

                        // Generar respuesta del bot
                        console.log(`[${botConfig.id}] 🔍 DEBUG: Generando respuesta del bot`);
                        const followUpQuestion = await generateFollowUpQuestion(lead);
                        let botReply;
                        
                        if (followUpQuestion) {
                            const history = chatHistoryDB.getChatHistory(senderId);
                            const contextReply = await getChatReply(userMessage, history, botConfig.prompt);
                            botReply = `${contextReply}\n\n${followUpQuestion}`;
                        } else {
                            const history = chatHistoryDB.getChatHistory(senderId);
                            botReply = await getChatReply(userMessage, history, botConfig.prompt);
                        }
                        
                        console.log(`[${botConfig.id}] 🔍 DEBUG: About to reply with bot message`);
                        await msg.reply(botReply);
                        
                        // GUARDAR respuesta del bot en lead_messages
                        addLeadMessage(lead.id, 'bot', botReply);
                        chatHistoryDB.addMessageToHistory(senderId, 'assistant', botReply);
                    }

                } catch (error) {
                    console.error(`[${botConfig.id}] ❌ Error procesando mensaje:`, error);
                    console.error(`[${botConfig.id}] 🔍 DEBUG: Stack trace completo en mensaje:`, error.stack);
                    try {
                        await msg.reply("Ups, algo salió mal. Intenta de nuevo.");
                    } catch (replyError) {
                        console.error(`[${botConfig.id}] ❌ Error enviando mensaje de error:`, replyError);
                    }
                }
            });

            console.log(`[${botConfig.id}] 🔍 DEBUG: About to initialize WhatsApp client`);
            
            // Add timeout wrapper to catch initialization timeout
            const initializationTimeout = setTimeout(() => {
                console.error(`[${botConfig.id}] ❌ WhatsApp client initialization timeout (120s)`);
            }, 120000);
            
            // Add retry mechanism for initialization
            let retryCount = 0;
            const maxRetries = 3;
            
            const attemptInitialization = async () => {
                try {
                    console.log(`[${botConfig.id}] 🔍 DEBUG: Initialization attempt ${retryCount + 1}/${maxRetries}`);
                    await client.initialize();
                    clearTimeout(initializationTimeout);
                    console.log(`[${botConfig.id}] ✅ WhatsApp client initialized successfully`);
                } catch (error) {
                    clearTimeout(initializationTimeout);
                    console.error(`[${botConfig.id}] ❌ Error inicializando cliente WhatsApp (attempt ${retryCount + 1}):`, error.message);
                    console.error(`[${botConfig.id}] 🔍 DEBUG: Stack trace completa en initialize:`, error.stack);
                    
                    // Log additional context about the error
                    if (error.message.includes('Execution context was destroyed')) {
                        console.error(`[${botConfig.id}] 🔍 DEBUG: Execution context error detected - possible causes:`);
                        console.error(`[${botConfig.id}] 🔍 DEBUG: 1. Page navigation during script injection`);
                        console.error(`[${botConfig.id}] 🔍 DEBUG: 2. Browser tab/window closed during initialization`);
                        console.error(`[${botConfig.id}] 🔍 DEBUG: 3. Resource constraints (memory/CPU)`);
                        console.error(`[${botConfig.id}] 🔍 DEBUG: 4. WhatsApp Web version incompatibility`);
                        
                        // Retry with exponential backoff
                        if (retryCount < maxRetries) {
                            retryCount++;
                            const retryDelay = Math.pow(2, retryCount) * 1000; // 2s, 4s, 8s
                            console.log(`[${botConfig.id}] 🔍 DEBUG: Retrying initialization in ${retryDelay}ms...`);
                            setTimeout(attemptInitialization, retryDelay);
                            return;
                        }
                    }
                    
                    // If we get here, it's a non-retryable error or we've exhausted retries
                    console.error(`[${botConfig.id}] ❌ WhatsApp client initialization failed after ${retryCount + 1} attempts`);
                }
            };
            
            attemptInitialization();
            
        } catch (error) {
            console.error(`[${botConfig.id}] ❌ Error en initializeWhatsApp:`, error);
            console.error(`[${botConfig.id}] 🔍 DEBUG: Stack trace en initializeWhatsApp:`, error.stack);
        }
    }

    /**
     * Obtiene todos los chats de WhatsApp (individuales, sin grupos)
     */
    async function getAllChats() {
        if (!whatsappClient) {
            console.error('Cliente de WhatsApp no inicializado');
            return [];
        }

        try {
            const chats = await whatsappClient.getChats();
            // Filtrar solo chats individuales (no grupos)
            const individualChats = chats.filter(chat => !chat.isGroup);
            console.log(`[${botConfig.id}] Encontrados ${individualChats.length} chats individuales`);
            return individualChats;
        } catch (error) {
            console.error(`[${botConfig.id}] Error obteniendo chats:`, error);
            return [];
        }
    }

    /**
     * Carga el historial de mensajes de un chat específico
     */
    async function loadHistory(chat, limit = 100) {
        if (!whatsappClient) {
            console.error('Cliente de WhatsApp no inicializado');
            return [];
        }

        try {
            const messages = await chat.fetchMessages({ limit });
            console.log(`[${botConfig.id}] Cargados ${messages.length} mensajes del chat ${chat.name || chat.id.user}`);
            return messages;
        } catch (error) {
            console.error(`[${botConfig.id}] Error cargando historial:`, error);
            return [];
        }
    }

    /**
     * Recupera todos los mensajes de un chat, aplicando límite y filtros
     */
    async function getAllMessages(chatId, limit = 100) {
        if (!whatsappClient) {
            console.error('Cliente de WhatsApp no inicializado');
            return [];
        }

        try {
            const chat = await whatsappClient.getChatById(chatId);
            if (!chat) {
                console.error(`[${botConfig.id}] Chat ${chatId} no encontrado`);
                return [];
            }
            
            const messages = await loadHistory(chat, limit);
            return messages;
        } catch (error) {
            console.error(`[${botConfig.id}] Error obteniendo mensajes:`, error);
            return [];
        }
    }

    /**
     * Obtiene mensajes ya almacenados en la base de datos local
     */
    function getStoredMessages(leadId, limit = 1000) {
        try {
            const messages = require('./services/leadDbService').getLeadMessages(leadId, limit);
            console.log(`[${botConfig.id}] Recuperados ${messages.length} mensajes almacenados para lead ${leadId}`);
            return messages;
        } catch (error) {
            console.error(`[${botConfig.id}] Error obteniendo mensajes almacenados:`, error);
            return [];
        }
    }

    /**
     * Carga mensajes existentes y los procesa como leads
     */
    async function loadMessages(chat, limit = 50) {
        try {
            // Validate chat object structure
            if (!chat || !chat.id || !chat.id._serialized) {
                console.error(`[${botConfig.id}] ❌ Chat object validation failed:`, {
                    hasChat: !!chat,
                    hasChatId: !!chat?.id,
                    hasSerialized: !!chat?.id?._serialized,
                    chatType: chat?.constructor?.name,
                    chatKeys: chat ? Object.keys(chat) : 'NO_CHAT'
                });
                return null;
            }
            
            const senderId = chat.id._serialized;
            console.log(`[${botConfig.id}] 🔍 DEBUG: Iniciando loadMessages para chat: ${senderId}`);
            
            const messages = await loadHistory(chat, limit);
            console.log(`[${botConfig.id}] 🔍 DEBUG: senderId: ${senderId}, mensajes cargados: ${messages.length}`);
            
            // Obtener o crear el lead
            let lead = getOrCreateLead(botConfig.id, senderId);
            console.log(`[${botConfig.id}] 🔍 DEBUG: lead obtenido:`, {
                leadId: lead?.id,
                hasId: !!lead?.id,
                leadStatus: lead?.status
            });
            
            if (!lead) {
                console.error(`[${botConfig.id}] ❌ DEBUG: lead es undefined en loadMessages`);
                return null;
            }
            
            if (!lead.id) {
                console.error(`[${botConfig.id}] ❌ DEBUG: lead no tiene id en loadMessages:`, lead);
                return null;
            }
            
            // Procesar cada mensaje del historial
            for (const message of messages) {
                // Validate message structure
                if (!message || message.fromMe) continue; // Ignorar mensajes enviados por el bot
                
                const userMessage = message.body;
                if (!userMessage || userMessage.trim() === '') continue;
                
                console.log(`[${botConfig.id}] 🔍 DEBUG: Procesando mensaje para lead ${lead.id}: "${userMessage.substring(0, 50)}..."`);
                
                // Verificar si el mensaje ya está almacenado
                const storedMessages = getStoredMessages(lead.id, 1000);
                console.log(`[${botConfig.id}] 🔍 DEBUG: Mensajes almacenados recuperados: ${storedMessages.length}`);
                
                const isAlreadyStored = storedMessages.some(storedMsg =>
                    storedMsg.message === userMessage && storedMsg.sender === 'user'
                );
                
                if (!isAlreadyStored) {
                    console.log(`[${botConfig.id}] 🔍 DEBUG: Guardando nuevo mensaje para lead ${lead.id}`);
                    // Guardar mensaje en la base de datos
                    addLeadMessage(lead.id, 'user', userMessage);
                    
                    // Extraer información del lead
                    try {
                        const extractedInfo = await extractLeadInfo(userMessage);
                        if (Object.keys(extractedInfo).length > 0) {
                            lead = updateLeadInfo(lead.id, extractedInfo);
                            console.log(`[${botConfig.id}] 🔍 DEBUG: Información extraída y lead actualizado:`, extractedInfo);
                        }
                    } catch (extractError) {
                        console.error(`[${botConfig.id}] ❌ Error extrayendo información del mensaje:`, extractError);
                        // Continue processing other messages even if extraction fails
                    }
                } else {
                    console.log(`[${botConfig.id}] 🔍 DEBUG: Mensaje ya almacenado, omitiendo`);
                }
            }
            
            // Verificar si el lead está completo después de procesar el historial
            console.log(`[${botConfig.id}] 🔍 DEBUG: Verificando si lead ${lead.id} está completo`);
            if (isLeadComplete(lead) && lead.status === 'capturing') {
                console.log(`[${botConfig.id}] 🔍 DEBUG: Lead ${lead.id} está completo, calificando...`);
                lead = qualifyLead(lead.id);
                console.log(`[${botConfig.id}] Lead ${lead.id} calificado automáticamente del historial`);
                
                // Notificar al dashboard
                sendStatusToDashboard('NEW_QUALIFIED_LEAD', { lead });
            } else {
                console.log(`[${botConfig.id}] 🔍 DEBUG: Lead ${lead.id} no está completo o ya calificado`, {
                    name: lead.name,
                    email: lead.email,
                    location: lead.location,
                    phone: lead.phone,
                    status: lead.status
                });
            }
            
            return lead;
        } catch (error) {
            console.error(`[${botConfig.id}] ❌ Error cargando mensajes:`, error);
            console.error(`[${botConfig.id}] 🔍 DEBUG: Stack trace completo:`, error.stack);
            return null;
        }
    }

    /**
     * Carga y procesa todos los chats existentes al conectar
     */
    async function loadExistingChats() {
        try {
            console.log(`[${botConfig.id}] 🕐 Cargando chats existentes...`);
            const chats = await getAllChats();
            
            let processedCount = 0;
            let qualifiedCount = 0;
            
            for (const chat of chats) {
                try {
                    const lead = await loadMessages(chat, 50); // Cargar últimos 50 mensajes por chat
                    if (lead) {
                        processedCount++;
                        if (lead.status === 'qualified') {
                            qualifiedCount++;
                        }
                    }
                } catch (chatError) {
                    console.error(`[${botConfig.id}] Error procesando chat ${chat.id._serialized}:`, chatError);
                }
            }
            
            console.log(`[${botConfig.id}] ✅ Procesados ${processedCount} chats, ${qualifiedCount} leads calificados del historial`);
            
        } catch (error) {
            console.error(`[${botConfig.id}] Error cargando chats existentes:`, error);
        }
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