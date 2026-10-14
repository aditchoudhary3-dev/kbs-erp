// Print button on the receipt page (kept in a file because inline scripts are blocked).
document.querySelector('[data-print]')?.addEventListener('click', () => window.print());
