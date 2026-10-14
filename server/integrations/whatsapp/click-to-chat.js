// Used when no WhatsApp Business API account is configured. Nothing is sent
// automatically: the message is prepared, and the clerk's "Send on WhatsApp"
// button opens WhatsApp (app or web) with the parent's number and the text
// filled in, using WhatsApp's official click-to-chat link. The clerk attaches
// the downloaded receipt PDF and presses Send.
export function createClickToChat() {
  return {
    name: 'click-to-chat',
    label: 'WhatsApp (click to chat)',
    automatic: false,
  };
}

export const clickToChatLink = (number, text) => `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
