import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsManagerClient = new SecretsManagerClient({});

// This promise will be shared across all invocations in the same process.
let initializationPromise = null;

async function getSecret(secretName) {
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const data = await secretsManagerClient.send(command);
    if ('SecretString' in data) {
        return data.SecretString;
    }
    throw new Error(`SecretString not found for ${secretName}`);
}

/**
 * A robust, idempotent function to initialize Firebase Admin SDK.
 */
function initializeFirebase() {
    // If the promise hasn't been created yet, this is the first call.
    if (!initializationPromise) {
        // Create the promise and assign it immediately. This acts as our lock.
        initializationPromise = new Promise(async (resolve, reject) => {
            try {
                // Check if an app is already initialized (covers all edge cases).
                if (getApps().length > 0) {
                    console.log('Firebase Admin SDK already initialized.');
                    return resolve();
                }

                console.log('Starting Firebase Admin SDK initialization...');
                const serviceAccountJson = await getSecret(process.env.FIREBASE_ADMIN_SDK_SECRET_NAME);
                const serviceAccount = JSON.parse(serviceAccountJson);
                
                initializeApp({
                    credential: cert(serviceAccount)
                });

                console.log('Firebase Admin SDK initialized successfully.');
                resolve();
            } catch (error) {
                console.error('Firebase initialization failed:', error);
                // Reject the promise if initialization fails.
                reject(error);
            }
        });
    }

    // Return the promise. All subsequent calls will get the same promise,
    // ensuring they wait for the first one to finish.
    return initializationPromise;
}

export const handler = async (event) => {
    const idToken = event.authorizationToken;

    if (!idToken || !idToken.startsWith('Bearer ')) {
        return generatePolicy('user', 'Deny', event.methodArn);
    }

    const token = idToken.split(' ')[1];

    try {
        // Wait for the initialization to complete.
        await initializeFirebase();
        
        const decodedToken = await getAuth().verifyIdToken(token);

        if (!decodedToken.email_verified) {
            console.warn(`Access denied for unverified email: ${decodedToken.email}`);
            return generatePolicy(decodedToken.uid, 'Deny', event.methodArn);
        }

        const context = {
            uid: decodedToken.uid,
            email: decodedToken.email || null,
            displayName: decodedToken.name || null,
        };

        return generatePolicy(decodedToken.uid, 'Allow', event.methodArn, context);

    } catch (error) {
        // Check if the error is the specific "already exists" error, and if so, ignore it
        // as another process might have just finished initializing.
        if (error.code === 'app/duplicate-app') {
            console.warn('Firebase app already exists, continuing...');
        } else {
            console.error('Token verification failed:', error.message);
            return generatePolicy('user', 'Deny', event.methodArn);
        }
        
        // If we ignored the duplicate app error, we still need to generate a policy.
        // We can try to decode the token again, as the app now certainly exists.
        try {
            const decodedToken = await getAuth().verifyIdToken(token);
            const context = {
                uid: decodedToken.uid,
                email: decodedToken.email || null,
                displayName: decodedToken.name || null,
            };
            return generatePolicy(decodedToken.uid, 'Allow', event.methodArn, context);
        } catch (finalError) {
             console.error('Final token verification attempt failed:', finalError.message);
             return generatePolicy('user', 'Deny', event.methodArn);
        }
    }
};

const generatePolicy = (principalId, effect, resource, context = {}) => {
    const authResponse = { principalId };
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