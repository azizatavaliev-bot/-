const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

async function getReply(history) {
  const system = config.systemPrompt(config);

  const response = await client.messages.create({
    model,
    max_tokens: 500,
    system,
    messages: history.map((m) => ({ role: m.role, content: m.text })),
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : 'Извините, не смог сформировать ответ. Попробуйте ещё раз.';
}

module.exports = { getReply };
