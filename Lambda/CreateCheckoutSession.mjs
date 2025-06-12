// CreateCheckoutSession/index.js
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY); // Gets key from Lambda environment variables

export const handler = async (event) => {
    const authenticatedUser = event.requestContext.authorizer;
    const { priceId } = JSON.parse(event.body);

    try {
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            client_reference_id: authenticatedUser.uid, // Links payment to your user
            success_url: `http://localhost:3000/payment-success`,
            cancel_url: `http://localhost:3000/cancel`,
        });

        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ sessionId: session.id }),
        };
    } catch (error) {
        console.error("Stripe error:", error);
        return { statusCode: 500, body: JSON.stringify({ message: "Failed to create checkout session." }) };
    }
};