import Stripe from 'stripe';
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// --- Helper Functions ---
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
// ----------------------

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const handler = async (event) => {
    const authenticatedUser = event.requestContext.authorizer;
    const { newPriceId } = JSON.parse(event.body);

    if (!authenticatedUser?.uid) {
        return { statusCode: 401, body: JSON.stringify({ message: 'User not authenticated.' }) };
    }
     if (!newPriceId) {
        return { statusCode: 400, body: JSON.stringify({ message: 'newPriceId is required.' }) };
    }

    try {
        const client = await connectToNeon();
        const res = await client.query(
            `SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
            [authenticatedUser.uid]
        );

        const subscriptionId = res.rows[0]?.stripe_subscription_id;

        if (!subscriptionId) {
            return { statusCode: 404, body: JSON.stringify({ message: 'No active subscription found to modify.' }) };
        }

        const currentSubscription = await stripe.subscriptions.retrieve(subscriptionId);
        const currentPrice = currentSubscription.items.data[0].price;

        const newPrice = await stripe.prices.retrieve(newPriceId);

        // Determine if it's an upgrade or downgrade

        await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: false,
            items: [{
                id: currentSubscription.items.data[0].id,
                price: newPriceId,
            }],
            proration_behavior: 'always_invoice', // Prorate for upgrades, don't for downgrades
        });

        const message = isUpgrade ? 'Subscription upgrade initiated successfully.' : 'Subscription downgrade scheduled for the end of the billing period.';

        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ message: message }),
        };

    } catch (error) {
        console.error('Error modifying subscription:', error);
        return { statusCode: 500, body: JSON.stringify({ message: 'Failed to modify subscription.' }) };
    }
};