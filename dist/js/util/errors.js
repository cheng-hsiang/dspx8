/** Human-readable text for anything a promise can reject with. Bluefy rejects a cancelled chooser with no message at all. */
export function errText(err) {
  const NONE = '無錯誤訊息';
  if (err == null) return NONE;
  if (typeof err === 'string') return err.trim() || NONE;
  const msg = typeof err.message === 'string' ? err.message.trim() : '';
  if (msg) return msg;
  const name = typeof err.name === 'string' ? err.name.trim() : '';
  return name || NONE;
}
