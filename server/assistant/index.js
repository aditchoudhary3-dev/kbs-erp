import { config } from '../config.js';
import { HttpError } from '../http.js';
import { can } from '../permissions.js';
import { listFeeTypes } from '../services/fee-structure.js';
import { askClaude } from './claude.js';
import { understand } from './local.js';
import { executeTool, toolNames, ToolError } from './tools.js';

export { confirmAction, cancelAction } from './actions.js';
export { dailySummary } from './insights.js';

// KBS AI Assistant: entry points used by the admin routes.

export function assistantInfo(staff) {
  const claude = config.assistant.provider === 'claude' && Boolean(config.assistant.claude.apiKey);
  const suggestions = [
    ['reports.view', 'How much cash was collected today?'],
    ['reports.view', 'Show Class 8 pending fees'],
    ['payments.view', 'How much fee is pending for Rahul Verma?'],
    ['students.view', 'Find Pranav from class 8'],
    ['reports.view', 'Generate today’s fee collection report'],
    ['reports.view', 'Show cash vs online collection'],
    ['reports.view', 'Which students have not paid this month’s tuition fee?'],
    ['fees.manage', 'Show all fee types'],
  ]
    .filter(([permission]) => can(staff.role, permission))
    .map(([, text]) => text);
  return {
    name: config.assistant.name,
    mode: claude ? 'claude' : 'built-in',
    modeLabel: claude ? `Claude (${config.assistant.claude.model})` : 'Built-in assistant',
    suggestions,
  };
}

// A few messages a minute per person is plenty for a fee office.
const recent = new Map();
function rateLimit(staff) {
  const now = Date.now();
  const times = (recent.get(staff.id) ?? []).filter((t) => now - t < 60_000);
  if (times.length >= config.assistant.messagesPerMinute) throw new HttpError(429, 'Too many questions in a minute. Please wait a moment.');
  times.push(now);
  recent.set(staff.id, times);
}

function cleanFollowUp(followUp) {
  if (!followUp || typeof followUp !== 'object') return null;
  if (!toolNames().includes(followUp.tool) || typeof followUp.need !== 'string') return null;
  return { tool: followUp.tool, need: followUp.need, args: followUp.args && typeof followUp.args === 'object' ? followUp.args : {} };
}

// Runs one tool for the user (pick lists and follow-ups use this too).
export function runTool(staff, name, args) {
  try {
    const result = executeTool(staff, name, args);
    return { reply: { text: result.text, cards: result.cards ?? [] }, followUp: result.followUp ?? null };
  } catch (err) {
    if (err instanceof ToolError) return { reply: { text: err.message, cards: [] }, followUp: null };
    throw err;
  }
}

function askBuiltIn(staff, message, followUp) {
  const plan = understand(message, { staff, followUp, feeTypes: listFeeTypes() });
  if (plan.reply) return { reply: plan.reply, followUp: plan.followUp ?? null };
  return runTool(staff, plan.tool, plan.args);
}

export async function ask(staff, body) {
  const message = String(body?.message ?? '').trim();
  if (!message) throw new HttpError(400, 'Type a question.');
  if (message.length > 500) throw new HttpError(400, 'Please keep questions under 500 characters.');
  rateLimit(staff);
  const info = assistantInfo(staff);
  const followUp = cleanFollowUp(body.followUp);

  if (info.mode === 'claude') {
    try {
      const result = await askClaude(staff, message, body.history);
      return { reply: result.reply, followUp: null, mode: 'claude' };
    } catch (err) {
      console.error(`[assistant] ${err.message}; answering with the built-in assistant.`);
      const result = askBuiltIn(staff, message, followUp);
      return { ...result, mode: 'built-in', notice: 'Claude could not be reached just now, so the built-in assistant answered.' };
    }
  }
  return { ...askBuiltIn(staff, message, followUp), mode: 'built-in' };
}
