"""
tests/browser-check.py: drives the real page in Chromium (Playwright) and checks that it computes on input.
Run:  python3 tests/browser-check.py
It serves this folder on a free local port, opens index.html, changes the format, coverage and gaps, approves,
exports real files and opens them, edits the case and the memo, refuses bad input, and fails on any console
or page error. Screenshots go to tests/screenshots/.
"""
import asyncio, functools, http.server, io, pathlib, socketserver, threading, zipfile
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / 'tests' / 'screenshots'
SHOTS.mkdir(exist_ok=True)
passed = failed = 0


def ok(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print('  PASS', name)
    else:
        failed += 1
        print('  FAIL', name, detail)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


async def until(pg, js, timeout=6000):
    """Polls a JS expression (the page's CSP-free, but this keeps waits explicit and cheap)."""
    for _ in range(timeout // 100):
        if await pg.evaluate(js):
            return True
        await pg.wait_for_timeout(100)
    return False


async def main():
    srv, port = serve()
    base = f'http://127.0.0.1:{port}/index.html'
    errors = []
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        pg = await ctx.new_page()
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        k = lambda key: pg.locator(f'.kpi[data-k={key}] b').inner_text()
        card = lambda title: pg.locator('.sc', has=pg.locator('h4', has_text=title)).first

        async def download(selector):
            async with pg.expect_download() as dl:
                await pg.click(selector)
            d = await dl.value
            return d.suggested_filename, pathlib.Path(await d.path()).read_bytes()

        print('\n1. The studio loads on the invented chapter')
        await pg.goto(base)
        await pg.wait_for_selector('#slides .sc')
        ok('5 of 5 objectives covered, 1 by your vignette', await k('covered') == '5/5' and 'by your vignette' in await pg.inner_text('.kpi[data-k=covered] span'))
        ok('22 student slides + 1 instructor-only; 1 needs your material; 3 AI drafts', await k('slides') == '22 + 1' and await k('gaps') == '1' and await k('ai') == '3')
        ok('0 of 23 approved, 75 minutes planned', await k('approved') == '0/23' and await k('minutes') == '75')
        ok('23 slide cards in the instructor view, with notes', await pg.locator('#slides .sc').count() == 23 and await pg.locator('#slides .notes').count() > 15)
        ok('final files are locked until you approve', await pg.locator('[data-dl][data-final="1"]').first.is_disabled() and 'Blocked' in await pg.inner_text('#gateMsg'))

        print('\n2. Your format changes the draft')
        await pg.click('#fBul')
        await pg.fill('#fBul', '3')
        await pg.dispatch_event('#fBul', 'change')
        ok('a 3-bullet limit cuts "Cost Leadership" to 3 bullets', await card('Cost Leadership').locator('.mini li').count() == 3)
        ok('and the new version lists what changed', 'Bullets per slide 3' in await pg.inner_text('#vers'), await pg.inner_text('#vers'))
        await pg.fill('#fBul', '12')
        await pg.dispatch_event('#fBul', 'input')
        ok('12 bullets is refused with a reason and the deck is kept', 'maxBullets must be a whole number from 2 to 8' in await pg.inner_text('#fmtErr') and await card('Cost Leadership').locator('.mini li').count() == 3)
        await pg.fill('#fBul', '5')
        await pg.dispatch_event('#fBul', 'change')
        await pg.click('#fMin')
        await pg.fill('#fMin', '50')
        await pg.dispatch_event('#fMin', 'change')
        ok('a 50-minute class re-plans the time to exactly 50', await k('minutes') == '50')
        await pg.fill('#fMin', '75')
        await pg.dispatch_event('#fMin', 'change')

        print('\n3. Coverage: your corrections win')
        await pg.click('.lo[data-lo="LO6.1"] [data-unassign="LO6.1"][data-n="4"]')
        ok('removing slide 4 from LO6.1 drops "Customers: Who, What and How"', await card('Customers: Who, What and How').count() == 0 and '4' in await pg.inner_text('#unused'))
        await pg.select_option('.lo[data-lo="LO6.2"] select', '9')
        ok('adding slide 9 to LO6.2 brings in "Focus Strategies"', await card('Focus Strategies').count() == 1)
        await pg.click('.lo[data-lo="LO6.1"] [data-reprop]')
        await pg.click('.lo[data-lo="LO6.2"] [data-reprop]')
        ok('"use proposal" puts both back', await card('Customers: Who, What and How').count() == 1 and await card('Focus Strategies').count() == 0)

        print('\n4. A gap asks for your material instead of inventing it')
        gap = pg.locator('.sc.gap').first
        await gap.locator('textarea').fill('Bank')
        await gap.locator('[data-fill]').click()
        ok('two words are refused with a reason', 'at least a short sentence' in await pg.locator('.sc.gap [data-fill-err]').first.inner_text())
        await pg.locator('.sc.gap textarea').first.fill('A Tampa credit union: same products as the big banks, wins on who it serves and how')
        await pg.locator('.sc.gap [data-fill]').first.click()
        ok('your example clears the gap', await k('gaps') == '0' and await pg.locator('.sc.gap').count() == 0)

        print('\n5. Approval, edits after approval, and final files')
        await pg.click('#approveAll')
        ok('approving all opens the final files: 23/23', await k('approved') == '23/23' and not await pg.locator('[data-dl][data-final="1"]').first.is_disabled())
        name, data = await download('[data-dl="student"][data-final="1"]')
        z = zipfile.ZipFile(io.BytesIO(data))
        slides = [n for n in z.namelist() if n.startswith('ppt/slides/slide')]
        ok('the final student deck downloads as a real .pptx with 22 slides and no notes', name.endswith('-student-final.pptx') and len(slides) == 22 and not any(n.startswith('ppt/notesSlides/') for n in z.namelist()), (name, len(slides)))
        name, data = await download('[data-dl="instructor"][data-final="1"]')
        z = zipfile.ZipFile(io.BytesIO(data))
        ok('the final instructor deck has all 23 slides and their notes', len([n for n in z.namelist() if n.startswith('ppt/slides/slide')]) == 23 and len([n for n in z.namelist() if n.startswith('ppt/notesSlides/notesSlide')]) >= 20)
        await card('Cost Leadership').locator('[data-editk]').click()
        await pg.fill('[data-edit-ta]', 'Cost Leadership\nLowest cost, not lowest price\nScale and lean operations')
        await pg.click('[data-save]')
        ok('editing an approved slide sends it back: "Changed since approval"', 'Changed since approval' in await card('Cost Leadership').locator('[data-status]').inner_text() and await k('approved') == '22/23')
        ok('and locks the final files again', await pg.locator('[data-dl][data-final="1"]').first.is_disabled())
        await card('Cost Leadership').locator('[data-approve]').click()
        ok('approving the edit reopens them', await k('approved') == '23/23')
        name, data = await download('[data-dl="guide"][data-final="1"]')
        ok('the instructor guide downloads as a real .docx', name == 'instructor-guide-final.docx' and 'word/document.xml' in zipfile.ZipFile(io.BytesIO(data)).namelist())
        await pg.click('.seg [data-view=student]')
        ok('student view hides the answer key and every note', await card('Answer key').count() == 0 and await pg.locator('#slides .notes').count() == 0)
        await pg.click('.seg [data-view=instructor]')

        print('\n6. Loading a real .pptx (written by python-pptx, compressed like PowerPoint)')
        await pg.set_input_files('#pptxIn', str(ROOT / 'tests' / 'fixtures' / 'publisher-short.pptx'))
        ok('it is read in the browser and the coverage changes to 4/5', await until(pg, "document.querySelector('.kpi[data-k=covered] b').textContent === '4/5'") and 'publisher-short.pptx' in await pg.inner_text('#srcLabel'))
        ok('LO6.1 now asks for your material', 'needs your material' in await pg.locator('.lo[data-lo="LO6.1"]').inner_text())
        await pg.set_input_files('#pptxIn', files=[{'name': 'notes.txt', 'mimeType': 'text/plain', 'buffer': b'not a deck'}])
        ok('a file that is not a .pptx is refused with a reason', 'choose a .pptx' in await pg.inner_text('#srcErr'))
        await pg.click('#backSample')
        ok('"Back to sample" restores 5/5', await k('covered') == '5/5')

        print('\n7. Vignette and teaching note')
        await pg.click('.side [data-tab=case]')
        ok('the tab switches views: only the vignette pane shows', await pg.locator('[data-pane=case]').is_visible() and not await pg.locator('[data-pane=deck]').is_visible() and not await pg.locator('#kpis').is_visible())
        ok('both documents start consistent with the master record', await pg.locator('#stuIss .iss.clean').count() == 1 and await pg.locator('#teaIss .iss.clean').count() == 1)
        stu = await pg.input_value('#stuTa')
        await pg.fill('#stuTa', stu.replace('Pelican Point Marine is a family-owned', 'Bayshore Marine Supply is a family-owned'))
        ok('typing the real company name is blocked, and final is locked', await pg.locator('#stuIss [data-type=leak-name]').count() == 1 and await pg.locator('#caseFinal').is_disabled())
        await pg.fill('#stuTa', stu.replace('27%', '25%'))
        ok('changing 27% to 25% is caught as contradicting F4', 'contradicts F4' in await pg.inner_text('#stuIss'))
        await pg.fill('#stuTa', stu + '\n\nRevenue later recovered to $7.4 million.')
        ok('the epilogue figure in the student copy is blocked', await pg.locator('#stuIss [data-type=leak-instructor]').count() == 1)
        await pg.click('#regen')
        ok('rebuilding from the record clears it', await pg.locator('#stuIss .iss.clean').count() == 1 and not await pg.locator('#caseFinal').is_disabled())
        await pg.fill('[data-disg="0"]', 'Mangrove Bay Marine')
        ok('a new disguise flows into both documents', 'Mangrove Bay Marine' in await pg.input_value('#stuTa') and 'Mangrove Bay Marine' in await pg.input_value('#teaTa'))
        await pg.fill('[data-disg="0"]', 'Bayshore Marine Supply')
        ok('using a real name as the disguise is refused', 'real name' in await pg.inner_text('#disgErr'))
        await pg.fill('[data-disg="0"]', 'Pelican Point Marine')
        async with pg.expect_download() as dl:
            await pg.click('#caseFinal')
        d = await dl.value
        ok('the final student case downloads as .docx', d.suggested_filename == 'student-case-final.docx')

        print('\n8. Research sources')
        await pg.click('.side [data-tab=research]')
        ok('3 open items: a fabricated citation and two unreviewed AI paragraphs', '3 open items' in await pg.inner_text('#memoGate') and 'no database has it' in await pg.inner_text('#matrix'))
        await pg.check('[data-rev="3"]')
        ok('ticking "reviewed" does not clear a fabricated citation', 'no database has it' in await pg.inner_text('#matrix tr[data-row=P4]') and await pg.locator('#memoFinal').is_disabled())
        await pg.fill('[data-ptext="3"]', 'Hybrid approaches can work only when the firm has real capability in both (Porter, 1985).')
        await pg.check('[data-rev="3"]')
        await pg.check('[data-rev="4"]')
        ok('replace it with a verified source and review both: final opens', 'Every citation verified' in await pg.inner_text('#memoGate') and not await pg.locator('#memoFinal').is_disabled())
        await pg.click('#addPara')
        await pg.fill('[data-ptext="5"]', 'As shown before (Nguyen, 2020).')
        ok('citing a paper that is not in your library is blocked', 'not in your library' in await pg.inner_text('#matrix'))

        print('\n9. Privacy and running cost')
        await pg.click('.side [data-tab=privacy]')
        ok('only the privacy pane shows', await pg.locator('[data-pane=privacy]').is_visible() and not await pg.locator('[data-pane=research]').is_visible())
        ok('names, the student ID, email and phone are removed: 5 items', await pg.inner_text('#redCount') == '5' and 'Maya' not in await pg.inner_text('#redOut'))
        ok('student information is Restricted', 'Restricted' in await pg.locator('#tiers .fact', has_text='Student names').inner_text())
        ok('sample volume on Claude Opus 5.5 costs $17.18 a month', await pg.inner_text('#costTotal') == '$17.18')
        await pg.fill('#cDecks', '10')
        ok('10 decks a month raises it', await pg.inner_text('#costTotal') != '$17.18')
        await pg.select_option('#cModel', 'claude-haiku-5-5')
        t = float((await pg.inner_text('#costTotal')).strip('$'))
        ok('Claude Haiku 5.5 brings model use close to zero (server cost remains)', 14 <= t < 15, t)
        await pg.fill('#cDecks', '-3')
        ok('a negative volume is refused with a reason', 'decks must be a number from 0 to 60' in await pg.inner_text('#costErr'))
        await pg.fill('#cDecks', '4')
        await pg.select_option('#cModel', 'claude-opus-5-5')

        print('\n10. Reset, screenshots, phone layout')
        await pg.click('#resetBtn')
        await pg.click('.side [data-tab=deck]')
        ok('reset brings back the starting chapter', await k('approved') == '0/23' and await k('gaps') == '1')
        await pg.locator('#tool').scroll_into_view_if_needed()
        await pg.screenshot(path=str(SHOTS / 'desktop-studio.png'))
        await pg.click('.side [data-tab=case]')
        await pg.screenshot(path=str(SHOTS / 'desktop-case.png'))
        await pg.click('.side [data-tab=deck]')
        await pg.locator('#pricing').scroll_into_view_if_needed()
        await pg.screenshot(path=str(SHOTS / 'desktop-pricing.png'))
        mob = await br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        pm = await mob.new_page()
        pm.on('pageerror', lambda e: errors.append(str(e)))
        await pm.goto(base)
        await pm.wait_for_selector('#slides .sc')
        ok('no sideways scrolling at 390px wide', await pm.evaluate('document.documentElement.scrollWidth') <= 390, await pm.evaluate('document.documentElement.scrollWidth'))
        await pm.locator('#tool').scroll_into_view_if_needed()
        await pm.screenshot(path=str(SHOTS / 'mobile.png'))

        ok('zero console or page errors', not errors, errors)
        await br.close()
    srv.shutdown()
    print(f'\n{passed + failed} browser checks: {passed} passed, {failed} failed')
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    asyncio.run(main())
