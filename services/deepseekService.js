// services/deepseekService.js
const axios = require('axios');

async function getChatReply(message, history = [], systemPrompt) {
  try {
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    if (!DEEPSEEK_API_KEY) {
      throw new Error('DEEPSEEK_API_KEY no configurada');
    }

    const messages = [
      { role: 'system', content: systemPrompt }, // Usa el prompt del bot específico
      ...history,
      { role: 'user', content: message }
    ];

    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: messages,
    }, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0].message.content;

  } catch (error) {
    console.error('❌ ERROR EN DEEPSEEK:', error.message);
    return "Lo siento, estoy teniendo problemas técnicos.";
  }
}

module.exports = { getChatReply };