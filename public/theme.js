// Theme: system (default), light or dark, remembered per browser. Loaded blocking in <head>, so the page never
// paints in the wrong theme; the header buttons are wired once the document is parsed.
const KEY = 'theme'
const read = () => { try { return localStorage.getItem(KEY) } catch { return null } }
function apply(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
  else delete document.documentElement.dataset.theme
  // the browser chrome follows a picked theme too
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = { light: '#f6f7fb', dark: '#0c0e13' }[t] ?? (m.media.includes('dark') ? '#0c0e13' : '#f6f7fb')
  for (const b of document.querySelectorAll('[data-theme-pick]')) b.setAttribute('aria-pressed', String(b.dataset.themePick === (t || 'system')))
}
apply(read())
document.addEventListener('DOMContentLoaded', () => {
  apply(read())
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-pick]')
    if (!b) return
    const t = b.dataset.themePick
    try { t === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, t) } catch {}
    apply(t)
  })
})
