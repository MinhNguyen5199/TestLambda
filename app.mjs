// Corrected Express Server File

import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { handler as firebaseAuthHandler } from './Lambda/FirebaseAuthorizer.mjs';
import { handler as getUserProfileHandler } from './Lambda/GetUserProfile.mjs';
import { handler as createCheckoutSessionHandler } from './Lambda/CreateCheckoutSession.mjs';
import { handler as stripeWebhookHandler } from './Lambda/StripeWebhookHandler.mjs';

dotenv.config();
const app = express();

// Use CORS for all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));

// -------------------------------------------------------------------
// ** STEP 1: DEFINE THE WEBHOOK ROUTE FIRST **
// This route needs the raw body, so it comes BEFORE express.json().
// -------------------------------------------------------------------
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const event = {
    headers: {
      'stripe-signature': req.headers['stripe-signature'],
    },
    body: req.body.toString(),
  };

  try {
    const result = await stripeWebhookHandler(event);
    res.status(result.statusCode).set(result.headers).send(result.body);
  } catch (error) {
    console.error("Error handling webhook:", error);
    res.status(500).send({ message: "Failed to handle webhook." });
  }
});

// -------------------------------------------------------------------
// ** STEP 2: USE THE GLOBAL JSON PARSER **
// Now that the raw webhook route is defined, we can use the JSON
// parser for all OTHER routes that come after it.
// -------------------------------------------------------------------
app.use(express.json());

// -------------------------------------------------------------------
// ** STEP 3: DEFINE ALL OTHER ROUTES **
// These routes will now correctly have their bodies parsed as JSON.
// -------------------------------------------------------------------

// POST to simulate authorizer manually (optional test route)
app.post('/auth', async (req, res) => {
  const token = req.headers.authorization || '';
  const event = {
    authorizationToken: token,
    methodArn: 'local/dev'
  };
  const result = await firebaseAuthHandler(event);
  res.json(result);
});

// GET user profile
app.get('/get-user-profile', async (req, res) => {
  const token = req.headers.authorization || '';
  const authEvent = {
    authorizationToken: token,
    methodArn: 'local/dev'
  };
  const authResult = await firebaseAuthHandler(authEvent);
  if (authResult.policyDocument?.Statement[0]?.Effect !== 'Allow') {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const lambdaEvent = {
    requestContext: {
      authorizer: authResult.context
    }
  };
  const result = await getUserProfileHandler(lambdaEvent);
  res.status(result.statusCode).set(result.headers).send(result.body);
});

// POST to create checkout session
app.post('/create-checkout-session', async (req, res) => {
  const token = req.headers.authorization || '';
  const authEvent = {
    authorizationToken: token,
    methodArn: 'local/dev'
  };
  const authResult = await firebaseAuthHandler(authEvent);
  if (authResult.policyDocument?.Statement[0]?.Effect !== 'Allow') {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const event = {
    requestContext: {
      authorizer: authResult.context
    },
    body: JSON.stringify({
      priceId: req.body.priceId
    }),
  };
  try {
    const result = await createCheckoutSessionHandler(event);
    res.status(result.statusCode).set(result.headers).send(result.body);
  } catch (error) {
    console.error("Error creating checkout session:", error);
    res.status(500).send({ message: "Failed to create checkout session." });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Express server running at http://localhost:${PORT}`);
});