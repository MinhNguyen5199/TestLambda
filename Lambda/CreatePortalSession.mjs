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

const studentProducts = [
    {
        product: process.env.STRIPE_STUDENT_PRO_PRODUCTID, // <-- From Stripe Dashboard
        prices: [
            process.env.STRIPE_STUDENT_PRO_MONTHLY_ID, 
            process.env.STRIPE_STUDENT_PRO_ANNUAL_ID
        ]
    },
    {
        product: process.env.STRIPE_STUDENT_VIP_PRODUCTID, // <-- From Stripe Dashboard
        prices: [
            process.env.STRIPE_STUDENT_VIP_MONTHLY_ID, 
            process.env.STRIPE_STUDENT_VIP_ANNUAL_ID
        ]
    }
];

const regularProducts = [
    {
        product: process.env.STRIPE_PRO_PRODUCTID, // <-- From Stripe Dashboard
        prices: [
            process.env.STRIPE_PRO_MONTHLY_PRICE_ID, 
            process.env.STRIPE_PRO_ANNUAL_ID
        ]
    },
    {
        product: process.env.STRIPE_VIP_PRODUCTID, // <-- From Stripe Dashboard
        prices: [
            process.env.STRIPE_VIP_MONTHLY_PRICE_ID, 
            process.env.STRIPE_VIP_ANNUAL_ID
        ]
    }
];


export const handler = async (event) => {
    const authenticatedUser = event.requestContext.authorizer;
    
    if (!authenticatedUser?.uid) {
        return { statusCode: 401, body: JSON.stringify({ message: 'User not authenticated.' }) };
    }
    
    try {
        const client = await connectToNeon();
        
        // --- MODIFIED: Fetch user status and active subscription ID ---
        const res = await client.query(
            `SELECT u.is_student, u.stripe_customer_id, s.stripe_subscription_id 
             FROM users u
             JOIN subscriptions s ON u.firebase_uid = s.user_id
             WHERE u.firebase_uid = $1 AND s.status IN ('active', 'trialing')
             ORDER BY s.created_at DESC
             LIMIT 1`,
            [authenticatedUser.uid]
        );

        const userData = res.rows[0];
        const customerId = userData?.stripe_customer_id;
        const subscriptionId = userData?.stripe_subscription_id;
        console.log(`portal`)
        console.log(res);
        
        if (!customerId || !subscriptionId) {
            return { statusCode: 404, body: JSON.stringify({ message: 'Stripe customer or active subscription not found for this user.' }) };
        }

        // --- ADDED: Determine which products to show ---
        const allowedUpdates = userData.is_student ? studentProducts : regularProducts;

        // The URL your user will be redirected to after they are done
        const returnUrl = 'http://localhost:3000/dashboard/upgrade'; // Change for production

        //configuration for portal
        const config = await stripe.billingPortal.configurations.create({
            business_profile: {
                headline: 'Manage your subscription',
                privacy_policy_url: 'https://yourapp.com/privacy',
                terms_of_service_url: 'https://yourapp.com/terms',
            },
            features: {
                invoice_history: {
                    enabled: true,
                },
                payment_method_update: {
                    enabled: true,
                },
                subscription_update: {
                    enabled: true,
                    default_allowed_updates: ['price'],
                    products: allowedUpdates,
                    proration_behavior: "none"
                },
            },
        });

        // --- MODIFIED: Create a configured Billing Portal Session ---
        const portalSession = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
            configuration: config.id,
            flow_data: {
                type: 'subscription_update',
                subscription_update: {
                    subscription: subscriptionId,
                },
                after_completion: {
                    type: 'redirect',
                    redirect: {
                        return_url: returnUrl,
                    },
                }
            }
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