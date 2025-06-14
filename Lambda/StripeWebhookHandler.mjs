import Stripe from 'stripe';
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// --- (Your helper functions remain the same) ---
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
// ---------------------------------------------

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const handler = async (event) => {
    let stripeEvent;
    try {
        stripeEvent = stripe.webhooks.constructEvent(event.body, event.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    const client = await connectToNeon();
    
    try {
        switch (stripeEvent.type) {
            
            case 'checkout.session.completed': {
                const session = await stripe.checkout.sessions.retrieve(stripeEvent.data.object.id, { expand: ['subscription.items.data.price'] });
                const sub = session.subscription;
                if (!sub) break;

                const tier = sub.items.data[0].price.lookup_key;

                // const userId = session.client_reference_id;
                // const customerId = session.customer;

                const userId = sub.metadata.firebaseUID;
                const customerId = session.customer;
                await client.query('BEGIN');
                await client.query(`UPDATE users SET current_tier = $1, stripe_customer_id = $2, updatedtier_at = EXTRACT(epoch FROM NOW()) WHERE firebase_uid = $3`, [tier, customerId, userId]);
                
                // --- FIX: Removed to_timestamp() ---
                await client.query(
                    `INSERT INTO subscriptions (user_id, tier_id, status, start_date, expires_at, stripe_subscription_id, subscription_interval) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [userId, tier, sub.status, sub.items.data[0].current_period_start, sub.trial_end || sub.items.data[0].current_period_end, sub.id, sub.items.data[0].plan.interval]
                );
                await client.query('COMMIT');
                break;
            }

            case 'invoice.paid': {
                const invoice = stripeEvent.data.object;
                if (invoice.subscription) {
                    const sub = await stripe.subscriptions.retrieve(invoice.subscription);
                    
                    // --- FIX: Removed to_timestamp() ---
                    await client.query(`UPDATE subscriptions SET status = $1, expires_at = $2 WHERE stripe_subscription_id = $3`, [sub.status, sub.items.data[0].current_period_end, sub.id]);
                    
                    console.log(`✅ invoice.paid: Subscription ${sub.id} renewed. New expiry: ${sub.items.data[0].current_period_end}`);
                }
                break;
            }

            case 'customer.subscription.updated': {
                const sub = stripeEvent.data.object;
                const newTier = sub.items.data[0].price.lookup_key;
                await client.query('BEGIN');
                await client.query(`UPDATE users SET current_tier = $1, updatedtier_at = EXTRACT(epoch FROM NOW()) WHERE stripe_customer_id = $2`, [newTier, sub.customer]);

                // --- FIX: Removed to_timestamp() ---
                await client.query(`UPDATE subscriptions SET tier_id = $1, status = $2, expires_at = $3, subscription_interval = $4 WHERE stripe_subscription_id = $5`, [newTier, sub.status, sub.items.data[0].current_period_end, sub.items.data[0].plan.interval, sub.id]);
                
                await client.query('COMMIT');
                break;
            }

            case 'customer.subscription.deleted': {
                const sub = stripeEvent.data.object;
                console.log("deleted sub")
                console.log(sub)
                await client.query('BEGIN');
                await client.query(`UPDATE users SET current_tier = 'basic', updatedtier_at = EXTRACT(epoch FROM NOW()) WHERE stripe_customer_id = $1`, [sub.customer]);
                await client.query(`UPDATE subscriptions SET status = 'canceled', ended_at = $1 WHERE stripe_subscription_id = $2`, [sub.canceled_at, sub.id]);
                await client.query('COMMIT');
                break;

            }
        }
    } catch (error) {
        console.error(`Error processing '${stripeEvent.type}':`, error);
        await client.query('ROLLBACK');
        return { statusCode: 500, body: 'Internal server error while processing webhook.' };
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
};