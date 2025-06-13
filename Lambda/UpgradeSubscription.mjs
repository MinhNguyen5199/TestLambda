// Lambda/UpgradeSubscription.mjs
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
    const { newPriceId } = JSON.parse(event.body); // Frontend sends the ID of the new plan

    if (!authenticatedUser?.uid) {
        return { statusCode: 401, body: JSON.stringify({ message: 'User not authenticated.' }) };
    }
     if (!newPriceId) {
        return { statusCode: 400, body: JSON.stringify({ message: 'newPriceId is required.' }) };
    }

    try {
        const client = await connectToNeon();
        // Get the user's current ACTIVE subscription ID
        const res = await client.query(
            `SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
            [authenticatedUser.uid]
        );

        const subscriptionId = res.rows[0]?.stripe_subscription_id;

        if (!subscriptionId) {
            return { statusCode: 404, body: JSON.stringify({ message: 'No active subscription found to upgrade.' }) };
        }

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        // Update the subscription
        await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: false,
            items: [{
                id: subscription.items.data[0].id, // The ID of the current subscription item
                price: newPriceId, // The ID of the new price (e.g., VIP Annual)
            }],
            proration_behavior: 'create_prorations', // This calculates the cost difference
        });

        // The 'customer.subscription.updated' webhook will handle updating the database
        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ message: 'Subscription upgrade initiated successfully.' }),
        };

    } catch (error) {
        console.error('Error upgrading subscription:', error);
        return { statusCode: 500, body: JSON.stringify({ message: 'Failed to upgrade subscription.' }) };
    }
};