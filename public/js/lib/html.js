// Tagged template for building markup. Interpolated values are escaped unless
// they are themselves html`` results (or arrays of them).
//
//   html`<p>${userText}</p>`         -> escaped
//   html`<ul>${items.map(i => html`<li>${i}</li>`)}</ul>`

class Html {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escape(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => (out += render(value) + strings[i + 1]));
  return new Html(out);
}

export const raw = (value) => new Html(String(value));

export function mount(element, template) {
  element.innerHTML = String(template);
}
