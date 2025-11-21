// services/subscriptionService.js
const pool = require('./db');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Planes Freemium
const PLANS = {
    free: {
        name: 'Gratuito',
        price: 0,
        botLimit: 1,
        features: ['1 bot activo', 'Leads ilimitados', 'Soporte por email']
    },
    pro: {
        name: 'Pro',
        price: 49,
        priceId: process.env.STRIPE_PRICE_ID_PRO, // Lo crearemos en Stripe
        botLimit: -1, // Ilimitado
        features: ['Bots ilimitados', 'Leads ilimitados', 'Soporte prioritario', 'Sin marca "Powered by"']
    }
};

/**
 * Obtener o crear suscripción
 */
async function getOrCreateSubscription(userEmail) {
    try {
        let result = await pool.query(
            'SELECT * FROM subscriptions WHERE user_email = $1',
            [userEmail]
        );

        if (result.rows.length === 0) {
            // Crear suscripción gratuita por defecto
            result = await pool.query(
                'INSERT INTO subscriptions (user_email, plan, status, bot_limit) VALUES ($1, $2, $3, $4) RETURNING *',
                [userEmail, 'free', 'active', 1]
            );
        }

        return result.rows[0];
    } catch (error) {
        console.error('Error obteniendo suscripción:', error);
        throw error;
    }
}

/**
 * Verificar si el usuario puede crear más bots
 */
async function canCreateBot(userEmail, currentBotCount) {
    try {
        const subscription = await getOrCreateSubscription(userEmail);
        
        // -1 significa ilimitado (plan Pro)
        if (subscription.bot_limit === -1) return true;
        
        // Plan gratuito: máximo 1 bot
        return currentBotCount < subscription.bot_limit;
    } catch (error) {
        console.error('Error verificando límite de bots:', error);
        return false;
    }
}

/**
 * Obtener información del límite actual
 */
async function getBotLimitInfo(userEmail, currentBotCount) {
    const subscription = await getOrCreateSubscription(userEmail);
    
    return {
        currentPlan: subscription.plan,
        botLimit: subscription.bot_limit,
        currentBotCount: currentBotCount,
        canCreateMore: subscription.bot_limit === -1 || currentBotCount < subscription.bot_limit,
        isUnlimited: subscription.bot_limit === -1
    };
}

/**
 * Crear sesión de checkout para upgrade a Pro
 */
async function createCheckoutSession(userEmail, successUrl, cancelUrl) {
    try {
        const subscription = await getOrCreateSubscription(userEmail);
        
        // Crear o recuperar customer de Stripe
        let customerId = subscription.stripe_customer_id;
        
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: userEmail,
                metadata: { userEmail }
            });
            customerId = customer.id;
            
            await pool.query(
                'UPDATE subscriptions SET stripe_customer_id = $1 WHERE user_email = $2',
                [customerId, userEmail]
            );
        }

        // Crear sesión de checkout
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [
                {
                    price: process.env.STRIPE_PRICE_ID_PRO,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: {
                userEmail,
                plan: 'pro'
            }
        });

        return session;
    } catch (error) {
        console.error('Error creando sesión de checkout:', error);
        throw error;
    }
}

/**
 * Portal de gestión (cancelar, actualizar tarjeta, etc)
 */
async function createBillingPortalSession(userEmail, returnUrl) {
    try {
        const subscription = await getOrCreateSubscription(userEmail);
        
        if (!subscription.stripe_customer_id) {
            throw new Error('No hay suscripción activa');
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: subscription.stripe_customer_id,
            return_url: returnUrl,
        });

        return session;
    } catch (error) {
        console.error('Error creando portal:', error);
        throw error;
    }
}

/**
 * Actualizar suscripción cuando Stripe confirma el pago
 */
async function updateSubscriptionFromStripe(stripeSubscriptionId) {
    try {
        const stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        const customerId = stripeSubscription.customer;
        
        // Obtener email del customer
        const customer = await stripe.customers.retrieve(customerId);
        const userEmail = customer.email;
        
        await pool.query(`
            UPDATE subscriptions 
            SET stripe_subscription_id = $1,
                plan = 'pro',
                status = $2,
                bot_limit = -1,
                current_period_end = to_timestamp($3),
                updated_at = CURRENT_TIMESTAMP
            WHERE user_email = $4
        `, [
            stripeSubscriptionId,
            stripeSubscription.status,
            stripeSubscription.current_period_end,
            userEmail
        ]);

        console.log(`✅ Usuario ${userEmail} actualizado a plan Pro`);
        return await getOrCreateSubscription(userEmail);
    } catch (error) {
        console.error('Error actualizando suscripción:', error);
        throw error;
    }
}

/**
 * Manejar cancelación de suscripción
 */
async function handleSubscriptionCanceled(stripeSubscriptionId) {
    try {
        const stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        const customerId = stripeSubscription.customer;
        
        const customer = await stripe.customers.retrieve(customerId);
        const userEmail = customer.email;

        await pool.query(`
            UPDATE subscriptions 
            SET plan = 'free',
                status = 'canceled',
                bot_limit = 1,
                stripe_subscription_id = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_email = $1
        `, [userEmail]);

        console.log(`⚠️ Usuario ${userEmail} regresó a plan gratuito`);
        return await getOrCreateSubscription(userEmail);
    } catch (error) {
        console.error('Error manejando cancelación:', error);
        throw error;
    }
}

module.exports = {
    PLANS,
    getOrCreateSubscription,
    canCreateBot,
    getBotLimitInfo,
    createCheckoutSession,
    createBillingPortalSession,
    updateSubscriptionFromStripe,
    handleSubscriptionCanceled
};