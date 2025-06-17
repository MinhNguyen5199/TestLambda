import { Client } from "pg";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

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
  if (!neonClient) {
    const neonConnectionString = await getSecret(process.env.NEON_CONNECTION_STRING_SECRET_NAME);
    neonClient = new Client({
      connectionString: neonConnectionString,
      ssl: { rejectUnauthorized: false },
    });
    await neonClient.connect();
    // console.log("Connected to Neon PostgreSQL.");
  }
  return neonClient;
}

export const handler = async (event) => {
//   console.log("Backend Lambda event:", JSON.stringify(event, null, 2));

  const authenticatedUser = event.requestContext.authorizer;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "application/json",
  };

  if (!authenticatedUser?.uid) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ message: "Unauthorized" }) };
  }

  try {
    const client = await connectToNeon();
    const checkUserQuery = `
        SELECT
            u.created_at, u.current_tier, u.email, u.firebase_uid, u.is_student, u.lastlogin_at,
            u.stripe_customer_id, u.updatedtier_at, u.username, u.had_trial, s.status as subscription_status,
            s.cancel_at_period_end, s.expires_at as subscription_expires_at
        FROM users u
        LEFT JOIN subscriptions s ON u.firebase_uid = s.user_id AND s.status = 'active' OR s.status = 'trialing'
        WHERE u.firebase_uid = $1
        ORDER BY u.created_at DESC
        LIMIT 1
    `;
    const userRes = await client.query(checkUserQuery, [authenticatedUser.uid]);

    let profileData;

    if (userRes.rows.length === 0) {
      // --- NEW LOGIC: DETECT STUDENT STATUS ---
      const isStudent = authenticatedUser.email && authenticatedUser.email.split('@')[1].toLowerCase().includes('edu'); // Example check for student email domain
      console.log(`New user ${authenticatedUser.uid}. Student status: ${isStudent}`);
      
      const insertUserQuery = `
        INSERT INTO users (firebase_uid, email, username, is_student, lastlogin_at)
        VALUES ($1, $2, $3, $4, EXTRACT(epoch FROM now()))
        RETURNING *
      `;
      const insertRes = await client.query(insertUserQuery, [
        authenticatedUser.uid,
        authenticatedUser.email,
        authenticatedUser.displayName || null,
        isStudent, // Set the student flag here
      ]);
      profileData = insertRes.rows[0];
    } else {
      // Existing user, just update their login time
      profileData = userRes.rows[0];
      const updateLoginTimeQuery = `UPDATE users SET lastlogin_at = EXTRACT(epoch FROM now()) WHERE firebase_uid = $1`;
      await client.query(updateLoginTimeQuery, [authenticatedUser.uid]);
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ data: profileData }),
    };
  } catch (error) {
    console.error("Database operation failed:", error);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ message: "Internal Server Error" }) };
  }
};
