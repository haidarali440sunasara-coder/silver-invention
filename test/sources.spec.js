import { test, expect } from '@playwright/test';
import { mockYouTube } from './helpers/youtube-api.js';

async function choose(page, url, kind = 'video') {
  await page.locator('#choose-video').click();
  await page.locator('#media-kind').selectOption(kind);
  await page.locator('#video-url').fill(url);
  await page.locator('#source-submit').click();
  await expect(page.locator('#video-dialog')).toBeHidden();
}
const latest = page => page.evaluate(() => {
  const player = window.youTubeTest.players.at(-1);
  return { time: player.getCurrentTime(), status: player.status };
});

test('shares YouTube playback, native controls, late joining, autoplay recovery, and website addresses', async ({ page, browser }) => {
  await mockYouTube(page.context());
  const errors=[]; page.on('pageerror', error=>errors.push(error.message));
  await page.addInitScript(() => {
    const Socket=WebSocket; window.playbackSent=[];
    window.WebSocket=class extends Socket { send(value){const data=JSON.parse(value);if(data.type==='playback')window.playbackSent.push(data);super.send(value)} };
  });
  await page.goto('/');
  await page.locator('#create-button').click(); await page.locator('#name-input').fill('Asha'); await page.locator('#room-submit').click();
  await expect(page.locator('#invite-dialog')).toBeVisible();
  const invitation=await page.locator('#invite-link').inputValue();
  await page.locator('#invite-dialog [data-close]').click();
  await choose(page,'https://youtu.be/M7lc1UVf-VE?si=ignored');
  await expect(page.locator('#play-button')).toBeEnabled();
  await expect(page.locator('#youtube-shell iframe')).toHaveAttribute('src', /youtube-nocookie.com\/embed\/M7lc1UVf-VE\?/);
  await expect(page.locator('#youtube-shell iframe')).toHaveAttribute('referrerpolicy','strict-origin-when-cross-origin');
  const frameRect=await page.locator('#youtube-shell').boundingBox();
  const controlsRect=await page.locator('#movie-controls').boundingBox();
  expect(frameRect.height).toBeGreaterThanOrEqual(200);expect(controlsRect.y).toBeGreaterThanOrEqual(frameRect.y+frameRect.height);
  await page.locator('#seek').fill('40'); await page.locator('#seek').dispatchEvent('change');

  const context=await browser.newContext({viewport:{width:390,height:844}}); await mockYouTube(context);
  const partner=await context.newPage();partner.on('pageerror',error=>errors.push(error.message));
  await partner.goto(invitation);await partner.locator('#name-input').fill('Alex');await partner.locator('#room-submit').click();
  await expect(partner.locator('#people-count')).toHaveText('2 / 2');
  await expect(partner.locator('#youtube-shell iframe')).toBeVisible();
  await expect(partner.locator('#play-button')).toBeEnabled();
  await expect.poll(async()=>(await latest(partner)).time).toBeCloseTo(40,0);
  await partner.evaluate(()=>{window.youTubeTest.blockNextPlay=true});
  await page.locator('#play-button').click();
  await expect(partner.locator('#resume-button')).toBeVisible();
  await partner.locator('#resume-button').click();
  await expect.poll(async()=>(await latest(partner)).status).toBe(1);
  await partner.locator('#play-button').click();
  await expect.poll(async()=>(await latest(page)).status).toBe(2);
  await page.locator('#seek').fill('70');await page.locator('#seek').dispatchEvent('change');
  await expect.poll(async()=>(await latest(partner)).time).toBeCloseTo(70,0);

  // Native controls run after programmatic commands have settled.
  await page.waitForTimeout(1400);
  await page.evaluate(()=>window.youTubeTest.players.at(-1).nativeSeek(95));
  await expect.poll(async()=>(await latest(partner)).time).toBeCloseTo(95,0);
  await page.waitForTimeout(1400);
  await page.evaluate(()=>window.youTubeTest.players.at(-1).nativePlay());
  await expect.poll(async()=>(await latest(partner)).status).toBe(1);
  // A user can immediately override an incoming play using YouTube's controls.
  await partner.evaluate(()=>window.youTubeTest.players.at(-1).nativePause());
  await expect.poll(async()=>(await latest(page)).status).toBe(2);
  expect(await page.evaluate(()=>window.playbackSent.length)).toBeLessThan(12);
  await page.screenshot({path:'/tmp/closer-youtube.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

  await page.evaluate(()=>window.youTubeTest.players.at(-1).error(150));
  await expect(page.locator('#embed-status')).toContainText('doesn’t allow');
  await expect(page.locator('#external-link')).toHaveAttribute('href','https://www.youtube.com/watch?v=M7lc1UVf-VE');
  await page.locator('#embed-retry').click(); await expect(page.locator('#play-button')).toBeEnabled();

  for(const ctx of [page.context(),context]) await ctx.route('https://example.com/date',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><h1>A shared place</h1>'}));
  await choose(page,'https://example.com/date','website');
  await expect(partner.locator('#website-frame')).toHaveAttribute('src','https://example.com/date');
  await expect(partner.frameLocator('#website-frame').getByRole('heading')).toHaveText('A shared place');
  await expect(page.locator('#website-frame')).toHaveAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-presentation');
  await expect(page.locator('#embed-status')).toContainText('Scrolling, clicks, and website videos stay separate');
  await expect(page.locator('#movie-controls')).toBeHidden();
  await expect(page.locator('#youtube-shell iframe')).toHaveCount(0);
  for(const ctx of [page.context(),context]) await ctx.route('https://example.com/blocked',route=>route.fulfill({contentType:'text/html',headers:{'X-Frame-Options':'DENY'},body:'Embedding blocked'}));
  const blockedRequests=Promise.all([page,partner].map(p=>p.waitForEvent('requestfailed',{predicate:request=>request.url()==='https://example.com/blocked',timeout:5000})));
  await choose(page,'https://example.com/blocked','website');
  await blockedRequests;
  await expect(page.locator('#external-link')).toBeVisible();
  await expect(page.locator('#external-link')).toHaveAttribute('href','https://example.com/blocked');
  await page.locator('#choose-video').click();await page.locator('#choose-demo').click();
  await expect(partner.locator('#website-frame')).toBeHidden();
  await expect(page.locator('#website-frame')).not.toHaveAttribute('src');
  await page.locator('#play-button').click();
  await expect.poll(()=>partner.locator('#movie').evaluate(video=>video.currentTime)).toBeGreaterThan(.5);
  expect(errors).toEqual([]);await context.close();
});

test('YouTube load failure leaves an actionable fallback and the demo usable',async({page})=>{
  await page.route('https://www.youtube.com/iframe_api',route=>route.abort());
  await page.route('https://www.youtube-nocookie.com/embed/**',route=>route.abort());
  await page.goto('/');await choose(page,'https://www.youtube.com/watch?v=M7lc1UVf-VE');
  await expect(page.locator('#embed-status')).toContainText('couldn’t load');
  await expect(page.locator('#embed-retry')).toBeVisible();
  await expect(page.locator('#external-link')).toBeVisible();
  await page.locator('#choose-video').click();await page.locator('#choose-demo').click();
  await page.locator('#play-button').click();
  await expect.poll(()=>page.locator('#movie').evaluate(video=>video.currentTime)).toBeGreaterThan(.5);
});
