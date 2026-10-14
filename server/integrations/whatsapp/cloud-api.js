import crypto from 'node:crypto';

// WhatsApp Business Platform, Cloud API (official, by Meta).
// https://developers.facebook.com/docs/whatsapp/cloud-api
//
// Messages a business starts must use a template approved by Meta. With
// WHATSAPP_TEMPLATE_NAME set, receipts are sent as that template with the
// receipt PDF as the document header. Without a template, a plain document
// message is sent, which WhatsApp only delivers within 24 hours of the parent
// last messaging the school.
export function createCloudApi({ token, phoneNumberId, apiBase, apiVersion, templateName, templateLanguage, appSecret }) {
  const base = `${apiBase}/${apiVersion}/${phoneNumberId}`;

  async function call(path, init) {
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new Error(`Could not reach WhatsApp: ${err.message}`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `WhatsApp returned ${response.status}`);
    return data;
  }

  async function uploadPdf(buffer, filename) {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'application/pdf');
    form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
    const data = await call('/media', { method: 'POST', body: form });
    return data.id;
  }

  return {
    name: 'cloud-api',
    label: 'WhatsApp Cloud API',
    automatic: true,

    // to: digits with country code, e.g. 919876543210
    async send({ to, text, templateParams, document }) {
      const mediaId = document ? await uploadPdf(document.buffer, document.filename) : null;
      const message = templateName
        ? {
            type: 'template',
            template: {
              name: templateName,
              language: { code: templateLanguage },
              components: [
                ...(mediaId
                  ? [{ type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename: document.filename } }] }]
                  : []),
                { type: 'body', parameters: templateParams.map((value) => ({ type: 'text', text: String(value) })) },
              ],
            },
          }
        : mediaId
          ? { type: 'document', document: { id: mediaId, filename: document.filename, caption: text } }
          : { type: 'text', text: { body: text, preview_url: false } };

      const data = await call('/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message }),
      });
      return { providerMessageId: data.messages?.[0]?.id ?? null };
    },

    // Delivery updates from Meta are signed with the app secret.
    verifyWebhook(rawBody, signatureHeader) {
      if (!appSecret || typeof signatureHeader !== 'string') return false;
      const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
      const a = Buffer.from(expected);
      const b = Buffer.from(signatureHeader);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}
