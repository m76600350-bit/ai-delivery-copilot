import axios from 'axios';

// VITE_API_URL lets `npm run dev` keep hitting a local backend via the Vite
// proxy (see vite.config.js) while the built app defaults to production.
const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://ai-delivery-copilot-backend.vercel.app';

const api = axios.create({
  baseURL: `${API_BASE_URL}/api`,
});

export default api;
