/* While a dialog is open the page behind it cannot be reached, and closing it
   gives the focus back. Escape closes the dialogs that ask for nothing. */
(() => {
  const ESCAPABLE = ['ov-limit', 'ov-how'];
  const page = document.querySelector('.wrap');
  const overlays = Array.from(document.querySelectorAll('.ov'));
  let opener = null;
  const sync = () => {
    const open = overlays.some((o) => o.classList.contains('show'));
    if (open === page.inert) return;
    if (open) opener = document.activeElement;
    page.inert = open;
    if (!open && opener && opener.isConnected) opener.focus({ preventScroll: true });
  };
  overlays.forEach((o) => new MutationObserver(sync).observe(o, { attributes: true, attributeFilter: ['class'] }));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    overlays.forEach((o) => { if (ESCAPABLE.includes(o.id)) o.classList.remove('show'); });
  });
})();
