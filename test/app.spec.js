import { test, expect } from '@playwright/test';

async function createRoom(page, name = 'Asha') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create our room', exact: true }).click();
  await page.getByLabel('What should we call you?').fill(name);
  await page.locator('#room-submit').click();
  await expect(page.locator('#invite-dialog')).toBeVisible();
  return page.locator('#invite-link').inputValue();
}

test('phone layout, room invitation, synchronized video, chat, calls, and capacity', async ({ page, browser }) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket; window.testSockets = [];
    window.WebSocket = class extends NativeWebSocket { constructor(...args) { super(...args); window.testSockets.push(this); } };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const invitation = await createRoom(page);
  await page.locator('#invite-dialog [data-close]').click();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.grantPermissions(['camera', 'microphone']);
  const partner = await context.newPage();
  partner.on('pageerror', error => errors.push(error.message));
  await partner.goto(invitation);
  await expect(partner.locator('#room-dialog')).toBeVisible();
  await partner.getByLabel('What should we call you?').fill('Alex');
  await partner.locator('#room-submit').click();
  await expect(page.locator('#people-count')).toHaveText('2 / 2');
  await expect(partner.locator('#people-count')).toHaveText('2 / 2');
  await expect(page.locator('#partner-label')).toHaveText('Alex');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/closer-phone.png', fullPage: true });

  await page.locator('#chat-input').fill('You + me, same sky ♡');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(partner.locator('.chat-message')).toContainText('You + me, same sky ♡');
  await partner.locator('#chat-input').fill('<b>Still just text</b>');
  await partner.locator('#chat-send').click();
  await expect(page.locator('.chat-message').last()).toContainText('<b>Still just text</b>');
  expect(await page.locator('.chat-message b').count()).toBe(0);
  await page.getByRole('button', { name: 'Send a heart', exact: true }).click();
  await expect(partner.locator('.floating-heart')).toHaveCount(1);

  await page.locator('#play-button').click();
  await expect.poll(() => page.locator('#movie').evaluate(video => video.currentTime)).toBeGreaterThan(.5);
  await expect.poll(() => partner.locator('#movie').evaluate(video => video.currentTime)).toBeGreaterThan(.5);
  await partner.locator('#play-button').click();
  await expect.poll(() => page.locator('#movie').evaluate(video => video.paused)).toBe(true);
  const times = await Promise.all([page, partner].map(p => p.locator('#movie').evaluate(video => video.currentTime)));
  expect(Math.abs(times[0] - times[1])).toBeLessThan(.8);
  await page.locator('#seek').fill('12'); await page.locator('#seek').dispatchEvent('change');
  await expect.poll(() => partner.locator('#movie').evaluate(video => video.currentTime)).toBeCloseTo(12, 0);

  await page.context().grantPermissions(['camera', 'microphone']);
  await page.getByRole('button', { name: 'Turn camera on', exact: true }).click();
  await partner.getByRole('button', { name: 'Turn camera on', exact: true }).click();
  await page.getByRole('button', { name: 'Turn microphone on', exact: true }).click();
  await partner.getByRole('button', { name: 'Turn microphone on', exact: true }).click();
  await expect.poll(() => partner.locator('#remote-video').evaluate(video => video.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.locator('#remote-video').evaluate(video => video.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#mini-call')).toBeVisible();
  await expect.poll(() => page.locator('#mini-remote').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#call-caption')).toHaveText('A little closer now');
  // Exercise screen-track replacement with synthetic media; the OS picker is
  // intentionally outside an unattended browser test.
  await page.evaluate(() => { navigator.mediaDevices.getDisplayMedia = () => navigator.mediaDevices.getUserMedia({ video: true }); });
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await expect(page.locator('#screen-button')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Turn camera off', exact: true }).click();
  await expect(page.locator('#local-avatar')).toBeHidden();
  await expect(partner.locator('#mini-call')).toBeVisible();
  await page.getByRole('button', { name: 'Stop sharing screen', exact: true }).click();
  await expect(page.locator('#local-avatar')).toBeVisible();
  await expect(partner.locator('#mini-call')).toBeHidden();

  await page.evaluate(() => window.testSockets[0].close());
  await expect(page.locator('#sync-status')).toContainText('Reconnecting');
  await expect(page.locator('#people-count')).toHaveText('2 / 2', { timeout: 12000 });
  await expect(partner.locator('#people-count')).toHaveText('2 / 2');
  await page.locator('#chat-input').fill('Back with you ♡'); await page.locator('#chat-send').click();
  await expect(partner.locator('.chat-message').last()).toContainText('Back with you ♡');

  const third = await browser.newPage(); await third.goto(invitation);
  await third.getByLabel('What should we call you?').fill('Third'); await third.locator('#room-submit').click();
  await expect(third.locator('#room-form-error')).toContainText('already has two people');
  await third.close();
  await partner.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(page.locator('#people-count')).toHaveText('1 / 2');
  await expect(partner.locator('#local-avatar')).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test('solo demo, accessible dialogs, invalid invitations, and desktop layout', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/');
  await page.screenshot({ path: '/tmp/closer-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'How it works' }).click();
  await expect(page.getByRole('heading', { name: 'Far apart. Right here.' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#how-dialog')).toBeHidden();
  await page.locator('#stage-play').click();
  await expect.poll(() => page.locator('#movie').evaluate(video => video.currentTime)).toBeGreaterThan(.5);
  await page.locator('#play-button').click();
  await page.locator('#choose-video').click();
  await page.locator('#video-url').fill('https://youtube.com/watch?v=test'); await page.locator('#video-form button[type=submit]').click();
  await expect(page.locator('#video-form-error')).toContainText('direct video file');
  await page.keyboard.press('Escape');
  await page.locator('#join-button').click(); await page.locator('#name-input').fill('Asha'); await page.locator('#room-code-input').fill('bad'); await page.locator('#room-submit').click();
  await expect(page.locator('#room-form-error')).toContainText('ten-character');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
