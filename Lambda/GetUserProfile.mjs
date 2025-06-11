// // GetUserProfile/index.js
// // --- CHANGE: Use ES Module imports ---
// import { Client } from "pg";
// import {
//   SecretsManagerClient,
//   GetSecretValueCommand,
// } from "@aws-sdk/client-secrets-manager";

// const secretsManagerClient = new SecretsManagerClient({});
// let neonClient;
// async function getSecret(secretName) {
//   const command = new GetSecretValueCommand({ SecretId: secretName });
//   const data = await secretsManagerClient.send(command);
//   if ("SecretString" in data) {
//     return data.SecretString;
//   }
//   throw new Error(`SecretString not found for ${secretName}`);
// }

// // --- CHANGE: Export the handler using ES Module syntax ---
// export const handler = async (event) => {
//   console.log("Backend Lambda event:", JSON.stringify(event, null, 2));

//   const authenticatedUser = event.requestContext.authorizer;

//   const corsHeaders = {
//     "Access-Control-Allow-Origin": "*", // IMPORTANT: Set your Next.js frontend origin
//     "Access-Control-Allow-Methods": "GET,OPTIONS",
//     "Access-Control-Allow-Headers": "Content-Type,Authorization",
//     "Content-Type": "application/json",
//   };

//   if (!authenticatedUser || !authenticatedUser.uid) {
//     console.error("User not authenticated or UID missing in context");
//     return {
//       statusCode: 401,
//       headers: corsHeaders,
//       body: JSON.stringify({ message: "Unauthorized" }),
//     };
//   }

//   try {
//     if (!neonClient) {
//       const neonConnectionString = await getSecret(
//         process.env.NEON_CONNECTION_STRING_SECRET_NAME
//       );
//       neonClient = new Client({
//         connectionString: neonConnectionString,
//         ssl: { rejectUnauthorized: false },
//       });
//       await neonClient.connect();
//       console.log("Connected to Neon PostgreSQL.");
//     }

//     let profileData;
//     const checkUserQuery = `
//   SELECT firebase_uid, email, username, current_tier,
//          created_at, updatedtier_at, lastlogin_at
//   FROM users
//   WHERE firebase_uid = $1
// `;
//     const userExistsRes = await neonClient.query(checkUserQuery, [
//       authenticatedUser.uid,
//     ]);

//     if (userExistsRes.rows.length === 0) {
//       console.log(
//         `User ${authenticatedUser.uid} not found in DB. Registering new user.`
//       );
//       const insertUserQuery = `
//   INSERT INTO users (firebase_uid, email, username)
//   VALUES ($1, $2, $3)
//   RETURNING firebase_uid, email, username, current_tier, created_at
// `;
// const insertRes = await neonClient.query(insertUserQuery, [
//     authenticatedUser.uid,
//     authenticatedUser.email,
//     authenticatedUser.displayName
//   ]);
//       profileData = insertRes.rows[0];
//     } else {
//       profileData = userExistsRes.rows[0];
//     }

//     console.log("User profile (from DB):", profileData);
//     return {
//       statusCode: 200,
//       headers: corsHeaders,
//       body: JSON.stringify({
//         message: "User profile fetched/registered successfully.",
//         data: profileData,
//         authenticatedUserContext: authenticatedUser,
//       }),
//     };
//   } catch (error) {
//     console.error("Database operation failed:", error);
//     return {
//       statusCode: 500,
//       headers: corsHeaders,
//       body: JSON.stringify({
//         message: "Internal Server Error",
//         error: error.message,
//       }),
//     };
//   }
// };


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
    console.log("Connected to Neon PostgreSQL.");
  }
  return neonClient;
}

export const handler = async (event) => {
  console.log("Backend Lambda event:", JSON.stringify(event, null, 2));

  const authenticatedUser = event.requestContext.authorizer;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "application/json",
  };

  if (!authenticatedUser || !authenticatedUser.uid) {
    console.error("User not authenticated or UID missing in context");
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ message: "Unauthorized" }),
    };
  }

  try {
    const client = await connectToNeon();

    // Check if user exists
    const checkUserQuery = `
      SELECT firebase_uid, email, username, current_tier,
             created_at, updatedtier_at, lastlogin_at
      FROM users
      WHERE firebase_uid = $1
    `;

    const userRes = await client.query(checkUserQuery, [authenticatedUser.uid]);

    let profileData;

    if (userRes.rows.length === 0) {
      console.log(`User ${authenticatedUser.uid} not found. Registering new user.`);

      // Insert user and set created_at, updatedtier_at, lastlogin_at to current epoch seconds
      const insertUserQuery = `
        INSERT INTO users (firebase_uid, email, username, lastlogin_at)
        VALUES ($1, $2, $3, EXTRACT(epoch FROM now()))
        RETURNING firebase_uid, email, username, current_tier, created_at, updatedtier_at, lastlogin_at
      `;

      const insertRes = await client.query(insertUserQuery, [
        authenticatedUser.uid,
        authenticatedUser.email,
        authenticatedUser.displayName || null,
      ]);

      profileData = insertRes.rows[0];
    } else {
      profileData = userRes.rows[0];

      // Update lastlogin_at to current epoch seconds on existing user
      const updateLoginTimeQuery = `
        UPDATE users SET lastlogin_at = EXTRACT(epoch FROM now())
        WHERE firebase_uid = $1
      `;
      await client.query(updateLoginTimeQuery, [authenticatedUser.uid]);
    }

    console.log("User profile (from DB):", profileData);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "User profile fetched/registered successfully.",
        data: profileData,
        authenticatedUserContext: authenticatedUser,
      }),
    };
  } catch (error) {
    console.error("Database operation failed:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "Internal Server Error",
        error: error.message,
      }),
    };
  }
};
