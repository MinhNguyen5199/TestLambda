// StripeWebhookHandler/index.js
import Stripe from 'stripe';
import { Client } from 'pg'; // Your PostgreSQL client
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// --- Helper Functions (No changes needed here) ---
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
    if (!neonClient || neonClient.ended) { // Check if client exists or has been ended
      const neonConnectionString = await getSecret(process.env.NEON_CONNECTION_STRING_SECRET_NAME);
      neonClient = new Client({
        connectionString: neonConnectionString,
        ssl: { rejectUnauthorized: false },
      });
      await neonClient.connect();
      console.log("Connected to Neon PostgreSQL.");
    }
    return neonClient;
}

function determineTierFromSession(session) {
    const priceId = session.line_items?.data[0]?.price.id;
    console.log(`Determining tier for Price ID: ${priceId}`);

    const proPriceIds = [
        'price_1RYvKSHEs83qji0bAOsQovd7', 'price_1RYvM6HEs83qji0b3Mg8sr36',
        'price_1RYvQwHEs83qji0bHz92py3y', 'price_1RYvS0HEs83qji0bXtlT8ZnM'
    ];
    const vipPriceIds = [
        'price_1RYvMyHEs83qji0bMeaQol9F', 'price_1RYvNpHEs83qji0bJxpPMHRC',
        'price_1RYvSvHEs83qji0bP8bsobz9', 'price_1RYvTWHEs83qji0bZ4zEyWif'
    ];

    if (proPriceIds.includes(priceId)) return 'pro';
    if (vipPriceIds.includes(priceId)) return 'vip';
    return null;
}
// ---------------------------------------------------

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const handler = async (event) => {
    const signature = event.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let stripeEvent;
    try {
        stripeEvent = stripe.webhooks.constructEvent(event.body, signature, endpointSecret);
    } catch (err) {
        console.warn(`Webhook signature verification failed: ${err.message}`);
        return { statusCode: 400 };
    }

    const client = await connectToNeon();
    // --- Main Logic Block ---
    try {
        if (stripeEvent.type === 'checkout.session.completed') {
            // **FIX #1: Retrieve the full session object to get line_items**
            const sessionWithLineItems = await stripe.checkout.sessions.retrieve(
                stripeEvent.data.object.id, { expand: ['line_items'] }
            );

            const userId = sessionWithLineItems.client_reference_id;
            const stripeSubscriptionId = sessionWithLineItems.subscription;
            const tierId = determineTierFromSession(sessionWithLineItems);

            if (!tierId) {
                console.error(`Configuration Error: Could not determine tier for session ${sessionWithLineItems.id}`);
                return { statusCode: 200, body: 'Configuration error, tier not found.' }; // Return 200 so Stripe doesn't retry
            }

            const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
            console.log(sub)

            await client.query('BEGIN');
            // **FIX #2: Corrected the 'updatedtier_at' column name to 'updatedtier_at' and used NOW()**
            await client.query(
                `UPDATE users SET current_tier = $1, updatedtier_at = EXTRACT(epoch FROM NOW()) WHERE firebase_uid = $2`,
                [tierId, userId]
            );
            await client.query(
                `INSERT INTO subscriptions (user_id, tier_id, status, start_date, expires_at, stripe_subscription_id, canceled_at, ended_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                 [userId, tierId, sub.status, sub.items.data[0].current_period_start, sub.items.data[0].current_period_end, stripeSubscriptionId, sub.canceled_at, sub.ended_at]
            );

            await client.query('COMMIT');
            console.log(`✅ checkout.session.completed: Successfully granted '${tierId}' to user ${userId}`);

        } else if (stripeEvent.type === 'customer.subscription.deleted') {
            const subscription = stripeEvent.data.object;
            const stripeSubId = subscription.id;

            await client.query('BEGIN');
            await client.query(
                `UPDATE users SET current_tier = 'basic', updatedtier_at = EXTRACT(epoch FROM NOW()) WHERE firebase_uid = (SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1)`,
                [stripeSubId]
            );
            await client.query(
                `UPDATE subscriptions SET status = 'canceled', expires_at = to_timestamp($1) WHERE stripe_subscription_id = $2`,
                [subscription.canceled_at, stripeSubId]
            );
            await client.query('COMMIT');
            console.log(`✅ customer.subscription.deleted: Successfully downgraded user for subscription ${stripeSubId}`);

        } else {
            console.log(`Ignoring event type: ${stripeEvent.type}`);
        }
    } catch (error) {
        // This will catch errors from the main logic block, but not from DB connection or signature verification
        console.error('Error processing webhook event:', error);
        // We don't rollback here because the individual blocks handle their own transactions
        return { statusCode: 500 }; // Return error to have Stripe retry
    }

    // **FIX #3: Removed the `finally` block to allow for connection reuse.**

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
};