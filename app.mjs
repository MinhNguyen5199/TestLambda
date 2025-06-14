// Corrected Express Server File

import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

// --- Import ALL your handlers ---
import { handler as firebaseAuthHandler } from './Lambda/FirebaseAuthorizer.mjs';
import { handler as getUserProfileHandler } from './Lambda/GetUserProfile.mjs';
import { handler as createCheckoutSessionHandler } from './Lambda/CreateCheckoutSession.mjs';
import { handler as stripeWebhookHandler } from './Lambda/StripeWebhookHandler.mjs';
import { handler as createPortalSessionHandler } from './Lambda/CreatePortalSession.mjs';
import { handler as upgradeSubscriptionHandler } from './Lambda/UpgradeSubscription.mjs';
import { handler as cancelSubscriptionHandler } from './Lambda/CancelSubscription.mjs'; // Import new handler


dotenv.config();
const app = express();

// CORS for all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));

// --- STEP 1: WEBHOOK ROUTE (needs raw body) ---
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const event = {
    headers: { 'stripe-signature': req.headers['stripe-signature'] },
    body: req.body.toString(),
  };
  try {
    const result = await stripeWebhookHandler(event);
    res.status(result.statusCode).set(result.headers).send(result.body);
  } catch (error) {
    res.status(500).send({ message: "Failed to handle webhook." });
  }
});

// --- STEP 2: GLOBAL JSON PARSER for all other routes ---
app.use(express.json());

// --- STEP 3: ALL OTHER API ROUTES ---

// GET user profile
app.get('/get-user-profile', async (req, res) => {
  const token = req.headers.authorization || '';
  const authEvent = { authorizationToken: token, methodArn: 'local/dev' };
  const authResult = await firebaseAuthHandler(authEvent);
  if (authResult.policyDocument?.Statement[0]?.Effect !== 'Allow') {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const lambdaEvent = { requestContext: { authorizer: authResult.context } };
  const result = await getUserProfileHandler(lambdaEvent);
  res.status(result.statusCode).set(result.headers).send(result.body);
});

// POST to create checkout session
app.post('/create-checkout-session', async (req, res) => {
  const token = req.headers.authorization || '';
  const authEvent = { authorizationToken: token, methodArn: 'local/dev' };
  const authResult = await firebaseAuthHandler(authEvent);
  if (authResult.policyDocument?.Statement[0]?.Effect !== 'Allow') {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const event = {
    requestContext: { authorizer: authResult.context },
    body: JSON.stringify(req.body), // Pass the whole body
  };
  try {
    const result = await createCheckoutSessionHandler(event);
    res.status(result.statusCode).set(result.headers).send(result.body);
  } catch (error) {
    res.status(500).send({ message: "Failed to create checkout session." });
  }
});

// --- NEW: POST to create a customer portal session ---
app.post('/create-portal-session', async (req, res) => {
    const token = req.headers.authorization || '';
    const authEvent = { authorizationToken: token, methodArn: 'local/dev' };
    const authResult = await firebaseAuthHandler(authEvent);
    if (authResult.policyDocument?.Statement[0]?.Effect !== 'Allow') {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    const event = { requestContext: { authorizer: authResult.context } };
    try {
        const result = await createPortalSessionHandler(event);
        res.status(result.statusCode).set(result.headers).send(result.body);
    } catch (error) {
        res.status(500).send({ message: "Failed to create portal session." });
    }
});

// --- NEW: POST to upgrade an existing subscription ---
app.post('/upgrade-subscription', async (req, res) => {
    const token = req.headers.authorization || '';
    const authEvent = { authorizationToken: token, methodArn: 'local/dev' };
    const authResult = await firebaseAuthHandler(authEvent);
    if (authResult.policyDocument?.Statement[0]?.Effect !== 'Allow') {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    const event = {
        requestContext: { authorizer: authResult.context },
        body: JSON.stringify(req.body), // Pass the new price ID in the body
    };
    try {
        const result = await upgradeSubscriptionHandler(event);
        res.status(result.statusCode).set(result.headers).send(result.body);
    } catch (error) {
        res.status(500).send({ message: "Failed to upgrade subscription." });
    }
});

app.post('/cancel-subscription', async (req, res) => {
  const token = req.headers.authorization || '';
  const authEvent = { authorizationToken: token, methodArn: 'local/dev' };
  const authResult = await firebaseAuthHandler(authEvent);
  if (authResult.policyDocument?.Statement[0]?.Effect !== 'Allow') {
      return res.status(401).json({ message: 'Unauthorized' });
  }
  const event = { requestContext: { authorizer: authResult.context } };
  try {
      const result = await cancelSubscriptionHandler(event);
      res.status(result.statusCode).set(result.headers).send(result.body);
  } catch (error) {
      res.status(500).send({ message: "Failed to cancel subscription." });
  }
});


const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Express server running at http://localhost:${PORT}`);
});