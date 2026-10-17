// Drives the mocked UI (vite.config.ts in this folder) with Playwright and
// writes the README screenshots to docs/screenshots/. See README.md here.
const path = require('path')
const { chromium } = require('playwright')

const URL = process.env.SHOTS_URL || 'http://localhost:5199/'
const OUT = path.resolve(__dirname, '../../docs/screenshots')

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  page.on('pageerror', (e) => console.error('[pageerror]', e.message))
  const shot = (name, opts = {}) => page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts })

  await page.goto(URL)
  await page.waitForTimeout(1500)

  // Sessions board: every session across local + SSH hosts.
  await page.click('button[title^="Open Sessions Board"]')
  await page.waitForTimeout(1200)
  await shot('board')

  // Session view: a conversation waiting on a permission prompt.
  await page.getByText('Add rate limiting to the public API').first().click()
  await page.waitForTimeout(2000)
  await shot('session')

  // Selecting text in the chat pops Copy / Mention.
  const box = await page.evaluate(() => {
    const para = [...document.querySelectorAll('.acp-scroll p')].find((p) => p.textContent.startsWith('The three new tests pass'))
    const node = para.firstChild
    const range = document.createRange()
    range.setStart(node, 4)
    range.setEnd(node, 25)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    document.querySelector('.acp-scroll').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    const r = para.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  })
  await page.waitForTimeout(400)
  await shot('selection', { clip: { x: box.x - 24, y: box.y - 64, width: 720, height: box.height + 96 } })
  await page.evaluate(() => window.getSelection().removeAllRanges())

  // Reviewing the agent's changes: Source Control panel + a diff.
  await page.click('button[title="Source Control"]')
  await page.waitForTimeout(800)
  await page.getByText('app.ts', { exact: true }).first().click()
  await page.waitForTimeout(2000)
  await shot('changes')

  await browser.close()
})()
