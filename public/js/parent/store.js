import { api } from '../lib/api.js';

// Who is logged in and which child they are looking at. Cached for the session;
// cleared on logout.
let me = null;
let selectedId = null;
const CHILD_KEY = 'schoolconnect.child';

function savedChildId() {
  if (selectedId) return selectedId;
  try {
    return Number(localStorage.getItem(CHILD_KEY));
  } catch {
    return null;
  }
}

export async function loadFamily({ fresh = false } = {}) {
  if (!me || fresh) me = await api('/api/me');
  const child = me.children.find((c) => c.id === savedChildId()) ?? me.children[0];
  return { me, child };
}

export function selectChild(id) {
  selectedId = id;
  try {
    localStorage.setItem(CHILD_KEY, String(id));
  } catch {
    // Storage can be blocked; the choice then lasts until the page reloads.
  }
}

export function forgetFamily() {
  me = null;
  selectedId = null;
}
