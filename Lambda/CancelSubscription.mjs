import Stripe from 'stripe';
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// --- (Helper Functions are unchanged) ---
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

export const handler = async (event) => {
    const authenticatedUser = event.requestContext.authorizer;

    if (!authenticatedUser?.uid) {
        return { statusCode: 401, body: JSON.stringify({ message: 'User not authenticated.' }) };
    }

    try {
        const client = await connectToNeon();

        // --- THIS IS THE FIX: Allow cancellation for 'active' OR 'trialing' subscriptions ---
        const res = await client.query(
            `SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1`,
            [authenticatedUser.uid]
        );

        const subscriptionId = res.rows[0]?.stripe_subscription_id;

        if (!subscriptionId) {
            return { statusCode: 404, body: JSON.stringify({ message: 'No active or trialing subscription found to cancel.' }) };
        }

        const updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true,
        });
        
        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ 
                message: 'Subscription cancellation scheduled successfully.',
                cancel_at: updatedSubscription.cancel_at 
            }),
        };
    } catch (error) {
        console.error('Error canceling subscription:', error);
        return { statusCode: 500, body: JSON.stringify({ message: 'Failed to cancel subscription.' }) };
    }
};