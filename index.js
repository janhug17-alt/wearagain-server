/**
 * server/index.js
 * Node/Express server for Stripe Checkout + Connect and webhook handling.
 * Includes /refund-deposit endpoint (secured by REFUND_SECRET header) for admins/hosts to request refunds.
 *
 * USAGE:
 *  - Install dependencies: npm install
 *  - Create a .env file with the variables from .env.example
 *  - Run: node index.js
 *
 * Endpoints:
 *  - POST /create-checkout-session
 *  - POST /create-account-link
 *  - POST /webhook
 *  - POST /refund-deposit
 *
 * SECURITY:
 * - REFUND_SECRET is a secret string set in .env. The refund endpoint requires header 'x-refund-secret' with that value.
 * - In production you should implement proper authentication & authorization (only allow hosts/admins to trigger refunds).
 */

const express = require('express');
const Stripe = require('stripe');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
app.use(cors({ origin: true }));
app.use(bodyParser.json());

// Helpers
function toCents(euro) {
  return Math.round(parseFloat(euro) * 100);
}

/**
 * Create a Checkout Session
 * Expects body:
 * { itemId, nights, hostConnectId, totalAmountCents, depositCents }
 */
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { itemId, nights, hostConnectId, totalAmountCents, depositCents } = req.body;
    if(!itemId || !nights || !hostConnectId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const total = Number(totalAmountCents) || 100;
    const deposit = Number(depositCents) || 0;
    const applicationFee = Math.round(total * (process.env.MARKETPLACE_FEE_PERCENT || 0) / 100);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: { name: `Lloguer: ${itemId}` },
            unit_amount: total
          },
          quantity: 1
        },
        {
          price_data: {
            currency: 'eur',
            product_data: { name: `Dipòsit reemborsable: ${itemId}` },
            unit_amount: deposit
          },
          quantity: 1
        }
      ],
      payment_intent_data: {
        application_fee_amount: applicationFee > 0 ? applicationFee : undefined,
        transfer_data: {
          destination: hostConnectId
        }
      },
      success_url: `${CLIENT_URL}/?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/?canceled=true`
    });

    res.json({ url: session.url, sessionId: session.id, paymentIntent: session.payment_intent });
  } catch (err) {
    console.error('create-checkout-session error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Create Stripe Connect account (Express) and return onboarding link
 * Body: { email }
 */
app.post('/create-account-link', async (req, res) => {
  try {
    const email = req.body.email;
    if(!email) return res.status(400).json({ error: 'Missing email' });

    const account = await stripe.accounts.create({
      type: 'express',
      country: 'ES',
      email: email,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } }
    });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${CLIENT_URL}/onboarding/refresh`,
      return_url: `${CLIENT_URL}/onboarding/complete`,
      type: 'account_onboarding'
    });

    res.json({ url: accountLink.url, accountId: account.id });
  } catch (err) {
    console.error('create-account-link error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Refund endpoint (simple protection via x-refund-secret header)
 * Body: { payment_intent, amount_cents (optional, if not provided full refund) }
 * Header required: x-refund-secret: REFUND_SECRET value from .env
 *
 * IMPORTANT: In production, replace with authenticated endpoint and authorization checks.
 */
app.post('/refund-deposit', async (req, res) => {
  try {
    const secret = req.headers['x-refund-secret'];
    if(!process.env.REFUND_SECRET || secret !== process.env.REFUND_SECRET) {
      return res.status(403).json({ error: 'Forbidden - invalid refund secret' });
    }
    const { payment_intent, amount_cents } = req.body;
    if(!payment_intent) return res.status(400).json({ error: 'payment_intent required' });

    // Create refund for the charge(s) related to the PaymentIntent
    // We don't know the charge id directly here, but stripe allows refund by payment_intent.
    const refund = await stripe.refunds.create({
      payment_intent: payment_intent,
      amount: amount_cents || undefined
    });

    res.json({ success: true, refund });
  } catch (err) {
    console.error('refund-deposit error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Stripe webhook endpoint.
 */
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Webhook received:', event.type);

  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      console.log('Checkout session completed:', session.id);
      // TODO: Save transaction to your DB (Firestore, etc.) with session.payment_intent and session.id
      break;
    case 'payment_intent.payment_failed':
      console.log('Payment failed');
      break;
    case 'charge.refunded':
      console.log('Charge refunded:', event.data.object);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
