import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { handler as firebaseAuthHandler } from './Lambda/FirebaseAuthorizer.mjs';
import { handler as getUserProfileHandler } from './Lambda/GetUserProfile.mjs';

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));

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

// GET user profile — simulates API Gateway calling your backend
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
      authorizer: authResult.context // <-- The most important part!
    }
  };

  const result = await getUserProfileHandler(lambdaEvent);
  res.status(result.statusCode).set(result.headers).send(result.body);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Express server running at http://localhost:${PORT}`);
});