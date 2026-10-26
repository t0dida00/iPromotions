import express from 'express';
import Stripe from 'stripe';
import config from '../config.js';
import { requireUser } from './auth.js';
import { grant } from './credits.js';

// Buying checks for "Follow your discount" with Stripe Checkout: card details are entered on
// Stripe's page, never here. The browser asks for a session (POST /api/billing/checkout) and is
// sent to Stripe; when the payment succeeds Stripe calls POST /api/billing/webhook, which adds the
// checks (src/credits.js grant, safe to repeat). Prices come from config.credits.plans.
//   STRIPE_SECRET_KEY      sk_test_… / sk_live_… (from the Stripe integration or dashboard)
//   STRIPE_WEBHOOK_SECRET  whsec_… for the webhook endpoint (or from `stripe listen` locally)
//   PUBLIC_URL             optional, e.g. https://ipromotions.vercel.app (else the request's host)
const { plans } = config.credits;
let stripe = null;
const client = () => (stripe ??= process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null);
export const paymentsEnabled = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);

export const billingRouter = express.Router();

billingRouter.post('/api/billing/checkout', requireUser, express.json({ limit: '2kb' }), async (req, res) => {
  const plan = String(req.body?.plan ?? '');
  const p = plans[plan];
  if (!p) return res.status(400).json({ error: 'Unknown plan.' });
  if (!client() || !paymentsEnabled()) return res.status(503).json({ error: "Payments aren't set up yet. Please try again later." });
  if (req.user.id == null) return res.status(503).json({ error: "We couldn't reach your account right now. Please try again in a moment." });
  const origin = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  try {
    const session = await client().checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: p.cents,
            product_data: {
              name: `iPromotion: ${p.name}`,
              description: p.days ? `Unlimited photo checks for ${p.days} days (fair use ${config.credits.unlimitedPerDay} a day). No automatic renewal.` : `${p.checks} photo checks for Follow your discount. They never expire.`,
            },
          },
        },
      ],
      client_reference_id: String(req.user.id),
      metadata: { plan, userId: String(req.user.id) },
      customer_email: req.user.email ?? undefined,
      // EU consumers: express consent to immediate delivery of digital content (no 14-day withdrawal).
      // Needs a Terms of Service URL in the Stripe dashboard (Settings → Public details).
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: {
          message: `I agree to the [Terms of use](${origin}/terms) and want the checks added right away. I understand that I then lose the 14-day right of withdrawal.`,
        },
      },
      success_url: `${origin}/pricing?paid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing?canceled=1`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[billing] checkout:', e.message);
    res.status(502).json({ error: "We couldn't open the payment page right now. Please try again in a moment." });
  }
});

// Stripe → us. Needs the raw body for the signature check, so it's mounted in server.js before any
// JSON parser and outside the API rate limit. Answers 500 when granting fails, so Stripe retries.
export async function stripeWebhook(req, res) {
  if (!client() || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = client().webhooks.constructEvent(req.body, req.get('stripe-signature') ?? '', process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.warn('[billing] webhook signature rejected:', e.message);
    return res.status(400).json({ error: 'Bad signature' });
  }
  const s = event.data.object;
  const paid = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) && s.payment_status === 'paid';
  if (!paid) return res.json({ received: true });
  const plan = s.metadata?.plan;
  const userId = Number(s.metadata?.userId ?? s.client_reference_id);
  // Only grant what was actually paid for.
  if (!plans[plan] || !Number.isInteger(userId) || s.amount_total !== plans[plan].cents || s.currency !== 'eur') {
    console.error(`[billing] session ${s.id} doesn't match a plan (plan ${plan}, ${s.amount_total} ${s.currency}); not granted`);
    return res.json({ received: true });
  }
  try {
    const fresh = await grant({ userId, plan, sessionId: s.id, amountCents: s.amount_total, currency: s.currency });
    console.log(`[billing] ${fresh ? 'granted' : 'already granted'} ${plan} to user ${userId} (${s.id})`);
    res.json({ received: true });
  } catch (e) {
    console.error('[billing] grant failed:', e.message);
    res.status(500).json({ error: 'Grant failed' });
  }
}
