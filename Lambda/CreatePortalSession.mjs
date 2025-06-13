import Stripe from 'stripe';
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// --- (Include your getSecret and connectToNeon helper functions here) ---
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

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const handler = async (event) => {
    const authenticatedUser = event.requestContext.authorizer;
    
    if (!authenticatedUser?.uid) {
        return { statusCode: 401, body: JSON.stringify({ message: 'User not authenticated.' }) };
    }
    
    try {
        const client = await connectToNeon();
        
        // Find the user's Stripe Customer ID from your database
        const res = await client.query(
            `SELECT stripe_customer_id FROM users WHERE firebase_uid = $1`, 
            [authenticatedUser.uid]
        );

        const customerId = res.rows[0]?.stripe_customer_id;
        
        if (!customerId) {
            return { statusCode: 404, body: JSON.stringify({ message: 'Stripe customer account not found for this user.' }) };
        }

        // The URL your user will be redirected to after they are done
        const returnUrl = 'http://localhost:3000/dashboard/upgrade'; // Change for production

        // Create a Billing Portal Session
        const portalSession = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
        });

        // Return the secure, one-time-use URL to the frontend
        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ url: portalSession.url }),
        };

    } catch (error) {
        console.error('Error creating Stripe customer portal session:', error);
        return { statusCode: 500, body: JSON.stringify({ message: 'Failed to create customer portal session.' }) };
    }
};