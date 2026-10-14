import { config } from '../config.js';
import { ROLES } from '../permissions.js';
import { executeTool, ToolError, toolsFor } from './tools.js';
import { formatDate, todayIso } from '../../shared/format.js';

// KBS AI Assistant on Claude (Anthropic Messages API, tool use).
//
// Claude sees only: the question, the recent conversation text, and what
// the allow-listed tools return for this user. It never sees keys, tokens,
// settings or the database. It can only call the tools this user's role
// allows, every call is checked again on the server, and tools that change
// data only prepare a change for the user to confirm.

function systemPrompt(staff) {
  const school = config.school;
  return [
    `You are ${config.assistant.name}, the assistant inside ${config.appName} for ${school.name}, ${school.shortAddress}.`,
    `You are helping ${staff.name} (${ROLES[staff.role] ?? staff.role}). Today is ${formatDate(todayIso())} (India time). The academic session is ${config.academicYear.label}. Receipt numbers look like ${config.receiptPrefix}00123. Amounts are Indian rupees; write them like ₹15,500.`,
    '',
    'How to answer:',
    '- Use the tools for every fact. Answer only from what the tools return, and never invent names, numbers, receipt numbers or dates. If a tool returns nothing, say so.',
    '- The app shows the tables and cards from your tool calls below your reply, with Export Excel, print and WhatsApp buttons. Keep your reply short (1 to 4 sentences): give the key figures and do not repeat whole tables.',
    '- If a student name matches several students, the app shows a list; ask the user to pick the right student.',
    '- Tools named propose_* only prepare a change. The user must press Confirm on the card for anything to happen. Never say a payment was recorded or a fee was added until the user confirms; say it is ready and ask them to confirm.',
    '- You cannot delete or cancel payments or receipts, change payment status, transaction IDs, amounts or issued receipts, or manage staff accounts. For a wrong payment, tell the user to open the receipt and choose Request correction (an admin approves it; the original stays on record).',
    '- Never mark anything as paid on your own. Only prepare a counter payment when the user says money was received.',
    '- Share only what the question needs. You have no access to phone numbers, addresses, dates of birth, passwords, API keys, tokens, settings or environment variables; if asked, say you cannot share them.',
    '- If the user asks for something the tools cannot do, say what you can do instead.',
  ].join('\n');
}

// The browser keeps the conversation; only its text is sent back here.
function toMessages(history, message) {
  const messages = [];
  for (const turn of (Array.isArray(history) ? history : []).slice(-12)) {
    const role = turn?.role === 'assistant' ? 'assistant' : 'user';
    const text = String(turn?.text ?? '').slice(0, 2000).trim();
    if (!text) continue;
    if (messages.at(-1)?.role === role) messages.at(-1).content += `\n${text}`;
    else messages.push({ role, content: text });
  }
  while (messages[0]?.role === 'assistant') messages.shift();
  if (messages.at(-1)?.role === 'user') messages.at(-1).content += `\n${message}`;
  else messages.push({ role: 'user', content: message });
  return messages;
}

async function callClaude(body) {
  const { apiKey, apiBase, timeoutMs } = config.assistant.claude;
  let response;
  try {
    response = await fetch(`${apiBase}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Could not reach Claude: ${err.message}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Claude returned ${response.status}: ${data?.error?.message ?? 'error'}`);
  return data;
}

export async function askClaude(staff, message, history) {
  const { model, maxRounds } = config.assistant.claude;
  const tools = toolsFor(staff);
  const messages = toMessages(history, message);
  const cards = [];
  const used = [];

  for (let round = 0; round < maxRounds; round += 1) {
    const response = await callClaude({ model, max_tokens: 1024, system: systemPrompt(staff), tools, messages });
    const calls = (response.content ?? []).filter((block) => block.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !calls.length) {
      const text = (response.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
      return { reply: { text: text || 'Here is what I found.', cards }, tools: used };
    }
    messages.push({ role: 'assistant', content: response.content });
    const results = calls.map((use) => {
      used.push(use.name);
      try {
        const result = executeTool(staff, use.name, use.input);
        cards.push(...(result.cards ?? []));
        return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify({ summary: result.text, ...(result.data ?? {}) }).slice(0, 12_000) };
      } catch (err) {
        if (!(err instanceof ToolError)) console.error(`[assistant] tool ${use.name} failed:`, err);
        const content = err instanceof ToolError ? err.message : 'This lookup failed. Tell the user to try again or use the menu.';
        return { type: 'tool_result', tool_use_id: use.id, content, is_error: true };
      }
    });
    messages.push({ role: 'user', content: results });
  }
  return { reply: { text: 'Here is what I found.', cards }, tools: used };
}
