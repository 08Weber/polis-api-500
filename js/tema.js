// Sätt färgtema innan sidan ritas, så att den inte blinkar till.
// Egen fil i stället för inline-skript, så att sidans CSP kan förbjuda inline-skript.
(() => {
  let theme = null;
  try {
    theme = localStorage.getItem('polis-api-500:tema');
  } catch {}
  if (theme !== 'light' && theme !== 'dark') {
    theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = theme;
})();
