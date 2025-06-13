// FirebaseAuthorizer/index.js
// --- CHANGE: Use ES Module imports ---
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsManagerClient = new SecretsManagerClient({});
let firebaseAdminApp;
let firebaseAuth;

async function getSecret(secretName) {
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const data = await secretsManagerClient.send(command);
    if ('SecretString' in data) {
        return data.SecretString;
    }
    throw new Error(`SecretString not found for ${secretName}`);
}

// --- CHANGE: Export the handler using ES Module syntax ---
export const handler = async (event) => {
    // console.log('Authorizer event:', JSON.stringify(event, null, 2));

    const idToken = event.authorizationToken;

    if (!idToken || !idToken.startsWith('Bearer ')) {
        console.warn('Missing or invalid Authorization header');
        return generatePolicy('user', 'Deny', event.methodArn);
    }

    const token = idToken.split(' ')[1];

    try {
        if (!firebaseAdminApp) {
            const serviceAccountJson = await getSecret(process.env.FIREBASE_ADMIN_SDK_SECRET_NAME);
            const serviceAccount = JSON.parse(serviceAccountJson);
            firebaseAdminApp = initializeApp({
                credential: cert(serviceAccount)
            });
            firebaseAuth = getAuth(firebaseAdminApp);
            // console.log('Firebase Admin SDK initialized.');
        }

        const decodedToken = await firebaseAuth.verifyIdToken(token);
        // console.log('Firebase ID Token verified. Decoded:', decodedToken);

        // --- NEW: Enforce Email Verification ---
        // This is the crucial check. The decoded token from Firebase includes an 'email_verified' boolean.
        if (!decodedToken.email_verified) {
            console.warn(`Access denied for unverified email: ${decodedToken.email}`);
            // Return a "Deny" policy, which will cause the API Gateway to return a 403 Forbidden error.
            return generatePolicy(decodedToken.uid, 'Deny', event.methodArn);
        }
        // --- END NEW ---

        const userId = decodedToken.uid;
        const email = decodedToken.email || null;
        const displayName = decodedToken.name || null;

        return generatePolicy(userId, 'Allow', event.methodArn, {
            uid: userId,
            email: email,
            displayName: displayName,
        });

    } catch (error) {
        console.error('Token verification failed:', error.message);
        return generatePolicy('user', 'Deny', event.methodArn);
    }
};

const generatePolicy = (principalId, effect, resource, context = {}) => {
    const authResponse = { principalId: principalId };
    if (effect && resource) {
        const policyDocument = {
            Version: '2012-10-17',
            Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }]
        };
        authResponse.policyDocument = policyDocument;
    }
    authResponse.context = context;
    return authResponse;
};