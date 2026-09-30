export function toast(message, ms = 2500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message; el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

export function confirmDialog(message, { okText = '確定', cancelText = '取消' } = {}) {
  const dlg = document.getElementById('confirm');
  if (!dlg?.showModal) return Promise.resolve(window.confirm(message));
  document.getElementById('confirm-text').textContent = message;
  document.getElementById('confirm-ok').textContent = okText;
  document.getElementById('confirm-cancel').textContent = cancelText;
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}
