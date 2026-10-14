import { api } from '../lib/api.js';

// The logged-in staff member, their permissions, and school settings
// (classes, grades, payment modes, gateway and WhatsApp setup).
export const session = {
  meta: null,
  async load() {
    this.meta = await api('/api/admin/me');
    return this.meta;
  },
  // `permission` may be a list: any one of them is enough.
  can(permission) {
    return [].concat(permission).some((p) => this.meta?.permissions.includes(p));
  },
};
