// Vercel entry: every /api/* request runs the Express app from src/server.js as a function
// (vercel.json routes them here). Static files in public/ are served by Vercel directly.
import { app } from '../src/server.js';

export default app;
