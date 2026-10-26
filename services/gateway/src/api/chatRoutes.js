/** Chat agent endpoint: runs the LLM tool loop as the signed-in user. */
import { bad, wrap } from './http.js';

export function mountChatRoutes(api, { chat }) {
  api.post(
    '/chat',
    wrap(async (req, res) => {
      const message = String(req.body?.message || '').trim();
      if (!message) throw bad('message is required');
      if (message.length > 4000) throw bad('message is too long');
      const history = (Array.isArray(req.body?.history) ? req.body.history : [])
        .filter((h) => h && ['user', 'assistant'].includes(h.role) && typeof h.content === 'string' && h.content.trim())
        .slice(-20)
        .map((h) => ({ role: h.role, content: h.content.slice(0, 8000) }));
      res.json(await chat.run(req.user, history, message));
    }),
  );
}
