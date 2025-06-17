import { json } from 'express';
import Stripe from 'stripe';
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// --- (Helper Functions: getSecret, connectToNeon) ---
const secretsManagerClient = new SecretsManagerClient({});
let neonClient;

async function getSecret(secretName) {
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const data = await secretsManagerClient.send(command);
    if ("SecretString" in data) {
      return data.SecretString;
    }
    throw new Error(`SecretString not found for ${secretName}`);
}

async function connectToNeon() {
    if (!neonClient || neonClient.ended) {
      const neonConnectionString = await getSecret(process.env.NEON_CONNECTION_STRING_SECRET_NAME);
      neonClient = new Client({
        connectionString: neonConnectionString,
        ssl: { rejectUnauthorized: false },
      });
      await neonClient.connect();
      console.log("Connected to Neon PostgreSQL for webhook processing.");
    }
    return neonClient;
}
// ----------------------------------------------------

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// This configuration map is the "brain" of your checkout logic.
// It maps a simple identifier from the frontend to the correct Stripe IDs and checkout mode.
const TIER_CONFIG = {
    // Regular User Plans
    'pro-trial':  { type: 'trial', trialFeePriceId: process.env.STRIPE_PRO_TRIAL_PRICE_ID, recurringPriceId: process.env.STRIPE_PRO_MONTHLY_PRICE_ID },
    'pro-monthly':{ type: 'subscription', priceId: process.env.STRIPE_PRO_MONTHLY_PRICE_ID },
    'pro-annual': { type: 'subscription', priceId: process.env.STRIPE_PRO_ANNUAL_ID },
    
    'vip-trial':  { type: 'trial', trialFeePriceId: process.env.STRIPE_VIP_TRIAL_PRICE_ID, recurringPriceId: process.env.STRIPE_VIP_MONTHLY_PRICE_ID },
    'vip-monthly':{ type: 'subscription', priceId: process.env.STRIPE_VIP_MONTHLY_PRICE_ID },
    'vip-annual': { type: 'subscription', priceId: process.env.STRIPE_VIP_ANNUAL_ID },
    
    // Student Plans
    'student-pro-monthly': { type: 'subscription', priceId: process.env.STRIPE_STUDENT_PRO_MONTHLY_ID },
    'student-pro-annual': { type: 'subscription', priceId: process.env.STRIPE_STUDENT_PRO_ANNUAL_ID },
    'student-vip-monthly': { type: 'subscription', priceId: process.env.STRIPE_STUDENT_VIP_MONTHLY_ID },
    'student-vip-annual': { type: 'subscription', priceId: process.env.STRIPE_STUDENT_VIP_ANNUAL_ID }
};

export const handler = async (event) => {
    const authenticatedUser = event.requestContext.authorizer;
    const { planIdentifier } = JSON.parse(event.body);

    const config = TIER_CONFIG[planIdentifier];
    if (!config) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Invalid plan identifier.' }) };
    }

    try {

        const client = await connectToNeon();

        // --- NEW: Check if user has already had a trial ---
        if (config.type === 'trial') {
            const userResult = await client.query('SELECT had_trial FROM users WHERE firebase_uid = $1', [authenticatedUser.uid]);
            const userHasHadTrial = userResult.rows[0]?.had_trial;

            if (userHasHadTrial) {
                return { 
                    statusCode: 403, // Forbidden
                    body: JSON.stringify({ message: 'You have already used your one-time trial offer.' }) 
                };
            }
        }
        // --- END NEW CHECK ---


        const customer = await stripe.customers.create({
            email: authenticatedUser.email,
            metadata: { firebaseUID: authenticatedUser.uid }
        });

        let sessionConfig;
        console.log(config);

        // Configure session for a paid trial
        if (config.type === 'trial') {
            sessionConfig = {
                mode: 'subscription',
                line_items: [
                    { price: config.recurringPriceId, quantity: 1 },
                    { price: config.trialFeePriceId, quantity: 1 }
                ],
                subscription_data: {
                    trial_period_days: 7,
                    metadata: { firebaseUID: authenticatedUser.uid }
                },
                
            };
        } 
        // Configure session for a direct subscription (no trial)
        else { 
            sessionConfig = {
                mode: 'subscription',
                line_items: [{ price: config.priceId, quantity: 1 }],
                subscription_data: {
                    metadata: { firebaseUID: authenticatedUser.uid }
                }
            };
        }
        
        const session = await stripe.checkout.sessions.create({
            ...sessionConfig,
            customer: customer.id,
            success_url: `http://localhost:3000/payment-success`, // Replace in prod
            cancel_url: `http://localhost:3000/dashboard/upgrade`,     // Replace in prod
        });

        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ sessionId: session.id }),
        };
    } catch (error) {
        console.error("Stripe error:", error);
        return { statusCode: 500, body: JSON.stringify({ message: "Failed to create checkout session." }) };
    }
};