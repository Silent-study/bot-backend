const OpenAI = require('openai');
require('dotenv').config();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function solveQuestion(question, options) {
  const prompt = `
You are solving a multiple choice question.

Question:
${question}

Options:
${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}

IMPORTANT:
- Return ONLY the exact option text
- Do NOT explain
- Do NOT say "option A/B"
- Return only one line
`;

  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You answer quiz questions accurately.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2
  });

  return res.choices[0].message.content.trim();
}

// Solve open-ended / essay questions using the surrounding question text as context
async function solveOpenQuestion(question) {
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You are a student writing concise, thoughtful short answers for online coursework.',
      },
      {
        role: 'user',
        content: `Write a 1-2 sentence answer for this question. Sound natural and student-like.\n\nQuestion: ${question}`,
      },
    ],
    temperature: 0.7,
  });

  return res.choices[0].message.content.trim();
}

module.exports = { solveQuestion, solveOpenQuestion };