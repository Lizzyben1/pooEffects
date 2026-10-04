// Short collision-resistant ids. Alphanumeric only so they can be embedded in dot-separated
// property paths (e.g. "effects.fx3k9a.params.radius").

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

let counter = 0;

export function uid(prefix = 'id'): string {
  let s = '';
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  for (let i = 0; i < bytes.length; i++) s += ALPHABET[bytes[i] % 36];
  counter = (counter + 1) % 1296;
  return `${prefix}${s}${ALPHABET[Math.floor(counter / 36)]}${ALPHABET[counter % 36]}`;
}
