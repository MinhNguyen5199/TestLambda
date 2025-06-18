import Stripe from 'stripe';
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// --- (Helper functions are unchanged) ---
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
      console.log("Connected to Neon PostgreSQL for invoice fetching.");
    }
    return neonClient;
}


const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const handler = async (event) => {
    const authenticatedUser = event.requestContext.authorizer;
    if (!authenticatedUser?.uid) {
        return { statusCode: 401, body: JSON.stringify({ message: 'User not authenticated.' }) };
    }

    const { starting_after } = event.body ? JSON.parse(event.body) : {};

    try {
        const client = await connectToNeon();
        
        const res = await client.query(
            `SELECT stripe_customer_id FROM users WHERE firebase_uid = $1`,
            [authenticatedUser.uid]
        );

        const customerId = res.rows[0]?.stripe_customer_id;

        if (!customerId) {
            return {
                statusCode: 200,
                headers: { "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ data: [], has_more: false }),
            };
        }

        // --- FIX: Conditionally build the Stripe API parameters ---
        const listParams = {
            customer: customerId,
            limit: 10,
        };

        // Only add the starting_after parameter if it's a non-empty string
        if (starting_after) {
            listParams.starting_after = starting_after;
        }
        // --- END OF FIX ---

        // Pass the safely constructed parameters object to the API call
        const invoices = await stripe.invoices.list(listParams);

        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify(invoices),
        };

    } catch(error) {
        console.error('Error fetching invoices:', error);
        return { statusCode: 500, body: JSON.stringify({ message: 'Failed to fetch invoices.' }) };
    }
};