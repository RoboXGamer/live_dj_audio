import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, ignoreDefaultArgs: ['--mute-audio'], args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
try {
  const host = await browser.newContext({ ignoreHTTPSErrors: true });
  const phone = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'] });
  await host.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original { constructor(...args) { super(...args); window.__testPc = this; } };
  });
  await phone.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      oscillator.connect(destination); oscillator.start();
      window.__testAudio = { context, oscillator };
      return destination.stream;
    };
  });
  const a = await host.newPage(); const b = await phone.newPage();
  a.on('pageerror', e => console.error('HOST', e)); b.on('pageerror', e => console.error('PHONE', e));
  await a.goto('https://localhost:5173'); await a.getByRole('button', { name: 'Start a session' }).click();
  await a.waitForFunction(() => /room=[a-f0-9]{8}/.test(document.querySelector('a.link')?.getAttribute('href') || ''));
  const link = await a.locator('a.link').getAttribute('href'); assert.ok(link?.includes('room='));
  await b.goto(link.replace(/https:\/\/[^/]+/, 'https://localhost:5173'));
  await b.locator('input').fill('Audio test'); await b.getByRole('button', { name: 'Join with microphone' }).click();
  await a.getByRole('button', { name: 'Approve' }).click();
  await a.getByText('Track: live', { exact: false }).waitFor({ timeout: 15000 });
  await b.waitForFunction(() => Number(document.querySelector('meter')?.value) > 0, null, { timeout: 15000 });
  try { await a.waitForFunction(() => Number(document.querySelector('meter')?.value) > 0, null, { timeout: 15000 }); }
  catch (e) { console.log('receiver stats', await a.evaluate(async () => Array.from((await window.__testPc.getStats()).values()).filter(s => s.type === 'inbound-rtp'))); throw e; }
  console.log('PASS: generated audio reached the receiver and its input meter');
} finally { await browser.close(); }
