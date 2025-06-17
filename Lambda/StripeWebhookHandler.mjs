import Stripe from "stripe";
import { Client } from "pg";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

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
    const neonConnectionString = await getSecret(
      process.env.NEON_CONNECTION_STRING_SECRET_NAME
    );
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
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      event.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const client = await connectToNeon();
  const sub = stripeEvent.data.object;

  try {
    switch (stripeEvent.type) {
      case "checkout.session.completed": {
        const session = await stripe.checkout.sessions.retrieve(sub.id, {
          expand: ["subscription.items.data.price"],
        });
        const subscription = session.subscription;
        if (!subscription) break;

        const tier = subscription.items.data[0].price.lookup_key;
        const userId = subscription.metadata.firebaseUID;
        const customerId = session.customer;
        console.log("this one");
        console.log(session);
        // --- NEW: Determine start and end dates based on subscription status ---
        let startDate;
        let expiresAt;

        if (subscription.status === "trialing") {
          // If it's a trial, use the specific trial start and end dates
          startDate = subscription.trial_start;
          expiresAt = subscription.trial_end;
            await client.query(
            `UPDATE users SET had_trial = TRUE WHERE firebase_uid = $1`,
            [userId]
          )
        } else {
          // Otherwise, use the regular period start and end dates
          startDate = subscription.current_period_start;
          expiresAt = subscription.current_period_end;
        }
        // --- END OF NEW LOGIC ---

        await client.query("BEGIN");
        console.log('123')
        console.log(sub)
        // if(sub.status === "trialing") {
        //   // If the subscription is in trial, we don't update the tier or status
        //   console.log(`Subscription ${sub.id} is in trial. No tier update.`);
        //   await client.query(
        //     `UPDATE users SET had_trial = TRUE WHERE firebase_uid = $1`,
        //     [sub.metadata.firebaseUID]
        //   )
        // }

        // This query can remain the same
        await client.query(
          `UPDATE users SET current_tier = $1, stripe_customer_id = $2, updatedtier_at = EXTRACT(epoch FROM NOW()) WHERE firebase_uid = $3`,
          [tier, customerId, userId]
        );

        // MODIFIED: This query now uses the correct date variables
        await client.query(
          `INSERT INTO subscriptions (user_id, tier_id, status, start_date, expires_at, stripe_subscription_id, subscription_interval, cancel_at_period_end, current_period_end) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            userId,
            tier,
            subscription.status,
            startDate, // Use the determined start date
            expiresAt, // Use the determined expiry date
            subscription.id,
            subscription.items.data[0].plan.interval,
            subscription.cancel_at_period_end,
            subscription.current_period_end, // Still good to store the actual period end
          ]
        );

        await client.query("COMMIT");


        
        break;
      }

      case "invoice.paid": {
        console.log(`invoice`)
        console.log(sub);
        if (sub.subscription) {
          const subscription = await stripe.subscriptions.retrieve(
            sub.subscription
          );
          await client.query(
            `UPDATE subscriptions SET status = $1, current_period_end = $2 WHERE stripe_subscription_id = $3`,
            [
              subscription.status,
              subscription.current_period_end,
              subscription.id,
            ]
          );
        }
        break;
      }

      // --- THIS IS THE KEY FIX ---
      case "customer.subscription.updated": {
        console.log(`Webhook received: Subscription ${sub.id} was updated.`);
        const newTier = sub.items.data[0].price.lookup_key;
        console.log(sub);
        console.log("canceled")
        // This logic now handles all updates: cancellations, reactivations, upgrades, etc.
        await client.query("BEGIN");

        // Update the subscriptions table with the latest state from Stripe
        await client.query(
          `UPDATE subscriptions
                     SET 
                       tier_id = $1,
                       status = $2,
                       cancel_at_period_end = $3,
                       canceled_at = $4,
                       start_date = $5,
                       expires_at = $6,
                       created_at = $7
                     WHERE stripe_subscription_id = $8`,
          [
            newTier,
            sub.status,
            sub.cancel_at_period_end, // This will be TRUE after cancellation
            sub.canceled_at,
            sub.current_period_start,
            sub.current_period_end,
            sub.created,
            sub.id,
          ]
        );

        // Only update the user's primary tier if the subscription is active.
        // If they've canceled, their tier remains active until the subscription is deleted.
        if (!sub.cancel_at_period_end) {
          await client.query(
            `UPDATE users SET current_tier = $1 WHERE stripe_customer_id = $2`,
            [newTier, sub.customer]
          );
        }

        await client.query("COMMIT");

        
        

        console.log(
          `Database updated for subscription ${sub.id}. cancel_at_period_end is now: ${sub.cancel_at_period_end}.`
        );
        break;
      }

      case "customer.subscription.deleted": {
        // This handles the final deletion at the end of the billing period
        await client.query("BEGIN");
        await client.query(
          `UPDATE users SET current_tier = 'basic' WHERE stripe_customer_id = $1`,
          [sub.customer]
        );
        await client.query(
          `UPDATE subscriptions SET status = 'canceled' WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        await client.query("COMMIT");
        break;
      }
    }
  } catch (error) {
    console.error(`Error processing '${stripeEvent.type}':`, error);
    await client.query("ROLLBACK");
    return {
      statusCode: 500,
      body: "Internal server error while processing webhook.",
    };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
