import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { contractorSignupSchema } from './contractor-schema.js';

export function contractorRouter(config: Config, store: Store) {
  const router = Router();
  router.post('/signup', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many signup attempts. Please wait up to 15 minutes and try again.' },
  }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const parsed = contractorSignupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Please check your details and try again.',
        errors: Object.fromEntries(parsed.error.issues.map((issue) => [issue.path[0], issue.message])) });
      return;
    }
    if (!config.LINQ_FROM_NUMBER) {
      res.status(503).json({ message: 'Signup is temporarily unavailable. Please try again later.' });
      return;
    }
    const signup = await store.registerContractor(parsed.data, config.LINQ_FROM_NUMBER);
    res.status(201).json({ success: true, agent: {
      name: 'FORM', phone: signup.agent_phone,
      email: config.FORM_CONTACT_EMAIL || null, website: config.FORM_CONTACT_WEBSITE || null,
    } });
  });
  return router;
}
